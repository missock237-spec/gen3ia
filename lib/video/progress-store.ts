import "server-only";

/**
 * GEN3IA VIDEO AGENT — instantané de progression des jobs de rendu.
 *
 * Task 108 : ce module était adossé au service externe Redis
 * (ancien lib/infra/upstash.ts, supprimé) — l'instantané vit
 * désormais dans une Map PROCESSUS-LOCAL (TTL 24 h, plafond LRU 5 000 clés).
 *
 * Sémantique inchangée côté fichiers : le render-queue publie la progression
 * à chaud (best-effort, `.catch(() => undefined)` côté appelants) et la route
 * GET .../render surcharge la progression stockée du job avec cet instantané
 * plus frais. Le point de vérité RESTE le document Firestore du job — la
 * perte de l'instantané (redémarrage d'instance) ne fait que retomber sur la
 * dernière progression persistée, comme quand Redis était absent.
 *
 * ÉCHelle (documentée) : en serverless multi-instances, l'instantané n'est
 * visible que par l'instance qui écrit — même compromis que le mode dégradé
 * historique « Redis absent ».
 */

interface ProgressEntry {
  value: Record<string, unknown>;
  expiresAt: number;
}

const store = new Map<string, ProgressEntry>();
const MAX_ENTRIES = 5_000;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 h : la vie d'un job de rendu.

function key(jobId: string): string {
  return `gen3ia:job:${jobId}`;
}

function evictExpired(now: number): void {
  for (const [k, entry] of store) {
    if (entry.expiresAt <= now) store.delete(k);
  }
}

/** Publie (best-effort) la progression d'un job — jamais bloquant. */
export async function setJobProgress(
  jobId: string,
  progress: number,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const now = Date.now();
  if (store.size >= MAX_ENTRIES) {
    evictExpired(now);
    while (store.size >= MAX_ENTRIES) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  }
  store.set(key(jobId), {
    value: {
      progress: Math.max(0, Math.min(1, progress)),
      status,
      ...extra,
      updatedAt: now,
    },
    expiresAt: now + TTL_MS,
  });
}

/** Lit l'instantané de progression — null si absent/expiré. */
export async function getJobProgress<T = Record<string, unknown>>(jobId: string): Promise<T | null> {
  const entry = store.get(key(jobId));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key(jobId));
    return null;
  }
  return entry.value as T;
}

/** @internal Réservé aux tests : vide l'instantané process-local. */
export function resetJobProgressForTests(): void {
  store.clear();
}
