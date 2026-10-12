import "server-only";

/**
 * GEN3IA VIDEO AGENT — Task 134 : orchestration des SOUS-AGENTS vidéo.
 *
 * Amélioration #3 (« à chaque génération de vidéo, déployer des sous-agents
 * pour une rapidité d'exécution ») : chaque phase INDÉPENDANTE du pipeline
 * vidéo est exécutée par une vague de sous-agents bornée en concurrence,
 * au lieu d'une boucle séquentielle historique.
 *
 * Un « sous-agent vidéo » = un worker spécialisé d'une phase (analyse
 * voice-sync d'une scène, export d'un format dérivé, préflight d'un asset
 * audio), exécuté EN PARALLÈLE avec ses pairs via mapWithConcurrency
 * (concurrence stricte, ordre stable, erreurs isolées, budget temps).
 *
 * Contrats :
 *  - AUCUNE écriture Firestore PAR sous-agent : le checkpoint est
 *    CONSOLIDÉ par l'appelant après la vague (règle d'or Task 106-fix,
 *    ~1 écriture/s par document) ;
 *  - un sous-agent en échec n'interrompt JAMAIS la vague (résultat
 *    "rejected" isolé — l'appelant décide de la tolérance) ;
 *  - journalisation SOMMAIRE (une ligne par vague, pas par item) via
 *    le canal io.log du rendu.
 */

import { mapWithConcurrency, type ConcurrencyOutcome } from "@/lib/video/concurrency";

/** Rôle d'une vague de sous-agents (journaux + télémétrie). */
export type VideoSubAgentRole =
  | "voice_sync"
  | "export_render"
  | "audio_preflight"
  | "asset_generation";

const ROLE_LABELS: Record<VideoSubAgentRole, string> = {
  voice_sync: "sous-agents de synchro voix",
  export_render: "sous-agents d'export",
  audio_preflight: "sous-agents de préflight audio",
  asset_generation: "sous-agents de génération",
};

export interface SubAgentWaveResult<R> {
  /** Résultats par item, dans l'ordre d'entrée (contrat mapWithConcurrency). */
  outcomes: ConcurrencyOutcome<R>[];
  /** Nombre de sous-agents ayant abouti. */
  fulfilled: number;
  /** Nombre de sous-agents en échec (isolés). */
  rejected: number;
  /** Nombre d'items non démarrés (budget temps épuisé). */
  skipped: number;
  /** Concurrence effective de la vague. */
  parallelism: number;
}

export interface RunSubAgentWaveOptions {
  /** Journal optionnel (canal io.log du job de rendu — une ligne par vague). */
  log?: (message: string) => Promise<void> | void;
  /** Consulté avant chaque démarrage (budget temps serverless). */
  shouldStart?: (index: number) => boolean;
}

/**
 * Déploie une vague de sous-agents sur les items d'une phase indépendante.
 * Retourne les résultats agrégés + compteurs — l'appelant consolide SON
 * checkpoint (jamais d'écriture Firestore depuis ce module).
 */
export async function runSubAgentWave<T, R>(
  role: VideoSubAgentRole,
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  options: RunSubAgentWaveOptions = {},
): Promise<SubAgentWaveResult<R>> {
  const parallelism = Math.max(1, Math.min(Math.floor(Number.isFinite(limit) ? limit : 1), Math.max(1, items.length)));
  const outcomes = await mapWithConcurrency(items, parallelism, worker, {
    ...(options.shouldStart ? { shouldStart: options.shouldStart } : {}),
  });
  const fulfilled = outcomes.filter((o) => o.status === "fulfilled").length;
  const rejected = outcomes.filter((o) => o.status === "rejected").length;
  const skipped = outcomes.filter((o) => o.status === "skipped").length;
  if (options.log) {
    await options.log(
      `${ROLE_LABELS[role]} : ${fulfilled}/${items.length} terminé(s) en ${parallelism} sous-agent(s) parallèle(s)${rejected > 0 ? `, ${rejected} échec(s) isolé(s)` : ""}${skipped > 0 ? `, ${skipped} reporté(s) (budget temps)` : ""}.`,
    );
  }
  return { outcomes, fulfilled, rejected, skipped, parallelism };
}

/**
 * Vrai si la vague justifie le déploiement de sous-agents (sinon exécution
 * directe single-thread inchangée — zéro overhead pour les petits lots).
 */
export function shouldDeploySubAgents(itemCount: number, min = 2): boolean {
  return itemCount >= min;
}
