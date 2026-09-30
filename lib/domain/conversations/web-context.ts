import { randomUUID } from "node:crypto";

import { executeTool } from "@/lib/tools/executor";
import type { ExecutionPolicy } from "@/lib/security/execution-policy";

/**
 * Contexte web des liens fournis par l'utilisateur (étape 13 du plan 20).
 *
 * Défaut historique : un lien collé dans la conversation (« résume cet
 * article : https://… ») n'était JAMAIS récupéré — le modèle répondait sans
 * la page, voire en inventait le contenu. Désormais :
 *  1. EXTRACTION pure des URLs du message (dédup, ponctuation exclue) ;
 *  2. GARDE : pas de double récupération quand l'URL est déjà routée vers
 *     l'appel d'API direct (web.api — chemin existant) ;
 *  3. RÉCUPÉRATION RÉELLE via le pipeline d'outils sécurisé (web.open :
 *     garde SSRF assertPublicHttpUrl, quotas, audit) — jamais un fetch nu ;
 *  4. BLOC DE CONTEXTE honnête : contenu réel extrait, ou raison d'échec
 *     explicite — le modèle ne peut pas inventer ce qu'il n'a pas lu.
 */

/** URLs récupérées au maximum par tour (budget de contexte/latence). */
export const WEB_CONTEXT_MAX_URLS = 2;
/** Caractères extraits au maximum par page (web.open tronque déjà). */
export const WEB_CONTEXT_MAX_CHARS = 20_000;

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/**
 * Extrait les URLs http(s) d'un message : dédupliquées, ponctuation finale
 * retirée (parenthèse, point, virgule, guillemet…), plafonnées.
 */
export function extractUserUrls(message: string): string[] {
  const matches = message.match(URL_RE) ?? [];
  const cleaned: string[] = [];
  for (const match of matches) {
    const url = match.replace(/[.,;:!?)\]}'"]+$/u, "");
    if (url.length < 12) continue; // trop court pour être un vrai lien
    if (!cleaned.includes(url)) cleaned.push(url);
    if (cleaned.length >= WEB_CONTEXT_MAX_URLS) break;
  }
  return cleaned;
}

/**
 * Le tour chat doit-il récupérer le contenu des liens du message ?
 *  - au moins une URL extraite ;
 *  - l'URL n'est pas celle déjà routée vers l'appel d'API direct (web.api).
 */
export function shouldFetchUrlContext(message: string, skipUrls: readonly string[] = []): boolean {
  const urls = extractUserUrls(message);
  if (urls.length === 0) return false;
  return urls.some((url) => !skipUrls.includes(url));
}

/** Entrée de contexte par page récupérée. */
export interface WebPageContext {
  url: string;
  ok: boolean;
  /** Texte extrait (ok) ou raison de l'échec (!ok). */
  content: string;
}

/**
 * Récupère réellement les pages liées (via l'outil sécurisé web.open) et
 * formate le bloc de contexte. Les échecs individuels ne bloquent pas les
 * autres pages ; si AUCUNE page n'est récupérable, le bloc porte les
 * raisons — le modèle sait que le contenu est indisponible, il n'improvise pas.
 */
export async function loadWebPageContext(
  message: string,
  options: {
    userId: string;
    policy?: ExecutionPolicy;
    projectId?: string;
    /** URLs déjà prises en charge par un autre chemin (web.api direct). */
    skipUrls?: readonly string[];
    signal?: AbortSignal;
  },
): Promise<string> {
  const urls = extractUserUrls(message)
    .filter((url) => !(options.skipUrls ?? []).includes(url))
    .slice(0, WEB_CONTEXT_MAX_URLS);
  if (urls.length === 0) return "";

  const pages: WebPageContext[] = [];
  for (const url of urls) {
    try {
      const result = await executeTool({
        userId: options.userId,
        executionId: randomUUID(),
        projectId: options.projectId,
        toolName: "web.open",
        input: { url, maxCharacters: WEB_CONTEXT_MAX_CHARS },
        signal: options.signal,
        ...(options.policy ? { policy: options.policy } : {}),
      });
      if (!result.success) {
        pages.push({ url, ok: false, content: result.error ?? "récupération impossible" });
        continue;
      }
      const output = result.output as { url?: string; text?: string } | undefined;
      const text = typeof output?.text === "string" ? output.text.trim() : "";
      pages.push({ url, ok: text.length > 0, content: text || "page vide (aucun texte extractible)" });
    } catch (error) {
      pages.push({ url, ok: false, content: error instanceof Error ? error.message : "récupération impossible" });
    }
  }

  return pages
    .map((page) => `--- ${page.url} ${page.ok ? "(contenu récupéré)" : `(récupération impossible : ${page.content})`}\n${page.content.slice(0, WEB_CONTEXT_MAX_CHARS)}`)
    .join("\n\n");
}
