import "server-only";

import type { NextRequest } from "next/server";

import { listJson, newUlid, userDir, userKey, writeJson } from "@/lib/storage/user-data-store";

/* ------------------------------------------------------------------ */
/* Journal d'audit du Training Studio (v1.1)                            */
/*                                                                    */
/* Traçabilité des actions sensibles : création/suppression de projet,  */
/* import de datasets (téléversement ET hub), import de modèle,         */
/* analyse, acceptation de plan, annulation de tâche, exports.          */
/*                                                                    */
/* Stockage : R2, préfixe mensuel `users/{uid}/training-audit/{aaaa-mm}/` */
/* (documents minuscules, purge naturelle par mois, plafond 200/mois).  */
/* Les détails sont SANITISÉS : aucune donnée de contenu, aucun secret, */
/* aucun token — uniquement des identifiants, tailles et compteurs.     */
/* L'écriture est « fire-and-forget » : une panne d'audit ne bloque     */
/* JAMAIS l'action utilisateur (l'appelant utilise void + catch).       */
/* ------------------------------------------------------------------ */

export const TRAINING_AUDIT_ACTIONS = [
  "project.created",
  "project.updated",
  "project.archived",
  "project.deleted",
  "model.imported",
  "model.deleted",
  "dataset.uploaded",
  "dataset.imported",
  "dataset.deleted",
  "analysis.generated",
  "plan.updated",
  "plan.accepted",
  "job.created",
  "job.cancelled",
  "export.prepared",
  "export.downloaded",
  "neural.evolution.consolidated",
  "arene.session",
] as const;
export type TrainingAuditAction = (typeof TRAINING_AUDIT_ACTIONS)[number];

export interface TrainingAuditEntry {
  v: 1;
  id: string;
  at: string;
  userId: string;
  action: TrainingAuditAction;
  entityType: "project" | "model" | "dataset" | "plan" | "job" | "export" | "neural" | "arene";
  entityId: string;
  projectId?: string;
  ip?: string;
  details: Record<string, unknown>;
}

/** Extrait l'IP client (premier saut de x-forwarded-for, sinon inconnue). */
export function ipFromRequest(request: NextRequest): string | undefined {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first && first.length > 0 && first.length <= 64 ? first : undefined;
}

/** Plafonne les détails à ~2 Ko de JSON — identifiants et compteurs uniquement. */
function sanitizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!details || typeof details !== "object") return {};
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details).slice(0, 20)) {
    const safeKey = key.slice(0, 60);
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      clean[safeKey] = value;
    } else if (typeof value === "string") {
      clean[safeKey] = value.slice(0, 200);
    } else {
      try {
        clean[safeKey] = JSON.stringify(value)?.slice(0, 200) ?? null;
      } catch {
        clean[safeKey] = null;
      }
    }
  }
  try {
    const serialized = JSON.stringify(clean);
    if (serialized && serialized.length > 2048) {
      return { tronque: true, apercu: serialized.slice(0, 512) };
    }
  } catch {
    return {};
  }
  return clean;
}

function monthPrefix(date = new Date()): string {
  return date.toISOString().slice(0, 7); // "aaaa-mm"
}

function previousMonthPrefix(date = new Date()): string {
  const previous = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  return monthPrefix(previous);
}

/** Enregistre une entrée d'audit (fire-and-forget côté appelant). */
export async function recordTrainingAudit(input: {
  uid: string;
  action: TrainingAuditAction;
  entityType: TrainingAuditEntry["entityType"];
  entityId: string;
  projectId?: string;
  ip?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  const entry: TrainingAuditEntry = {
    v: 1,
    id: newUlid(),
    at: new Date().toISOString(),
    userId: input.uid,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId.slice(0, 128),
    ...(input.projectId ? { projectId: input.projectId.slice(0, 128) } : {}),
    ...(input.ip ? { ip: input.ip } : {}),
    details: sanitizeDetails(input.details),
  };
  await writeJson(userKey(input.uid, "training-audit", monthPrefix(), entry.id), entry, { maxBytes: 8 * 1024 });
}

/**
 * Liste les entrées d'audit les plus récentes (mois courant + précédent).
 * Filtre optionnel par projet. Ordonné chronologiquement inverse.
 */
export async function listTrainingAudit(
  uid: string,
  opts?: { limit?: number; projectId?: string },
): Promise<TrainingAuditEntry[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const months = [monthPrefix(), previousMonthPrefix()];
  const entries = (
    await Promise.all(
      months.map((month) =>
        listJson<TrainingAuditEntry>(userDir(uid, "training-audit", month), { limit: 200, maxBytesPerDoc: 8 * 1024 }),
      ),
    )
  ).flat();
  return entries
    .filter((entry) => !opts?.projectId || entry.projectId === opts.projectId)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, limit);
}
