import { FieldValue } from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import { runFirestoreGuarded } from "@/lib/queue/firestore-guard";
import { redactSensitiveContent } from "@/lib/security/guardrails";

/**
 * Piste d'audit sécurité (collection `securityAuditEvents`).
 *
 * GARDE QUOTA (Task 110-e) : l'écriture d'audit « authorized »/« started »
 * est AWAITÉE par executeToolSecurely AVANT chaque étape outil de mission
 * (lib/agents/runtime/secure-tool-executor). Sur Firestore brut, sous quota
 * quotidien épuisé l'écriture pendaît SANS lever (Task 97) : chaque étape
 * outil de mission pendait jusqu'à son timeout (120 s par défaut) puis
 * échouait — « plus aucune tâche ne s'exécute ». runFirestoreGuarded borne
 * chaque écriture à 6 s avec disjoncteur (les sites déjà non bloquants via
 * .catch(() => undefined) le restent ; les sites bloquants échouent vite et
 * quota-classifié au lieu de pendre).
 */

const COLLECTION = "securityAuditEvents";
const MAX_JSON_CHARS = 50_000;

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(redactSensitiveContent(value));
    return text.length > MAX_JSON_CHARS ? `${text.slice(0, MAX_JSON_CHARS)}...[truncated]` : text;
  } catch {
    return "[unserializable]";
  }
}

export async function appendSecurityAuditEvent(params: {
  userId: string;
  executionId: string;
  toolName: string;
  event: "authorized" | "started" | "completed" | "failed" | "blocked" | "stopped" | "billing_failed" | "ads_spend_reserved" | "ads_spend_committed";
  risk?: string;
  approvalId?: string;
  input?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  metadata?: Record<string, string>;
}): Promise<string> {
  if (!params.userId.trim() || !params.executionId.trim() || !params.toolName.trim()) throw new Error("Audit event requires userId, executionId and toolName.");
  const id = randomUUID();
  await runFirestoreGuarded(`security-audit ${params.event} ${id}`, () => adminDb.collection(COLLECTION).doc(id).create({
    eventId: id,
    userId: params.userId,
    executionId: params.executionId,
    toolName: params.toolName,
    event: params.event,
    risk: params.risk ?? null,
    approvalId: params.approvalId ?? null,
    input: params.input ? safeJson(params.input) : null,
    result: params.result === undefined ? null : safeJson(params.result),
    error: params.error ? String(redactSensitiveContent(params.error)).slice(0, 4_000) : null,
    metadata: params.metadata ?? {},
    createdAt: FieldValue.serverTimestamp(),
  }));
  return id;
}
