import "server-only";

import { FieldValue } from "@/lib/r2fs";
import { writeCheckpointSet } from "@/lib/db/firestore-resilient";

/**
 * genAPI — COMPTEURS D'EXÉCUTION DU JOUR.
 *
 * Chaque exécution gRPC (réussie ou échouée) incrémente les compteurs du
 * jour dans `genapiStats/{dateIso}` : executions, echecs,
 * creditsDebitesMinor (unités mineures). Le document est daté (clé UTC) :
 * le journal admin lit « les compteurs DU JOUR » sans fenêtre glissante.
 *
 * Écriture best-effort : un incident Firestore ne doit JAMAIS faire échouer
 * une exécution déjà rendue au client (la télémétrie suit, ne gouverne pas).
 */

/** Clé ISO UTC du jour (YYYY-MM-DD) — fonction PURE exportée et testée. */
export function cleDateJour(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Incrémente les compteurs du jour pour une exécution genAPI. */
export async function compterExecutionGenAPI(params: {
  succes: boolean;
  creditsMinor: number;
}): Promise<void> {
  const dateIso = cleDateJour();
  const credits = Number.isFinite(params.creditsMinor)
    ? Math.max(0, Math.floor(params.creditsMinor))
    : 0;
  try {
    await writeCheckpointSet(
      "genapiStats",
      dateIso,
      {
        date: dateIso,
        executions: FieldValue.increment(1),
        echecs: FieldValue.increment(params.succes ? 0 : 1),
        creditsDebitesMinor: FieldValue.increment(credits),
      },
    );
  } catch {
    // Best-effort : les compteurs ne perturbent JAMAIS le chemin métier.
  }
}
