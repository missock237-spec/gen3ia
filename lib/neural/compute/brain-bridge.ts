/**
 * BRAIN BRIDGE — l'interface UNIQUE entre le cerveau central Gen3ia et le
 * moteur de calcul (mission Phase 5) : le cerveau analyse la tâche, estime
 * les ressources, demande le calcul au ComputeManager, lit les capacités
 * et les métriques, et CHANGE le profil énergétique. Aucun moteur ne
 * décide plus en parallèle — les exécuteurs sont injectés par le cerveau.
 * (Aucune dépendance inversée : compute/ n'importe pas le cerveau.)
 */

import { ComputeManager, obtenirComputeManager } from "./compute-manager";
import { routerTache, type PlanRoutage } from "./compute-router";
import type { CapacitesCpu, CapacitesMateriel, DecisionCalcul, ProfilEnergie, TacheCalcul } from "./compute-types";
import { detecterCapacitesCpu } from "./hardware-detector";
import type { InstantaneMetrics } from "./compute-metrics";

/** Vue complète que le cerveau lit avant de décider (observabilité). */
export interface VueCalculCerveau {
  capacites: CapacitesMateriel;
  capacitesCpu: CapacitesCpu;
  profil: ProfilEnergie;
  metrics: InstantaneMetrics;
}

/** Demande de calcul du cerveau (mission Phase 5 — interface commune). */
export interface DemandeCalculCerveau<T> {
  tache: TacheCalcul;
  executeurs: {
    cpu: (tache: TacheCalcul) => Promise<T>;
    webgpu?: (tache: TacheCalcul) => Promise<T>;
    verifier?: (resultat: T) => boolean;
  };
}

export interface ReponseCalculCerveau<T> {
  resultat: T;
  decision: DecisionCalcul;
  moteurEffectif: "cpu" | "webgpu" | "hybride";
  fallback: boolean;
  raisonFallback?: string;
  metrics: InstantaneMetrics;
}

/**
 * Le cerveau demande un calcul : décision MOTIVÉE → exécution (fallback
 * systématique) → métriques. Ne lève jamais si les exécuteurs ne lèvent pas.
 */
export async function demanderCalcul<T>(
  demande: DemandeCalculCerveau<T>,
  options: { profil?: ProfilEnergie } = {},
): Promise<ReponseCalculCerveau<T>> {
  const manager = obtenirComputeManager({ profil: options.profil });
  const res = await manager.executer<T>(demande.tache, demande.executeurs, { profil: options.profil });
  return {
    resultat: res.resultat,
    decision: res.decision,
    moteurEffectif: res.moteurEffectif,
    fallback: res.fallback,
    raisonFallback: res.raisonFallback,
    metrics: res.metrics,
  };
}

/** Le cerveau lit la vue complète (capacités CPU+GPU, profil, métriques). */
export async function lireVueCalcul(): Promise<VueCalculCerveau> {
  const manager: ComputeManager = obtenirComputeManager();
  return {
    capacites: await manager.capacites(),
    capacitesCpu: detecterCapacitesCpu(),
    profil: profilActif(),
    metrics: manager.metrics(),
  };
}

/** Le cerveau change le profil énergétique (ECO…SERVER). */
export function definirProfilCerveau(profil: ProfilEnergie): void {
  const g = globalThis as typeof globalThis & { __gen3iaProfilEnergie?: ProfilEnergie };
  g.__gen3iaProfilEnergie = profil;
}

export function profilActif(): ProfilEnergie {
  const g = globalThis as typeof globalThis & { __gen3iaProfilEnergie?: ProfilEnergie };
  return g.__gen3iaProfilEnergie ?? "BALANCED";
}

/** Plan de routage consultatif (le cerveau peut l'inspecter avant exécution). */
export function planifierTache(tache: TacheCalcul, capacites: CapacitesMateriel, profil?: ProfilEnergie): PlanRoutage {
  return routerTache(tache, capacites, profil ?? profilActif());
}
