/**
 * HEALTH-CHECK DU GEN3IA AUTONOMOUS CORE (Phase 1).
 *
 * Instantané de santé du core ET de son pipeline cognitif — le premier
 * health qui vérifie RÉELLEMENT le cerveau (l'audit Phase 0 a montré que
 * /api/public/health ne vérifie rien). Bouché sur le tableau de supervision
 * de la Phase 12 (Collecteur actif, cycles réalisés, tâches, erreurs…).
 */

import type { EtatModule, StatutTache } from "../core/types";

/** Instantané de santé d'un module (mesures réelles). */
export interface SanteModule {
  id: string;
  nom: string;
  statut: EtatModule["statut"];
  suspenduJusquA?: string;
  dernierTickLe?: string;
  dernierSuccesLe?: string;
  ticks: number;
  succes: number;
  echecs: number;
  echecsConsecutifs: number;
  /** Taux d'erreur réel (0..1). */
  tauxErreur: number;
  dernierMessage?: string;
  dernieresErreurs: string[];
}

/** Instantané de santé du core complet. */
export interface SanteCoeur {
  /** ok | degrade | hors_service (mesuré, jamais déclaré). */
  statut: "ok" | "degrade" | "hors_service";
  cycle: number;
  modulesEnregistres: number;
  modulesActifs: number;
  modulesSuspendus: number;
  taches: Record<StatutTache, number>;
  modules: SanteModule[];
  demarreLe?: string;
  persisteLe?: string;
}

/** Construit l'instantané de santé du core (aucune invention). */
export function instantaneSante(entrees: {
  cycle: number;
  etats: EtatModule[];
  tachesParStatut: Record<StatutTache, number>;
  demarreLe?: string;
  persisteLe?: string;
}): SanteCoeur {
  const modules: SanteModule[] = entrees.etats.map((e) => ({
    id: e.id,
    nom: e.nom,
    statut: e.statut,
    suspenduJusquA: e.suspenduJusquA,
    dernierTickLe: e.dernierTickLe,
    dernierSuccesLe: e.dernierSuccesLe,
    ticks: e.ticks,
    succes: e.succes,
    echecs: e.echecs,
    echecsConsecutifs: e.echecsConsecutifs,
    tauxErreur: e.ticks > 0 ? Math.min(1, e.echecs / e.ticks) : 0,
    dernierMessage: e.dernierMessage,
    dernieresErreurs: [...e.dernieresErreurs],
  }));
  const suspendus = modules.filter((m) => m.statut === "suspendu").length;
  const actifs = modules.length - suspendus;
  // Honnête : un module en échec consécutif (même pas encore suspendu) rend
  // le core "degrade" — la santé reflète le réel, pas un optimisme par défaut.
  const enDifficulte = modules.filter((m) => m.echecsConsecutifs > 0).length;
  const statut: SanteCoeur["statut"] =
    modules.length === 0
      ? "hors_service"
      : suspendus > 0 || enDifficulte > 0
        ? "degrade"
        : "ok";
  return {
    statut,
    cycle: entrees.cycle,
    modulesEnregistres: modules.length,
    modulesActifs: actifs,
    modulesSuspendus: suspendus,
    taches: entrees.tachesParStatut,
    modules,
    demarreLe: entrees.demarreLe,
    persisteLe: entrees.persisteLe,
  };
}
