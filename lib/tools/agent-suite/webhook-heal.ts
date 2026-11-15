import { z } from "zod";

import { adminDb } from "@/lib/firebase/admin";
import { decryptSecret } from "@/lib/security/secret-envelope";
import { assertPublicHttpUrl } from "@/lib/security/url-safety";
import type { ToolDefinition } from "@/lib/tools/types";
import { listOutgoingWebhooks } from "@/lib/integrations/webhooks/store";
import { signWebhookPayload } from "@/lib/integrations/webhooks/emit";
import { generateStructuredForUser } from "./llm-json";

/**
 * Task 140 — Tool « webhook.heal » (Self-Healing Webhook Gateway).
 *
 * Intercepte une livraison webhook ÉCHOUÉE, diagnostique la cause (timeout,
 * 401, 429, 5xx, payload trop lourd, incompatibilité de schéma), ADAPTE la
 * charge utile et RE-SOUMET UNE SEULE FOIS — avec signature HMAC correcte
 * quand l'URL correspond à un endpoint sortant déclaré par l'utilisateur.
 *
 * Garde-fous :
 *  - protection SSRF AVANT toute manipulation (assertPublicHttpUrl) ;
 *  - un seul rejeu — jamais de boucle de relance ;
 *  - adaptateur de schéma IA en FAIL-SOFT : son échec ne bloque jamais le
 *    rejeu (la charge d'origine est conservée, avec note explicite) ;
 *  - la signature est calculée sur le corps FINAL (après toute adaptation) ;
 *  - en-têtes de transport (content-length, connection…) retirés du rejeu.
 */

/* ────────────────────────────────────────────────────────────────────────
 * Constantes
 * ──────────────────────────────────────────────────────────────────────── */

/** Au-delà, la charge est considérée trop lourde pour une livraison directe. */
const MAX_PAYLOAD_BYTES = 256 * 1024;
/** Délai d'attente maximal avant rejeu après une limite de débit (HTTP Retry-After borné). */
const MAX_RATE_LIMIT_WAIT_MS = 5_000;
/** Délai d'attente par défaut quand aucun Retry-After n'est exploitable. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 5_000;
/** Plafond du JSON de charge envoyé à l'adaptateur IA. */
const ADAPT_INPUT_CAP = 12_000;
/** Plafond de l'aperçu livré en cas de charge tronquée. */
const PREVIEW_CAP = 1_024;
/** Timeout du rejeu. */
const RETRY_TIMEOUT_MS = 12_000;

const RETRY_SLEEP_MIN_MS = 0;

/** En-têtes de transport jamais rejoués tels quels (corrompraient le rejeu). */
const DROPPED_HEADER_NAMES = new Set([
  "connection",
  "content-length",
  "transfer-encoding",
  "host",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
]);

/* ────────────────────────────────────────────────────────────────────────
 * Entrée / sortie
 * ──────────────────────────────────────────────────────────────────────── */

const WebhookHealInput = z.object({
  endpointUrl: z.string().url(),
  payload: z.record(z.string(), z.unknown()),
  lastError: z.string().max(2_000).optional(),
  lastStatus: z.number().int().min(100).max(599).optional(),
  headers: z.record(z.string(), z.string().max(500)).optional(),
});

export type WebhookDiagnosisType =
  | "auth"
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "payload_size"
  | "schema_mismatch"
  | "network"
  | "unknown";

export interface WebhookHealRetry {
  attempted: boolean;
  status?: number;
  ok?: boolean;
  latencyMs?: number;
  error?: string;
}

export interface WebhookHealResult {
  diagnosis: { type: WebhookDiagnosisType; strategy: string };
  /** Adaptations appliquées avant le rejeu (français, lisibles). */
  adaptations: string[];
  retry: WebhookHealRetry;
  recommendation: string;
}

/* ────────────────────────────────────────────────────────────────────────
 * Diagnostic déterministe (ordre de priorité fixe)
 * ──────────────────────────────────────────────────────────────────────── */

const DIAGNOSIS_STRATEGIES: Record<WebhookDiagnosisType, string> = {
  auth: "Rétablir l'authentification en signant le corps en HMAC-SHA256 avec le secret de l'endpoint déclaré chez Gen3ia.",
  rate_limited: "Respecter la limite de débit du destinataire : attendre le délai indiqué (plafonné) avant de rejouer.",
  server_error: "Erreur côté destinataire : rejeu unique après normalisation des en-têtes.",
  timeout: "Le destinataire n'a pas répondu à temps : rejeu unique avec un délai maîtrisé.",
  payload_size: "Charge trop volumineuse : livrer un aperçu tronqué et transmettre le détail complet hors bande.",
  schema_mismatch: "Schéma incompatible : adapter la charge au format attendu par le destinataire.",
  network: "Problème réseau, DNS ou TLS : vérifier la disponibilité de l'URL avant rejeu.",
  unknown: "Cause indéterminée : rejeu unique avec en-têtes normalisés.",
};

const DIAGNOSIS_RECOMMENDATIONS: Record<WebhookDiagnosisType, string> = {
  auth: "Déclarez cet endpoint dans Gen3ia (webhooks sortants) pour que la signature HMAC soit appliquée automatiquement, puis retestez.",
  rate_limited: "Si l'échec persiste, espacez les livraisons ou demandez au destinataire d'activer une file d'attente.",
  server_error: "Surveillez les prochaines livraisons ; contactez le destinataire si l'erreur 5xx se répète.",
  timeout: "Demandez au destinataire de traiter la réception de façon asynchrone (accusé immédiat puis traitement différé).",
  payload_size: "Transmettez la charge complète par une voie hors bande (téléversement signé) — seul un aperçu a été rejoué.",
  schema_mismatch: "Alignez le schéma : documentez les champs attendus par le destinataire et mettez à jour l'émetteur.",
  network: "Vérifiez l'URL, la résolution DNS et le certificat TLS du destinataire avant de relancer.",
  unknown: "Consultez les journaux du destinataire, puis retestez la livraison depuis la console Gen3ia.",
};

const SCHEMA_ERROR_RE = /field|required|schema|expected/;
const NETWORK_ERROR_RE = /enotfound|econnrefused|econnreset|ssl|cert/;
/** « Retry-After: 120 » ou « retry after 2 seconds » (valeurs en secondes). */
const RETRY_AFTER_RE = /retry[- ]?after[^0-9]{0,24}(\d{1,6})/i;

function classifyDiagnosis(params: {
  payloadBytes: number;
  lastError?: string;
  lastStatus?: number;
}): WebhookDiagnosisType {
  const error = (params.lastError ?? "").toLowerCase();
  const status = params.lastStatus;

  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status !== undefined && status >= 500) return "server_error";
  if (status === 408 || status === -1 || error.includes("timeout")) return "timeout";
  if (params.payloadBytes > MAX_PAYLOAD_BYTES) return "payload_size";
  if (SCHEMA_ERROR_RE.test(error) || status === 400 || status === 422) return "schema_mismatch";
  if (NETWORK_ERROR_RE.test(error)) return "network";
  return "unknown";
}

/** Extrait un délai Retry-After (secondes) du message d'erreur, en millisecondes. */
function parseRetryAfterMs(lastError: string | undefined): number | null {
  if (!lastError) return null;
  const match = RETRY_AFTER_RE.exec(lastError);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ────────────────────────────────────────────────────────────────────────
 * Adaptateur de schéma (IA, fail-soft)
 * ──────────────────────────────────────────────────────────────────────── */

const AdaptedPayloadSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  explanation: z.string().max(500),
});

const ADAPT_SYSTEM_PROMPT = [
  "Tu es un adaptateur de webhooks.",
  "Un destinataire a rejeté une charge utile pour incompatibilité de schéma (renommage, champ requis, structure attendue différente).",
  "Réécris la charge en un JSON conforme à ce qu'attend le destinataire d'après son message d'erreur : renomme, restructure, retire ou ajoute les champs nécessaires, sans perdre de donnée métier.",
  'Réponds UNIQUEMENT avec le JSON { "payload": { … }, "explanation": "…" } (explication en français, 500 caractères max).',
].join("\n");

/* ────────────────────────────────────────────────────────────────────────
 * Secret de l'endpoint déclaré
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Le listing public (listOutgoingWebhooks) ne retourne pas le secret HMAC ;
 * quand l'endpoint est déclaré, le secret est relu dans le document brut
 * (même style d'accès adminDb que lib/integrations/webhooks/store.ts) puis
 * déchiffré. Toute défaillance de lecture reste non bloquante.
 */
async function readDeclaredSecret(endpointId: string): Promise<string | undefined> {
  try {
    const snapshot = await adminDb.collection("outgoingWebhooks").doc(endpointId).get();
    if (!snapshot.exists) return undefined;
    const stored = snapshot.data() as { secret?: string } | undefined;
    const encrypted = typeof stored?.secret === "string" ? stored.secret : undefined;
    return encrypted ? decryptSecret(encrypted) : undefined;
  } catch {
    return undefined;
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Tool
 * ──────────────────────────────────────────────────────────────────────── */

export const webhookHealTool: ToolDefinition<z.infer<typeof WebhookHealInput>, WebhookHealResult> = {
  id: "webhook.heal",
  name: "Self-Healing Webhook Gateway",
  description:
    "Diagnose a failed webhook delivery (timeout, 401/403, 429, 5xx, oversized payload, schema mismatch), adapt the payload and resubmit it once with the correct HMAC signature when the URL matches a declared outgoing endpoint.",
  category: "http",
  risk: "high",
  inputSchema: WebhookHealInput,
  async execute(input, context) {
    // 0. Protection SSRF AVANT toute manipulation ou rejeu.
    let target: URL;
    try {
      target = await assertPublicHttpUrl(input.endpointUrl);
    } catch (error) {
      throw new Error(
        `URL de webhook refusée (protection SSRF) : ${error instanceof Error ? error.message : "invalide"}`,
      );
    }

    // 1. Diagnostic déterministe.
    const originalBody = JSON.stringify(input.payload);
    const originalSizeBytes = Buffer.byteLength(originalBody, "utf8");
    const type = classifyDiagnosis({
      payloadBytes: originalSizeBytes,
      lastError: input.lastError,
      lastStatus: input.lastStatus,
    });

    const adaptations: string[] = [];

    // 2a. En-têtes : minuscules, transport retiré, content-type imposé.
    const headers: Record<string, string> = {};
    const dropped: string[] = [];
    for (const [rawName, value] of Object.entries(input.headers ?? {})) {
      const name = rawName.toLowerCase();
      if (DROPPED_HEADER_NAMES.has(name)) {
        dropped.push(name);
        continue;
      }
      headers[name] = value;
    }
    headers["content-type"] = "application/json";
    adaptations.push("Type de contenu imposé pour le rejeu : application/json.");
    if (dropped.length > 0) {
      adaptations.push(`En-têtes de transport retirés du rejeu : ${dropped.join(", ")}.`);
    }

    // 2b. Adaptation de la charge selon le diagnostic.
    let payload: Record<string, unknown> = input.payload;

    if (type === "payload_size") {
      payload = {
        deliveredAt: new Date().toISOString(),
        truncated: true,
        originalSizeBytes,
        preview: originalBody.slice(0, PREVIEW_CAP),
      };
      adaptations.push(
        `Charge tronquée en aperçu (${PREVIEW_CAP} caractères) — livrez les données complètes par une voie hors bande.`,
      );
    }

    if (type === "schema_mismatch") {
      try {
        const adapted = await generateStructuredForUser({
          userId: context.userId,
          executionId: context.executionId,
          task: "automation",
          system: ADAPT_SYSTEM_PROMPT,
          user: [
            "Charge utile actuelle (JSON) :",
            originalBody.slice(0, ADAPT_INPUT_CAP),
            "",
            "Erreur signalée par le destinataire :",
            input.lastError ?? "(aucun message fourni)",
          ].join("\n"),
          schema: AdaptedPayloadSchema,
          maxTokens: 1_200,
        });
        payload = adapted.payload;
        adaptations.push(`Charge adaptée au schéma attendu (IA) : ${adapted.explanation}`);
      } catch (error) {
        adaptations.push(
          `Adaptation IA du schéma impossible (${error instanceof Error ? error.message.slice(0, 160) : "erreur inconnue"}) — charge d'origine conservée pour le rejeu.`,
        );
      }
    }

    if (type === "rate_limited") {
      const retryAfterMs = parseRetryAfterMs(input.lastError);
      const waitMs = Math.max(RETRY_SLEEP_MIN_MS, Math.min(retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS, MAX_RATE_LIMIT_WAIT_MS));
      adaptations.push(`Attente de ${waitMs} ms avant le rejeu (limite de débit respectée).`);
      await sleep(waitMs);
    }

    // 2c. Signature HMAC sur le corps FINAL (après toutes les adaptations).
    if (type === "auth") {
      const finalBody = JSON.stringify(payload);
      const declared = (await listOutgoingWebhooks(context.userId)).find(
        (endpoint) => endpoint.url === input.endpointUrl,
      );
      if (!declared) {
        adaptations.push(
          "Signature indisponible (endpoint non déclaré) — vérifiez le secret côté destinataire.",
        );
      } else {
        const secret = declared.secret ?? (await readDeclaredSecret(declared.id));
        if (!secret) {
          adaptations.push(
            "Endpoint déclaré mais secret HMAC illisible — vérifiez le secret partagé côté destinataire.",
          );
        } else {
          headers["x-gen3ia-signature"] = signWebhookPayload(secret, finalBody);
          adaptations.push("Corps resigné en HMAC-SHA256 (en-tête x-gen3ia-signature).");
        }
      }
    }

    // 3. Rejeu UNIQUE (une seule tentative, timeout 12 s).
    const startedAt = Date.now();
    let retry: WebhookHealRetry;
    try {
      const response = await fetch(target.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(RETRY_TIMEOUT_MS),
      });
      retry = {
        attempted: true,
        status: response.status,
        ok: response.ok,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      retry = {
        attempted: true,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message.slice(0, 200) : "échec du rejeu",
      };
    }

    return {
      diagnosis: { type, strategy: DIAGNOSIS_STRATEGIES[type] },
      adaptations,
      retry,
      recommendation: DIAGNOSIS_RECOMMENDATIONS[type],
    };
  },
};
