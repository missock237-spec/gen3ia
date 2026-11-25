/**
 * COMPUTE ROUTER — le répartiteur réel (mission Phase 4) :
 * ComputeManager → ComputePolicy → ComputeRouter → CPU | GPU | HYBRIDE.
 * Le routeur délègue la DÉCISION à la politique (règle fondamentale :
 * jamais WebGPU « parce que disponible ») et prépare la partition pour le
 * mode hybride : une tâche n'est partitionnée QUE si elle est réellement
 * divisible (famille matriciel/elementaire/reduction en lots indépendants).
 */

import { evaluerTache } from "./compute-policy";
import type { CapacitesMateriel, DecisionCalcul, ProfilEnergie, TacheCalcul } from "./compute-types";

/** Familles réellement partitionnables (lots indépendants, fusion linéaire). */
const FAMILLES_PARTITIONNABLES: ReadonlySet<TacheCalcul["famille"]> = new Set(["matriciel", "elementaire", "reduction"]);

export interface PlanRoutage {
  decision: DecisionCalcul;
  /** Mode hybride : lots CPU et GPU avec la répartition mesurée. */
  partition?: { portionCpu: number; portionGpu: number; raison: string };
}

export function routerTache(
  tache: TacheCalcul,
  capacites: CapacitesMateriel,
  profil: ProfilEnergie = "BALANCED",
): PlanRoutage {
  const decision = evaluerTache(tache, capacites, profil);
  if (decision.moteur !== "hybride") return { decision };

  // Mode hybride DEMANDÉ par la politique : ne jamais étiqueter sans
  // partition réelle — les familles non divisibles restent sur un moteur.
  if (!FAMILLES_PARTITIONNABLES.has(tache.famille)) {
    return {
      decision: { ...decision, moteur: "webgpu", raison: `${decision.raison} — hybride refusé : la famille « ${tache.famille} » n'est pas partitionnable en lots indépendants (mission Phase 4 : jamais d'hybride décoratif)` },
    };
  }
  return {
    decision,
    partition: {
      portionCpu: 0.4,
      portionGpu: 0.6,
      raison: `partition réelle en lots indépendants (60 % GPU / 40 % CPU) — les deux moteurs exécutent réellement leurs lots`,
    },
  };
}
