/**
 * CONFIGURATION DU GEN3IA AUTONOMOUS CORE (Phase 1).
 *
 * Tout est borné et surchargeable par variables d'environnement : le core
 * tourne sur le VPS PM2 (RAM max_memory_restart 1G) — chaque valeur est
 * pensée pour rester légère. Défauts : cycle de base 5 min (le plan fixe le
 * rythme de la collecte), ticks concurrents bornés, journal borné.
 *
 * L'armement au boot (instrumentation.ts) est désactivable par AUTO_CORE=0
 * — même convention que AUTO_APPRENTISSAGE=0 de la boucle existante.
 */

/** Configuration complète du core (valeurs réelles, jamais inventées). */
export interface ConfigCoeurAutonome {
  /** Le core est-il armé (boot automatique) ? */
  arme: boolean;
  /** Période du cycle de base (ms) — défaut 5 min, plan Phase 2. */
  intervalleCycleMs: number;
  /** Timeout de sécurité d'un tick de module (ms). */
  timeoutTickMs: number;
  /** Ticks de modules concurrents max par cycle (RAM 2 cœurs). */
  maxTicksConcurrents: number;
  /** Échecs consécutifs avant suspension d'un module (recovery-manager). */
  echecsAvantSuspension: number;
  /** Durée de suspension d'un module (ms) avant réarmement automatique. */
  suspensionMs: number;
  /** Tâches par module retenues en mémoire (journal borné). */
  journalTachesParModule: number;
  /** Cycles retenus dans le journal de cycles (borné). */
  journalCycles: number;
}

const MIN_CYCLE_MS = 60_000;
const MIN_TIMEOUT_MS = 5_000;

function nombreEnv(
  env: Record<string, string | undefined>,
  nom: string,
  defaut: number,
  min: number,
  max: number,
): number {
  const brut = env[nom];
  if (!brut) return defaut;
  const valeur = Number(brut);
  if (!Number.isFinite(valeur) || valeur <= 0) return defaut;
  return Math.min(max, Math.max(min, Math.round(valeur)));
}

/** Construit la configuration depuis l'environnement (défauts bornés). */
export function chargerConfigCoeurAutonome(
  env: Record<string, string | undefined> = process.env,
): ConfigCoeurAutonome {
  return {
    arme: env.AUTO_CORE !== "0",
    intervalleCycleMs: nombreEnv(env, "AUTO_CORE_CYCLE_MS", 300_000, MIN_CYCLE_MS, 3_600_000),
    timeoutTickMs: nombreEnv(env, "AUTO_CORE_TIMEOUT_TICK_MS", 60_000, MIN_TIMEOUT_MS, 600_000),
    maxTicksConcurrents: nombreEnv(env, "AUTO_CORE_TICKS_CONCURRENTS", 2, 1, 8),
    echecsAvantSuspension: nombreEnv(env, "AUTO_CORE_ECHECS_SUSPENSION", 5, 2, 50),
    suspensionMs: nombreEnv(env, "AUTO_CORE_SUSPENSION_MS", 600_000, MIN_CYCLE_MS, 3_600_000),
    journalTachesParModule: nombreEnv(env, "AUTO_CORE_JOURNAL_TACHES", 50, 5, 500),
    journalCycles: nombreEnv(env, "AUTO_CORE_JOURNAL_CYCLES", 50, 5, 500),
  };
}
