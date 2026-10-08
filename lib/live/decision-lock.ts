import "server-only";

/**
 * Verrou de décision vision + dédup de frames de l'agent Live (Task 62 —
 * priorité #5, scalabilité horizontale).
 *
 * AVANT (Task 45) : verrou « décision en vol » et empreinte de frame tenus
 * dans des Map de processus → N instances autorisaient N décisions LLM
 * CONCURRENTES sur la même session (dépense LLM multipliée, observations
 * dupliquées) et la dédup d'écran inchangé ne voyait que les frames de sa
 * propre instance.
 *
 * INTERMÉDIAIRE (Task 62-107) : les deux gardes vivaient dans le service
 * externe Redis quand il était configuré (SET NX PX / empreinte TTL 10 min).
 *
 * MAINTENANT (Task 108) : le service externe Redis a été supprimé du projet
 * (décision worklog 108-0) — les deux gardes redeviennent PROCESSUS-LOCAL
 * (Map + TTL, exactement la sémantique Task 45) :
 *  - verrou : TTL 30 s de « décision en vol » par session, libéré à la fin
 *    de la décision (finally) ;
 *  - empreinte : TTL 600 s (dédup d'écran inchangé).
 * Le facteur de protection est donc PAR-INSTANCE : chaque instance serverless
 * protège ses propres décisions ; une session est servie par une instance à
 * la fois (affinité du flux Live), le risque multi-instance est identique au
 * fonctionnement historique « Redis absent » — jamais de blocage du trafic
 * pour une panne d'infrastructure.
 */

const DECISION_LOCK_TTL_MS = 30_000;
const FRAME_PRINT_TTL_MS = 10 * 60_000;

export interface FramePrint {
  hash: string;
  feedbackAt: number;
}

export interface AcquireResult {
  acquired: boolean;
  /** Toujours false depuis Task 108 : la garde est processus-local. */
  distributed: boolean;
}

// ─── Garde mémoire (une instance — sémantique Task 45 restaurée) ─────────────

const localLocks = new Map<string, number>();
const localPrints = new Map<string, { print: FramePrint; at: number }>();

function isLockFresh(id: string): boolean {
  const at = localLocks.get(id);
  return typeof at === "number" && Date.now() - at < DECISION_LOCK_TTL_MS;
}

function purgeLocal(): void {
  const now = Date.now();
  for (const [key, at] of localLocks) {
    if (now - at >= DECISION_LOCK_TTL_MS) localLocks.delete(key);
  }
  for (const [key, entry] of localPrints) {
    if (now - entry.at >= FRAME_PRINT_TTL_MS) localPrints.delete(key);
  }
}

// ─── API publique ────────────────────────────────────────────────────────────

/**
 * Acquiert le verrou « une décision vision à la fois par session » (sur CETTE
 * instance). Retourne `acquired: false` si une décision est déjà en cours.
 */
export async function acquireDecisionLock(sessionId: string): Promise<AcquireResult> {
  purgeLocal();
  if (isLockFresh(sessionId)) return { acquired: false, distributed: false };
  localLocks.set(sessionId, Date.now());
  return { acquired: true, distributed: false };
}

/** Libère le verrou en fin de décision (finally) — no-op sûr si absent. */
export async function releaseDecisionLock(sessionId: string): Promise<void> {
  localLocks.delete(sessionId);
}

/**
 * Test lecture seule « une décision est-elle en cours ? » — sans effet de
 * bord (utilisé par la branche dédup avant toute acquisition).
 */
export async function isDecisionInFlight(sessionId: string): Promise<boolean> {
  purgeLocal();
  return isLockFresh(sessionId);
}

/**
 * Empreinte de la dernière frame analysée (dédup « écran inchangé ») —
 * null si aucune analyse précédente visible depuis cette instance.
 */
export async function getPreviousFramePrint(sessionId: string): Promise<FramePrint | null> {
  purgeLocal();
  return localPrints.get(sessionId)?.print ?? null;
}

/** Mémorise l'empreinte après analyse (TTL 10 min, par instance). */
export async function setFramePrint(sessionId: string, print: FramePrint): Promise<void> {
  localPrints.set(sessionId, { print, at: Date.now() });
  purgeLocal();
}

/** @internal Réservé aux tests : réinitialise les Map de garde. */
export function resetDecisionLockForTests(): void {
  localLocks.clear();
  localPrints.clear();
}
