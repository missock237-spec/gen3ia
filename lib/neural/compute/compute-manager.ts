/**
 * COMPUTE MANAGER — le gestionnaire matériel CENTRAL (mission Phase 2) :
 * le cerveau central (ou toute surface appelante) lui remet une tâche ;
 * il décide via la politique (règle fondamentale : jamais WebGPU « parce
 * que dispo »), exécute via les exécuteurs fournis, applique le fallback
 * CPU systématique, mesure et conserve les métriques réelles.
 *
 * Les exécuteurs sont INJECTÉS (exécutants — mission Phase 5) : CPU
 * toujours présent, GPU optionnel (moteur unifié Phase 3, moteurs ondes
 * existants réutilisés sans duplication).
 */

import { detecterCapacites } from "./hardware-detector";
import { evaluerTache } from "./compute-policy";
import { avecFallbackCpu, type ResultatAvecFallback } from "./compute-fallback";
import { RegistreMetrics, type InstantaneMetrics } from "./compute-metrics";
import type { CapacitesMateriel, DecisionCalcul, MesureCalcul, ProfilEnergie, TacheCalcul } from "./compute-types";

export interface ExecuteursCalcul<T> {
  /** Exécuteur CPU — OBLIGATOIRE (fallback systématique). */
  cpu: (tache: TacheCalcul) => Promise<T>;
  /** Exécuteur GPU — optionnel (moteur unifié / moteurs ondes existants). */
  webgpu?: (tache: TacheCalcul) => Promise<T>;
  /** Vérification indépendante du résultat GPU (mission Phase 9/10). */
  verifier?: (resultat: T) => boolean;
}

export interface ResultatExecution<T> extends ResultatAvecFallback<T> {
  decision: DecisionCalcul;
  capacites: CapacitesMateriel;
  metrics: InstantaneMetrics;
}

export interface OptionsManager {
  profil?: ProfilEnergie;
  /** Sonde injectable pour les tests (capacités simulées honnêtement). */
  capacitesSurchargées?: CapacitesMateriel;
}

const globalAvecManager = globalThis as typeof globalThis & {
  __gen3iaComputeMetrics?: RegistreMetrics;
};

function metricsGlobales(): RegistreMetrics {
  if (!globalAvecManager.__gen3iaComputeMetrics) globalAvecManager.__gen3iaComputeMetrics = new RegistreMetrics();
  return globalAvecManager.__gen3iaComputeMetrics;
}

export class ComputeManager {
  private readonly profil: ProfilEnergie;

  constructor(options: OptionsManager = {}) {
    this.profil = options.profil ?? "BALANCED";
  }

  /**
   * Décide (politique) puis exécute (fallback systématique) puis mesure.
   * Ne lève jamais si les exécuteurs ne lèvent pas.
   */
  async executer<T>(tache: TacheCalcul, executeurs: ExecuteursCalcul<T>, options: OptionsManager = {}): Promise<ResultatExecution<T>> {
    const debut = Date.now();
    const capacites = options.capacitesSurchargées ?? (await detecterCapacites());
    const decision = evaluerTache(tache, capacites, options.profil ?? this.profil);

    const avecGpu = decision.moteur !== "cpu" && typeof executeurs.webgpu === "function";
    const resultat = await avecFallbackCpu<T>({
      moteurDemande: decision.moteur,
      executerGpu: avecGpu ? () => executeurs.webgpu!(tache) : undefined,
      executerCpu: () => executeurs.cpu(tache),
      verifierResultat: executeurs.verifier,
    });

    const dureeMs = Date.now() - debut;
    // Énergie : estimation relative explicite (aucun compteur matériel
    // exposé dans l'environnement actuel — nature "estimee", jamais "J").
    const mesure: MesureCalcul = {
      nomTache: tache.nom,
      moteur: resultat.moteurEffectif,
      moteurDemande: decision.moteur,
      dureeMs,
      fallback: resultat.fallback,
      raisonFallback: resultat.raisonFallback,
      energie: { valeur: decision.facteurs.coutEstimeGpu < decision.facteurs.coutEstimeCpu && resultat.moteurEffectif !== "cpu" ? decision.facteurs.coutEstimeGpu : decision.facteurs.coutEstimeCpu, unite: "unite-relative", nature: "estimee" },
    };
    metricsGlobales().enregistrer(mesure);

    return { ...resultat, decision, capacites, metrics: metricsGlobales().instantane() };
  }

  /** Capacités réelles (dashboard Phase 11). */
  async capacites(): Promise<CapacitesMateriel> {
    return detecterCapacites();
  }

  /** Instantané des métriques (dashboard Phase 11). */
  metrics(): InstantaneMetrics {
    return metricsGlobales().instantane();
  }

  /** Réinitialise les métriques (tests). */
  reinitialiserMetrics(): void {
    metricsGlobales().reinitialiser();
  }
}

/** Singleton process-local (idempotent). */
export function obtenirComputeManager(options: OptionsManager = {}): ComputeManager {
  const g = globalThis as typeof globalThis & { __gen3iaComputeManager?: ComputeManager };
  if (!g.__gen3iaComputeManager) g.__gen3iaComputeManager = new ComputeManager(options);
  return g.__gen3iaComputeManager;
}
