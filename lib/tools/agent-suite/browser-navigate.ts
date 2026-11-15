import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";
import { assertPublicHttpUrl } from "@/lib/security/url-safety";
import { markupToText } from "@/lib/content/html-text";

/**
 * Task 140 — Outil « browser.navigate » — Browser Anti-Bot Adaptive Navigator.
 *
 * Navigation adaptative face aux défenses anti-bot :
 *  - rotation de User-Agents réalistes (5 profils modernes, un par tentative) ;
 *  - backoff exponentiel sur 429/503 (en-tête Retry-After honoré, plafonné) ;
 *  - reprise sur 403 par simple changement d'agent ;
 *  - suivi manuel des redirections (max 3 sauts) avec REVALIDATION SSRF à
 *    CHAQUE saut (assertPublicHttpUrl) ;
 *  - détection HONNÊTE des pages de challenge (Cloudflare « Just a moment… »,
 *    captcha) sur le HTML brut : aucun contenu n'est JAMAIS inventé — si la
 *    page est un challenge, le texte retourné est vide et antiBotDetected est
 *    vrai.
 */

const BrowserNavigateInput = z.object({
  url: z.string().url(),
  maxCharacters: z.number().int().min(1000).max(50_000).default(20_000),
  maxRetries: z.number().int().min(0).max(4).default(3),
});

/** Profils User-Agent réalistes modernes (rotation : un par tentative). */
const UA_PROFILES: readonly string[] = [
  // Chrome 131 — Windows 11
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  // Firefox 133 — macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
  // Safari 18.1 — macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  // Edge 131 — Windows 11
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  // Chrome 131 — Android
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
];

/** Marqueurs de pages challenge / anti-bot (comparaison sur HTML brut minuscule). */
const CHALLENGE_MARKERS: readonly string[] = [
  "just a moment",
  "cf-browser-verification",
  "enable javascript and cookies",
  "attention required",
  "captcha",
  "are you a robot",
  "ddos protection by cloudflare",
  "checking your browser",
];

const CHALLENGE_SCAN_BYTES = 4_096;
const MAX_BODY_BYTES = 5_000_000;
const MAX_REDIRECT_HOPS = 3;
const MAX_BACKOFF_MS = 8_000;

export interface BrowserNavigateAttempt {
  attempt: number;
  status?: number;
  error?: string;
  strategy: string;
}

export interface BrowserNavigateResult {
  url: string;
  status: number;
  text: string;
  antiBotDetected: boolean;
  blocked: boolean;
  reason?: string;
  attempts: BrowserNavigateAttempt[];
  finalStrategy: string;
}

function buildHeaders(userAgent: string): Record<string, string> {
  return {
    "User-Agent": userAgent,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  };
}

/** Retry-After en secondes (entier) s'il est exploitable, sinon null. Plafonné à 8 s. */
function parseRetryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds, MAX_BACKOFF_MS / 1_000);
}

function detectChallenge(rawHtml: string): boolean {
  const head = rawHtml.slice(0, CHALLENGE_SCAN_BYTES).toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => head.includes(marker));
}

export const browserNavigateTool: ToolDefinition<z.infer<typeof BrowserNavigateInput>, BrowserNavigateResult> = {
  id: "browser.navigate",
  name: "Browser Anti-Bot Adaptive Navigator",
  description:
    "Navigue vers une page publique avec rotation de User-Agents réalistes, backoff sur les limites de débit et reprise adaptative sur les refus, puis détecte honnêtement les pages challenge anti-bot (aucun contenu inventé).",
  category: "browser",
  risk: "low",
  inputSchema: BrowserNavigateInput,
  async execute(input, context) {
    const signal = context.signal ?? AbortSignal.timeout(15_000);
    const attempts: BrowserNavigateAttempt[] = [];
    let currentUrl = input.url;
    // Stratégie qui a PRODUIT la tentative courante (initial / rate_limit_backoff / ua_rotation).
    let originStrategy = "initial";

    for (let attempt = 0; attempt <= input.maxRetries; attempt += 1) {
      let strategy = originStrategy;
      let response: Response;
      try {
        // Garde SSRF : chaque hop (y compris redirections) est revalidé.
        let validated = await assertPublicHttpUrl(currentUrl);
        response = await fetch(validated, {
          redirect: "manual",
          headers: buildHeaders(UA_PROFILES[attempt % UA_PROFILES.length]),
          signal,
        });

        // Suivi manuel des redirections (max 3 sauts, résolution relative + revalidation).
        let redirectHops = 0;
        while (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) throw new Error("La page a renvoyé une redirection sans destination.");
          if (redirectHops >= MAX_REDIRECT_HOPS) {
            throw new Error(`Trop de redirections successives (maximum ${MAX_REDIRECT_HOPS}).`);
          }
          validated = await assertPublicHttpUrl(new URL(location, currentUrl).toString());
          currentUrl = validated.toString();
          response = await fetch(validated, {
            redirect: "manual",
            headers: buildHeaders(UA_PROFILES[attempt % UA_PROFILES.length]),
            signal,
          });
          redirectHops += 1;
          strategy = "redirect_follow";
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({ attempt, error: message, strategy });
        throw new Error(`Échec de la navigation vers ${currentUrl} : ${message}`);
      }

      attempts.push({ attempt, status: response.status, strategy });

      if (response.ok) {
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
          throw new Error("Type de contenu non supporté : " + (contentType || "inconnu"));
        }
        const contentLength = Number(response.headers.get("content-length") ?? "0");
        if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
          throw new Error("La page dépasse la limite de 5 Mo.");
        }
        const html = await response.text();
        if (Buffer.byteLength(html, "utf8") > MAX_BODY_BYTES) {
          throw new Error("La page dépasse la limite de 5 Mo.");
        }
        // Détection honnête de challenge sur le HTML BRUT : aucun contenu inventé.
        if (detectChallenge(html)) {
          return {
            url: currentUrl,
            status: response.status,
            text: "",
            antiBotDetected: true,
            blocked: false,
            attempts,
            finalStrategy: "challenge_detected",
          };
        }
        return {
          url: currentUrl,
          status: response.status,
          text: markupToText(html).slice(0, input.maxCharacters),
          antiBotDetected: false,
          blocked: false,
          attempts,
          finalStrategy: "success",
        };
      }

      if (response.status === 429 || response.status === 503) {
        if (attempt < input.maxRetries) {
          const backoffMs =
            (parseRetryAfterSeconds(response.headers.get("retry-after")) ?? Math.pow(1.5, attempt)) * 1_000;
          await new Promise((resolve) => setTimeout(resolve, Math.min(Math.round(backoffMs), MAX_BACKOFF_MS)));
          originStrategy = "rate_limit_backoff";
          continue;
        }
        return {
          url: currentUrl,
          status: response.status,
          text: "",
          antiBotDetected: false,
          blocked: true,
          reason: `limite de débit du site atteinte (${response.status}) malgré le backoff et la rotation d'agents`,
          attempts,
          finalStrategy: "rate_limited",
        };
      }

      if (response.status === 403) {
        if (attempt < input.maxRetries) {
          originStrategy = "ua_rotation";
          continue;
        }
        return {
          url: currentUrl,
          status: response.status,
          text: "",
          antiBotDetected: false,
          blocked: true,
          reason: "accès refusé (403) malgré la rotation d'agents",
          attempts,
          finalStrategy: "blocked_403",
        };
      }

      if (response.status === 401 || response.status === 402 || response.status === 407) {
        return {
          url: currentUrl,
          status: response.status,
          text: "",
          antiBotDetected: false,
          blocked: true,
          reason: "authentification/paiement requise",
          attempts,
          finalStrategy: "auth_required",
        };
      }

      throw new Error(`La page a répondu avec le statut HTTP ${response.status}.`);
    }

    // Inatteignable : la boucle retourne ou lève à chaque itération.
    throw new Error("Navigation terminée sans résultat — état interne incohérent.");
  },
};
