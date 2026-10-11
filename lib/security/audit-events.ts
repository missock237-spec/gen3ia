import "server-only";

import { randomUUID } from "node:crypto";

import { adminDb } from "@/lib/firebase/admin";
import { runFirestoreGuarded } from "@/lib/queue/firestore-guard";
import { FieldValue } from "@/lib/r2fs";
import { redactSensitiveContent } from "./guardrails";

/**
 * JOURNAL D'AUDIT DES ACTIONS CRITIQUES (Task 126) — collection `auditEvents`.
 *
 * Distinct de `securityAuditEvents` (exécutions d'outils d'agents) : ce
 * journal couvre les actions ADMINISTRATIVES destructrices et les opérations
 * de conformité (export RGPD). Chaque entrée répond à QUI / QUOI / SUR QUOI /
 * RÉSULTAT, avec charge utile redactée et tronquée (jamais de secret en clair).
 *
 * Écriture bornée par runFirestoreGuarded (6 s + disjoncteur — doctrine Task
 * 110-e) : une panne du journal ne fait JAMAIS pendre l'action auditée ; les
 * appelants l'attendent mais avalent l'erreur éventuelle (best-effort pour ne
 * pas bloquer une opération déjà effectuée).
 */

const COLLECTION = "auditEvents";
const MAX_JSON_CHARS = 20_000;

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(redactSensitiveContent(value));
    return text.length > MAX_JSON_CHARS ? `${text.slice(0, MAX_JSON_CHARS)}...[truncated]` : text;
  } catch {
    return "[unserializable]";
  }
}

export interface AuditEventParams {
  /** Identifiant de l'acteur (uid admin ou uid utilisateur pour le self-service). */
  actorId: string;
  actorEmail?: string | null;
  /** Action au format domaine_verbe : "admin.payout_decision", "privacy.export_data"… */
  action: string;
  /** Résultat de l'action. */
  outcome: "granted" | "denied" | "completed" | "failed";
  /** Nature de la cible : "user", "payout", "billing", "collection"… */
  targetType?: string;
  targetId?: string;
  /** Métadonnées additionnelles (redactées, jamais de secret en clair). */
  metadata?: Record<string, unknown>;
}

/** Écrit un événement d'audit et retourne son identifiant. */
export async function recordAuditEvent(params: AuditEventParams): Promise<string> {
  if (!params.actorId.trim() || !params.action.trim()) {
    throw new Error("Audit event requires actorId and action.");
  }
  const id = randomUUID();
  await runFirestoreGuarded(`audit-event ${params.action} ${id}`, () =>
    adminDb.collection(COLLECTION).doc(id).create({
      id,
      actorId: params.actorId,
      actorEmail: params.actorEmail ? String(params.actorEmail).slice(0, 200) : null,
      action: params.action,
      outcome: params.outcome,
      targetType: params.targetType ?? null,
      targetId: params.targetId ? String(params.targetId).slice(0, 200) : null,
      metadata: params.metadata ? safeJson(params.metadata) : null,
      createdAt: FieldValue.serverTimestamp(),
    }),
  );
  return id;
}

/** Variante best-effort : journalise sans jamais faire échouer l'appelant. */
export function recordAuditEventSafe(params: AuditEventParams): void {
  void recordAuditEvent(params).catch(() => undefined);
}
