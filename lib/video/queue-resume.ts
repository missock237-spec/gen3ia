import "server-only";

/**
 * GEN3IA VIDEO AGENT — reprise automatique QUOTA-AWARE des files de rendu
 * (render-queue / production-queue, Task 95-c/d).
 *
 * Un incident de QUOTA Firestore (RESOURCE_EXHAUSTED / 429) n'est pas un
 * échec de production : les jobs vidéo ne consomment ni leur budget de
 * relance, ni d'échec définitif, ni de notification — ils sont ré-enfilés
 * avec un backoff exponentiel et reprennent à leur checkpoint quand le
 * quota revient (Task 108 : Firestore est l'unique moteur ; le miroir du
 * second backend a été supprimé — sous quota, les ticks sont neutralisés
 * puis republiés, exactement le même régime de reprise).
 *
 * Ce module est l'interface GELÉE entre les files (render-queue.ts,
 * production-queue.ts) et la couche résiliente Firestore-only
 * (lib/db/firestore-resilient) :
 *   - classifyTickError / resumePolicyFor : décision de reprise ;
 *   - loadJobDoc / saveJobDoc / createJobDoc / queryJobDocs : documents job
 *     via la couche résiliente (deadline anti-stall + disjoncteur quota).
 */

import { isFirestoreQuotaError, isFirestoreTransientError } from "@/lib/db/quota-guard";
import {
  resilientCreate,
  resilientGet,
  resilientQuery,
  resilientSet,
  type ResilientQueryOptions,
} from "@/lib/db/firestore-resilient";
import type { RenderJob } from "@/lib/video/types";

// ---------------------------------------------------------------------------
// Classification des erreurs de tick
// ---------------------------------------------------------------------------

export type TickErrorClass = "quota" | "transient" | "fatal";

/**
 * Classe une erreur remontée d'un tick :
 *   - « quota »    : quota Firestore épuisé (isFirestoreQuotaError) ;
 *   - « transient »: incident passager (UNAVAILABLE, timeout, réseau) ;
 *   - « fatal »    : tout le reste (bug, donnée invalide…).
 */
export function classifyTickError(error: unknown): TickErrorClass {
  if (isFirestoreQuotaError(error)) return "quota";
  if (isFirestoreTransientError(error)) return "transient";
  return "fatal";
}

// ---------------------------------------------------------------------------
// Politique de reprise
// ---------------------------------------------------------------------------

export interface ResumePolicy {
  /** Consommer le budget retryCount du job (true = échec legacy). */
  consumeRetry: boolean;
  /** Délai avant le prochain tick (secondes). */
  delaySeconds: number;
  /** Notification « échec » à l'utilisateur. */
  notifyFailure: boolean;
}

/** Base du backoff QUOTA (secondes) : 30 → 60 → 120 → … plafonné. */
export const QUOTA_BACKOFF_BASE_SECONDS = 30;
/** Plafond du backoff QUOTA (secondes) : 15 minutes. */
export const QUOTA_BACKOFF_CAP_SECONDS = 900;
/** Délai fixe avant le prochain tick pour un incident transitoire. */
export const TRANSIENT_DELAY_SECONDS = 15;

/**
 * Politique de reprise pour une erreur de tick :
 *   - quota     : PAS de consommation du budget, backoff exponentiel
 *                 min(30 × 2^quotaFailures, 900) + gigue 0..5 s, pas de
 *                 notification — la reprise est automatique ;
 *   - transitoire : PAS de consommation, nouvelle tentative rapide (15 s) ;
 *   - fatal     : régime legacy (budget consommé + notification).
 */
export function resumePolicyFor(error: unknown, quotaFailures: number): ResumePolicy {
  if (isFirestoreQuotaError(error)) {
    const exponent = Math.max(0, quotaFailures);
    const base = Math.min(QUOTA_BACKOFF_BASE_SECONDS * 2 ** exponent, QUOTA_BACKOFF_CAP_SECONDS);
    // Gigue 0..5 s : désynchronise les jobs remis en file en même temps.
    const jitter = Math.floor(Math.random() * 6);
    return { consumeRetry: false, delaySeconds: base + jitter, notifyFailure: false };
  }
  if (isFirestoreTransientError(error)) {
    return { consumeRetry: false, delaySeconds: TRANSIENT_DELAY_SECONDS, notifyFailure: false };
  }
  return { consumeRetry: true, delaySeconds: TRANSIENT_DELAY_SECONDS, notifyFailure: true };
}

// ---------------------------------------------------------------------------
// Job enrichi (Task 95-c) — champ compteur d'incidents quota
// ---------------------------------------------------------------------------

/**
 * Le champ `quotaFailures` (compteur d'incidents quota consécutifs, utilisé
 * pour le backoff) vit HORS du type RenderJob historique : les files le
 * lisent/écrivent via cette intersection, sans toucher lib/video/types.ts.
 */
export type RenderJobWithResume = RenderJob & { quotaFailures?: number };

// ---------------------------------------------------------------------------
// Documents job — wrappers sur la couche résiliente Firestore-only
// ---------------------------------------------------------------------------

/** Lit un document job (couche résiliente : deadline anti-stall + disjoncteur). */
export async function loadJobDoc<T>(collection: string, jobId: string): Promise<T | null> {
  return resilientGet<T>(collection, jobId);
}

/**
 * Écrit un patch MERGE sur un document job : Firestore reçoit le patch
 * INCHANGÉ (sentinelles FieldValue comprises). Une erreur de quota est
 * propagée — la file la classe (classifyTickError) et applique son backoff
 * sans consommer le budget de relance.
 */
export async function saveJobDoc(collection: string, jobId: string, patch: object, ownerId?: string): Promise<void> {
  await resilientSet(collection, jobId, patch, { merge: true, ownerId });
}

/** Crée un document job (couche résiliente). */
export async function createJobDoc(collection: string, jobId: string, payload: object, ownerId?: string): Promise<void> {
  await resilientCreate(collection, jobId, payload, ownerId);
}

/** Requête par champ de payload (ex. status==queued) via la couche résiliente. */
export async function queryJobDocs<T>(
  collection: string,
  field: string,
  value: unknown,
  options?: ResilientQueryOptions,
): Promise<T[]> {
  return resilientQuery<T>(collection, [{ field, value }], options);
}
