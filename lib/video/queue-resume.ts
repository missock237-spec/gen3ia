import "server-only";

/**
 * GEN3IA VIDEO AGENT — Task 95-c : reprise automatique QUOTA-AWARE des files
 * de rendu (render-queue / production-queue).
 *
 * Pendant une panne de QUOTA Firestore (RESOURCE_EXHAUSTED / 429), les jobs
 * vidéo ne doivent ni consommer leur budget de relance, ni échouer
 * définitivement, ni notifier l'utilisateur : ils basculent sur le MIROIR
 * chaud Supabase (firestore_fallback, couche résiliente de la Task 95-b) le
 * temps de la panne, avec un backoff exponentiel, puis sont ré-imbriqués
 * dans Firestore à la reprise.
 *
 * Ce module est l'interface GELÉE entre les files (render-queue.ts) et la
 * couche de persistance résiliente (lib/db/firestore-fallback) :
 *   - classifyTickError / resumePolicyFor : décision de reprise ;
 *   - claimJobViaFallback : claim atomique sur la ligne miroir ;
 *   - loadJobDoc / saveJobDoc / createJobDoc / queryJobDocs : documents job
 *     via la couche résiliente (Firestore d'abord, miroir sous quota) ;
 *   - maybeReconcileQuotaRecovery : ré-imblication opportuniste (throttle).
 */

import { logger } from "@/lib/observability/logger";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { isFirestoreQuotaError, isFirestoreTransientError } from "@/lib/db/quota-guard";
import {
  resilientCreate,
  resilientGet,
  resilientQuery,
  resilientSet,
  reconcileFallbackToFirestore,
  type FallbackQueryOptions,
  type ReconcileResult,
} from "@/lib/db/firestore-fallback";
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
// Claim atomique sur la ligne miroir (Firestore sous quota)
// ---------------------------------------------------------------------------

export interface FallbackLease {
  /** `${jobId}:${uuid}` — même convention que le claim Firestore. */
  owner: string;
  /** Instant d'expiration du bail (ISO 8601) = now + leaseMs. */
  expiresAtIso: string;
}

const FALLBACK_TABLE = "firestore_fallback";

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Claim ATOMIQUE d'un job sur la ligne miroir Supabase quand Firestore est
 * sous quota. Le bail (leaseOwner/leaseExpiresAt) et le statut sont posés
 * dans un SEUL UPDATE conditionnel : il ne réussit que si le bail courant
 * est libre (absent ou expiré) ET le statut est réclamable — deux workers
 * concurrents ne peuvent pas tous deux gagner (Postgres sérialise).
 *
 * Retourne le payload fusionné à jour si le claim est gagné, sinon null
 * (bail déjà pris, ligne miroir absente, Supabase non configuré ou erreur —
 * journalisée pino warn, JAMAIS de levée).
 */
export async function claimJobViaFallback(
  collection: string,
  jobId: string,
  lease: FallbackLease,
  claimableStatuses: string[],
  extraPatch: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  try {
    // 1) Lecture de la ligne miroir courante pour construire l'état fusionné
    //    (le miroir est « chaud » : les patches resilientSet y sont mergés).
    const read = await supabase
      .from(FALLBACK_TABLE)
      .select("payload")
      .eq("collection", collection)
      .eq("document_id", jobId)
      .maybeSingle();
    if (read.error) {
      logger.warn({ collection, jobId, error: describeError(read.error) }, "fallback_claim_failed");
      return null;
    }
    const current = (read.data?.payload ?? {}) as Record<string, unknown>;
    const merged = {
      ...current,
      leaseOwner: lease.owner,
      leaseExpiresAt: lease.expiresAtIso,
      ...extraPatch,
    };
    // 2) UPDATE conditionnel — filtres : collection + document, bail libre
    //    (`leaseOwner` null OU `leaseExpiresAt` < MAINTENANT — clés JSON
    //    camelCase, la convention des documents job) et statut réclamable.
    //    La comparaison au bail se fait contre l'instant COURANT pour
    //    répliquer EXACTEMENT la condition transactionnelle Firestore
    //    (`leaseExpiresAt > now` → bail vivant) : comparer au seuil du
    //    NOUVEAU bail (now + leaseMs) permettrait à un second claim de voler
    //    un bail encore actif. Comparaison lexicographique d'ISO 8601 =
    //    chronologique. `.select("payload")` ne rend que la ligne réellement
    //    mise à jour : 0 ligne = claim perdu.
    const update = await supabase
      .from(FALLBACK_TABLE)
      .update({ payload: merged, updated_at: new Date().toISOString() })
      .eq("collection", collection)
      .eq("document_id", jobId)
      .or(`payload->>leaseOwner.is.null,payload->>leaseExpiresAt.lt."${new Date().toISOString()}"`)
      .in("payload->>status", claimableStatuses)
      .select("payload");
    if (update.error) {
      logger.warn({ collection, jobId, error: describeError(update.error) }, "fallback_claim_failed");
      return null;
    }
    const rows = (update.data ?? []) as Array<{ payload: Record<string, unknown> }>;
    if (rows.length !== 1) return null;
    return rows[0].payload;
  } catch (error) {
    logger.warn({ collection, jobId, error: describeError(error) }, "fallback_claim_failed");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Documents job (miroir chaud) — wrappers sur la couche résiliente
// ---------------------------------------------------------------------------

/** Lit un document job (Firestore d'abord, miroir pendant la panne). */
export async function loadJobDoc<T>(collection: string, jobId: string): Promise<T | null> {
  return resilientGet<T>(collection, jobId);
}

/**
 * Écrit un patch MERGE sur un document job : Firestore reçoit le patch
 * INCHANGÉ (sentinelles FieldValue comprises), le miroir reçoit une copie
 * assainie (Task 95-b). Sous quota, l'écriture atterrit dans le miroir.
 */
export async function saveJobDoc(collection: string, jobId: string, patch: object, ownerId?: string): Promise<void> {
  await resilientSet(collection, jobId, patch, { merge: true, ownerId });
}

/** Crée un document job (miroir alimenté dès la création). */
export async function createJobDoc(collection: string, jobId: string, payload: object, ownerId?: string): Promise<void> {
  await resilientCreate(collection, jobId, payload, ownerId);
}

/** Requête par champ de payload (ex. status==queued) via la couche résiliente. */
export async function queryJobDocs<T>(
  collection: string,
  field: string,
  value: unknown,
  options?: FallbackQueryOptions,
): Promise<T[]> {
  return resilientQuery<T>(collection, [{ field, value }], options);
}

// ---------------------------------------------------------------------------
// Réconciliation opportuniste miroir → Firestore (après reprise)
// ---------------------------------------------------------------------------

/** Throttle process-local : au plus une passe de réconciliation toutes les 5 min. */
const RECONCILE_THROTTLE_MS = 5 * 60_000;
let lastReconcileAttemptMs = 0;

/**
 * Réconciliation opportuniste : quand le disjoncteur est refermé (quota
 * revenu), ré-imbrique jusqu'à `limit` lignes miroir dans Firestore.
 * Throttle process-local 5 min ; NE LÈVE JAMAIS (incidents journalisés).
 * Retourne le dernier ReconcileResult, ou null si (throttle actif ou passe
 * impossible).
 */
export async function maybeReconcileQuotaRecovery(limit = 25): Promise<ReconcileResult | null> {
  const now = Date.now();
  if (now - lastReconcileAttemptMs < RECONCILE_THROTTLE_MS) return null;
  lastReconcileAttemptMs = now;
  try {
    // reconcileFallbackToFirestore saute la passe tant que le disjoncteur
    // est ouvert (skipped=true) — on transmet tel quel.
    return await reconcileFallbackToFirestore({ limit });
  } catch (error) {
    logger.warn({ error: describeError(error) }, "fallback_reconcile_failed");
    return null;
  }
}

/** Remet le throttle de réconciliation à zéro (tests uniquement). */
export function resetQueueResumeForTests(): void {
  lastReconcileAttemptMs = 0;
}
