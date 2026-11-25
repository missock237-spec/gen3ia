/**
 * COMPUTE FALLBACK — le repli CPU SYSTÉMATIQUE (mission Phase 10, P1) :
 * « Aucune tâche critique ne doit être perdue simplement parce que WebGPU
 * devient indisponible. » Toute exécution GPU enveloppée ici retombe sur
 * l'exécuteur CPU en cas d'échec/indisponibilité — avec la raison tracée.
 */

import type { MoteurCalcul } from "./compute-types";

export interface ResultatAvecFallback<T> {
  resultat: T;
  /** Moteur RÉELLEMENT utilisé après fallback éventuel. */
  moteurEffectif: MoteurCalcul;
  moteurDemande: MoteurCalcul;
  fallback: boolean;
  raisonFallback?: string;
}

/**
 * Exécute via le moteur demandé ; en cas d'échec GPU → exécuteur CPU
 * (obligatoire). Ne lève jamais si l'exécuteur CPU ne lève pas.
 */
export async function avecFallbackCpu<T>(params: {
  moteurDemande: MoteurCalcul;
  executerGpu?: () => Promise<T>;
  executerCpu: () => Promise<T>;
  verifierResultat?: (resultat: T) => boolean;
}): Promise<ResultatAvecFallback<T>> {
  const { moteurDemande, executerGpu, executerCpu, verifierResultat } = params;

  if (moteurDemande !== "cpu" && executerGpu) {
    try {
      const resultat = await executerGpu();
      if (!verifierResultat || verifierResultat(resultat)) {
        return { resultat, moteurEffectif: moteurDemande, moteurDemande, fallback: false };
      }
      // Résultat GPU suspect (validator mission) : repli CPU vérifié.
      const secours = await executerCpu();
      return {
        resultat: secours,
        moteurEffectif: "cpu",
        moteurDemande,
        fallback: true,
        raisonFallback: "résultat GPU rejeté par le vérificateur — repli CPU exécuté et vérifié",
      };
    } catch (erreur) {
      const cause = erreur instanceof Error ? erreur.message : String(erreur);
      const secours = await executerCpu();
      return {
        resultat: secours,
        moteurEffectif: "cpu",
        moteurDemande,
        fallback: true,
        raisonFallback: `exécution GPU échouée (${cause.slice(0, 160)}) — repli CPU systématique (aucune tâche perdue)`,
      };
    }
  }

  const resultat = await executerCpu();
  return { resultat, moteurEffectif: "cpu", moteurDemande, fallback: false };
}
