import "server-only";

import { listKeys } from "@/lib/storage/user-data-store";

import { sweepUserJobs } from "./orchestrator";

/* ------------------------------------------------------------------ */
/* Balayage global des tâches d'entraînement (cron)                     */
/*                                                                    */
/* Le sweep opportuniste (routes de listing, spec §7-D) ne progresse   */
/* que quand l'utilisateur consulte ses tâches. Ce balayage poursuit   */
/* les mêmes opérations pour TOUS les utilisateurs recensés : dispatch */
/* des tâches en attente, rafraîchissement des tâches en cours — même  */
/* onglet fermé (pattern des sweeps vidéo/escrow du cron               */
/* agent-schedules : best-effort total, un incident par utilisateur   */
/* n'interrompt jamais les autres).                                   */
/* ------------------------------------------------------------------ */

/** Préfixe r2fs de la collection users (fs/users/{uid}.json). */
const USERS_PREFIX = "fs/users/";

/** Même règle que repository.ts (identifiants de documents). */
const UID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Utilisateurs max balayés par passage (protection anti-dérive). */
export const MAX_USERS_PER_SWEEP = 200;

/**
 * Recense les identifiants utilisateur depuis la collection r2fs
 * `users` (un document par compte inscrit). Les clés non conformes
 * (documents techniques, préfixes parasites) sont ignorées silencieusement.
 */
export async function listTrainingUserIds(maxUsers: number = MAX_USERS_PER_SWEEP): Promise<string[]> {
  const objects = await listKeys(USERS_PREFIX, { maxObjects: 1000 });
  const uids = objects
    .map((object) => object.key.slice(USERS_PREFIX.length).replace(/\.json$/, ""))
    .filter((uid) => UID_PATTERN.test(uid));
  return [...new Set(uids)].slice(0, Math.max(0, maxUsers));
}

export interface TrainingSweepResult {
  usersScanned: number;
  dispatched: number;
  refreshed: number;
  failures: string[];
}

/**
 * Balaye les tâches actives de TOUS les utilisateurs recensés.
 * Chaque utilisateur est indépendant (best-effort) : ses erreurs
 * alimentent `failures` sans interrompre le passage. L'échec du
 * listage lui-même EST propagé (jamais de scan silencieux sur un
 * stockage en panne — même règle que listJson).
 */
export async function sweepAllTrainingJobs(maxUsers: number = MAX_USERS_PER_SWEEP): Promise<TrainingSweepResult> {
  const uids = await listTrainingUserIds(maxUsers);
  const result: TrainingSweepResult = { usersScanned: uids.length, dispatched: 0, refreshed: 0, failures: [] };
  for (const uid of uids) {
    try {
      const outcome = await sweepUserJobs(uid);
      result.dispatched += outcome.dispatched;
      result.refreshed += outcome.refreshed;
    } catch (error) {
      result.failures.push(`${uid}: ${error instanceof Error ? error.message : "erreur"}`);
    }
  }
  return result;
}
