import "server-only";

import { getRedis } from "@/lib/cache/redis";

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
 * MAINTENANT : les deux gardes vivent dans Redis quand il est configuré —
 *  - verrou : SET NX PX 30 s (acquisition atomique, une seule instance)
 *    puis DEL à la fin de la décision (finally) ;
 *  - empreinte : SET { hash, feedbackAt } EX 600 s (dédup d'écran inchangé
 *    partagée par toutes les instances).
 * Sans Redis (variables absentes / panne) : repli transparent sur les Map
 * locales, exactement la sémantique Task 45 — jamais de blocage du trafic
 * pour une panne d'infrastructure.
 *
 * Clés préfixées `g3:` par lib/cache/redis (KEY_PREFIX central).
 */

const DECISION_LOCK_TTL_MS = 30_000;
const FRAME_PRINT_TTL_MS = 10 * 60_000;

export interface FramePrint {
  hash: string;
  feedbackAt: number;
}

export interface AcquireResult {
  acquired: boolean;
  /** true = décision partagée via Redis ; false = repli mémoire locale. */
  distributed: boolean;
}

// ─── Repli mémoire (une instance — sémantique Task 45 préservée) ─────────────

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
 * Acquiert le verrou « une décision vision à la fois par session ». Retourne
 * `acquired: false` si une décision est déjà en cours (où que ce soit).
 */
export async function acquireDecisionLock(sessionId: string): Promise<AcquireResult> {
  const redis = getRedis();
  if (!redis) {
    if (isLockFresh(sessionId)) return { acquired: false, distributed: false };
    localLocks.set(sessionId, Date.now());
    return { acquired: true, distributed: false };
  }

  try {
    const result = await redis.set(
      `live-lock:${sessionId}`,
      Date.now(),
      { nx: true, px: DECISION_LOCK_TTL_MS },
    );
    // @upstash/redis renvoie "OK" (chaîne) en succès de SET NX, null sinon.
    return { acquired: result === "OK", distributed: true };
  } catch {
    // Redis indisponible : la garde locale reste meilleure que rien.
    if (isLockFresh(sessionId)) return { acquired: false, distributed: false };
    localLocks.set(sessionId, Date.now());
    return { acquired: true, distributed: false };
  }
}

/** Libère le verrou en fin de décision (finally) — no-op sûr si absent. */
export async function releaseDecisionLock(sessionId: string): Promise<void> {
  localLocks.delete(sessionId);
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(`live-lock:${sessionId}`);
  } catch {
    // Le TTL 30 s fera le nettoyage en cas de panne réseau ici.
  }
}

/**
 * Test lecture seule « une décision est-elle en cours ? » — sans effet de
 * bord (utilisé par la branche dédup avant toute acquisition).
 */
export async function isDecisionInFlight(sessionId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return isLockFresh(sessionId);
  try {
    const exists = await redis.exists(`live-lock:${sessionId}`);
    return exists === 1 || isLockFresh(sessionId);
  } catch {
    return isLockFresh(sessionId);
  }
}

/**
 * Empreinte de la dernière frame analysée (dédup « écran inchangé ») —
 * null si aucune analyse précédente visible depuis cette instance.
 */
export async function getPreviousFramePrint(sessionId: string): Promise<FramePrint | null> {
  const redis = getRedis();
  if (!redis) {
    purgeLocal();
    return localPrints.get(sessionId)?.print ?? null;
  }
  try {
    const value = await redis.get<{ hash: string; feedbackAt: number }>(`live-frame:${sessionId}`);
    if (!value) return null;
    //automaticDeserialization renvoie l'objet ; défense contre les valeurs scalaires.
    if (typeof value !== "object" || typeof (value as FramePrint).hash !== "string") return null;
    return { hash: (value as FramePrint).hash, feedbackAt: (value as FramePrint).feedbackAt };
  } catch {
    return localPrints.get(sessionId)?.print ?? null;
  }
}

/** Mémorise l'empreinte après analyse (TTL 10 min, partagé entre instances). */
export async function setFramePrint(sessionId: string, print: FramePrint): Promise<void> {
  localPrints.set(sessionId, { print, at: Date.now() });
  purgeLocal();
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(`live-frame:${sessionId}`, print, { ex: Math.floor(FRAME_PRINT_TTL_MS / 1000) });
  } catch {
    // Repli local déjà alimenté — rien d'autre à faire.
  }
}

/** @internal Réservé aux tests : réinitialise les Map de repli. */
export function resetDecisionLockForTests(): void {
  localLocks.clear();
  localPrints.clear();
}
