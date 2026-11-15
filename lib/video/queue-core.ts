import "server-only";

/**
 * GEN3IA VIDEO AGENT — SOCLE COMMUN DES FILES (production-queue / render-queue).
 *
 * Les deux files (module 19 rendu, module 20 production autopilote) partagent
 * la MÊME mécanique de ticks, historiquement dupliquée en miroir :
 *   - helpers purs (horodatage, clamp de progression, math par étapes) ;
 *   - bail de claim (leaseOwner / leaseExpiresAt) ;
 *   - publication de tick dans la file R2 + journalisation d'incident ;
 *   - sweep des jobs orphelins (bail/échéance dépassés) ;
 *   - continuation par sondage (avance un job en attente dans un GET) ;
 *   - claim du prochain job en file (worker standalone).
 *
 * Ce module factorise ces mécanismes SANS changer le comportement : les
 * différences de forme entre les deux files (champs de job, messages FR,
 * prédicats d'échéance) restent portées par les appelants via des
 * paramètres/fonctions injectées. Les helpers purs sont testés via les
 * suites existantes des deux files (contrats préservés).
 */

import { logSystem } from "@/lib/video/project-service";
import { queryJobDocs } from "@/lib/video/queue-resume";
import type { TickPublishResult } from "@/lib/queue/tick-queue";

// ────────────────────────────────────────────────────────────────────────────
// Helpers purs
// ────────────────────────────────────────────────────────────────────────────

export function nowIso(): string {
  return new Date().toISOString();
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 10_000) / 10_000));
}

/** Carte de pondération par étape : [début d'étape, fin d'étape] en 0..1. */
export type StageWeights<Stage extends string> = Record<Stage, [number, number]>;

/**
 * Progression pondérée d'un job (contrat stocké 0..1 — l'UI multiplie par
 * 100) : interpolée DANS l'étape courante via completed/total ; total = 0 →
 * début d'étape (1 pour l'étape TERMINALE). Math unique des deux files :
 * `computeJobProgress` (rendu) et `computeProductionProgress` (production)
 * délèguent ici avec leurs poids respectifs.
 */
export function computeStageProgress<Stage extends string>(
  weights: StageWeights<Stage>,
  terminalStage: Stage,
  stage: Stage,
  completed: number,
  total: number,
): number {
  const [start, end] = weights[stage];
  const span = end - start;
  const safeTotal = Math.max(0, total);
  const ratio = safeTotal > 0
    ? Math.min(1, Math.max(0, completed / safeTotal))
    : stage === terminalStage
      ? 1
      : 0;
  return clamp01(start + span * ratio);
}

// ────────────────────────────────────────────────────────────────────────────
// Bail de claim (leaseOwner / leaseExpiresAt)
// ────────────────────────────────────────────────────────────────────────────

/** Porteur d'un bail de traitement (les deux documents job le portent). */
export interface LeaseBearer {
  leaseExpiresAt?: number;
}

/** true si un bail de claim est ENCORE actif à l'instant `now`. */
export function leaseActive(job: LeaseBearer, now: number): boolean {
  return typeof job.leaseExpiresAt === "number" && job.leaseExpiresAt > now;
}

// ────────────────────────────────────────────────────────────────────────────
// Publication dans la file de ticks R2 (continuation arrière-plan)
// ────────────────────────────────────────────────────────────────────────────

/** URL de réception des ticks d'une file (pattern brut, origine canonique). */
export function tickUrl(origin: string, path: string): string {
  return `${origin.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

/** Publisher de tick d'une file (ex. enqueueVideoRenderTick). */
export type TickPublisher = (jobId: string, delaySeconds?: number) => Promise<TickPublishResult>;

/**
 * Publication interne d'une file : renvoie true si le tick est enfilé ;
 * journalise les échecs RÉELS (mode error) — le mode unconfigured (R2 absent
 * ou origine canonique non résolue) est le fonctionnement normal en
 * environnement sans file (continuation par sondage).
 *
 * `pollHint` : suffixe FR du message de repli sondage, propre à chaque file
 * (« du studio ou worker local » pour le rendu, « du studio » pour la
 * production — messages historiques préservés).
 */
export async function publishTickAndLog(
  job: Pick<{ projectId: string }, "projectId"> & { id: string },
  publisher: TickPublisher,
  pollHint: string,
  delaySeconds = 0,
): Promise<boolean> {
  const published = await publisher(job.id, delaySeconds);
  if (!published.ok && published.mode === "error") {
    await logSystem(job.projectId, `Continuation de file échouée (${published.message.slice(0, 200)}) — reprise par sondage ${pollHint}.`).catch(() => undefined);
  }
  return published.ok;
}

// ────────────────────────────────────────────────────────────────────────────
// Sweeper + continuation par sondage + claim worker (squelettes communs)
// ────────────────────────────────────────────────────────────────────────────

/** Résultat d'un sweep de jobs orphelins (contrat partagé des deux files). */
export interface QueueSweepResult {
  scanned: number;
  requeued: number;
  failed: number;
}

/**
 * Squelette de sweep : récupère les jobs « processing », écarte les bails
 * VIVANTS (idempotence — jamais de double travail), applique le prédicat
 * d'échéance PROPRE À LA FILE (rendu : champ deadlineAt ; production : âge
 * du document) puis délègue au régime d'échec de la file (failJob /
 * failProductionJob). Idempotent : un job vivant n'est jamais touché.
 */
export async function sweepStaleJobs<TJob extends LeaseBearer>(options: {
  collection: string;
  /** Normalise un document brut (compatibilité champs manquants/historiques). */
  normalize: (stored: TJob) => TJob;
  /** Prédicat d'échéance dépassée, propre à la file. */
  isStale: (job: TJob, now: number) => boolean;
  /** Régime d'échec de la file (re-file ou échec définitif). */
  fail: (job: TJob) => Promise<{ status: string }>;
}): Promise<QueueSweepResult> {
  // Lecture via la couche résiliente (miroir chaud sous quota — Task 95-c/d).
  const stale = await queryJobDocs<TJob>(options.collection, "status", "processing");
  const now = Date.now();
  let requeued = 0;
  let failed = 0;
  for (const stored of stale) {
    const job = options.normalize(stored);
    if (leaseActive(job, now)) continue;
    if (!options.isStale(job, now)) continue;
    const result = await options.fail(job);
    if (result.status === "queued") requeued += 1;
    else failed += 1;
  }
  return { scanned: stale.length, requeued, failed };
}

/**
 * Squelette de CONTINUATION PAR SONDAGE : fait avancer d'UN tick un job en
 * attente DANS la requête de polling — la file avance même sans éditeur de
 * ticks configuré tant qu'un client garde une page ouverte. Le claim
 * transactionnel de la file garantit qu'un sondage concurrent ne peut pas
 * doubler un tick (bail). Ne fait rien si le job est terminal, en pause ou
 * détenu par un worker vivant (bail actif).
 */
export async function advancePendingJob<TJob extends { status: string } & LeaseBearer, TResult>(
  load: () => Promise<TJob | null>,
  advance: () => Promise<TResult>,
): Promise<TResult | null> {
  const job = await load();
  if (!job) return null;
  const now = Date.now();
  if (job.status === "queued") {
    return advance();
  }
  if (job.status === "processing" && !leaseActive(job, now)) {
    // Bail expiré (ou absent) : récupérable — le claim transactionnel
    // arbitre si un autre worker vient de le prendre.
    return advance();
  }
  return null;
}

/**
 * Squelette de tick autonome (worker standalone) : prend le prochain job en
 * file (tri par création, le plus ancien d'abord) et le réclame via le claim
 * de la file — worker local et continuations serveur ne se doublent jamais
 * (même claim transactionnel + bail que les ticks publiés). Un prédicat
 * `skip` optionnel écarte les jobs non réclamables sans claim (ex. garde
 * nextAttemptAt de la production).
 */
export async function claimNextQueuedJobDoc<TJob extends { id: string }>(options: {
  collection: string;
  /** Claim de la file : renvoie le job réclamé, ou null si non réclamable. */
  claim: (jobId: string) => Promise<TJob | null>;
  skip?: (candidate: TJob) => boolean;
}): Promise<TJob | null> {
  // Lecture via la couche résiliente (miroir chaud sous quota) ; tri mémoire
  // par création identique aux requêtes historiques des deux files.
  const jobs = await queryJobDocs<TJob>(options.collection, "status", "queued", { orderField: "createdAt" });
  for (const candidate of jobs) {
    if (options.skip?.(candidate)) continue;
    const claimed = await options.claim(candidate.id).catch(() => null);
    if (claimed !== null) return claimed;
  }
  return null;
}
