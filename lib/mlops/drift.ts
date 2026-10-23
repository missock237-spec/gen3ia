import "server-only";

import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";

/**
 * DÉTECTION DE DÉRIVE (DRIFT) — score PSI (Population Stability Index)
 * entre une distribution de RÉFÉRENCE (celle de l'entraînement : répartition
 * des intentions du corpus) et une distribution OBSERVÉE en production
 * (comptages d'usage par intention/intention détectée).
 *
 * Seuils PSI conventionnels (cf. docs/mlops.md) :
 *   - psi <  0,1  → stable    (aucune action) ;
 *   - 0,1..0,25   → surveillance (à observer, promotion possible avec note) ;
 *   - psi >  0,25 → dérive    (porte du pipeline FERMÉE, quarantaine).
 *
 * Sources de données — adaptées à ce qui existe réellement : il n'y a PAS
 * encore de log d'interactions persisté côté production, ce module fournit
 * donc une INTERFACE PROPRE (DistributionComptages) + un accumulateur de
 * comptages par catégorie (intents/usage) exposant snapshot(), réutilisable
 * plus tard par l'endpoint métriques (découplé volontairement : aucun
 * import du moteur, aucune route ici). Le branchement futur est documenté
 * dans docs/mlops.md § « Branchement du collecteur ».
 *
 * Les comptages peuvent être PERSISTÉS (var/neural/stats/ — var/ hors git,
 * écriture atomique tmp→rename) pour survivre aux redémarrages PM2.
 */

/** Seuil sous lequel la distribution est considérée stable. */
export const SEUIL_PSI_STABLE = 0.1;

/** Seuil au-delà duquel la dérive est confirmée (porte fermée). */
export const SEUIL_PSI_SURVEILLANCE = 0.25;

/** Statut de dérive d'une distribution observée. */
export type StatutDerive = "stable" | "surveillance" | "derive";

/** Comptages par catégorie (intentions, usages…). Clé → nombre d'occurrences. */
export type DistributionComptages = Record<string, number>;

/** Catégorie de repli quand le cap de catégories est atteint. */
export const CATEGORIE_AUTRES = "__autres";

/** Chemin de persistance par défaut des comptages (var/ hors git). */
export const STATS_DERIVE_CHEMIN_DEFAUT = join(
  process.cwd(),
  "var",
  "neural",
  "stats",
  "derive-comptages.json",
);

/** Contribution d'une catégorie au score PSI. */
export interface ContributionCategorie {
  categorie: string;
  /** Proportion dans la distribution de RÉFÉRENCE (0..1). */
  reference: number;
  /** Proportion dans la distribution OBSERVÉE (0..1). */
  observe: number;
  /** Contribution de cette catégorie au PSI (toujours ≥ 0). */
  psi: number;
}

/** Score de dérive complet (somme des contributions + statut). */
export interface ScoreDerive {
  /** PSI global (0 = distributions identiques). */
  psi: number;
  statut: StatutDerive;
  /** Détail par catégorie (tri alphabétique, déterministe). */
  parCategorie: ContributionCategorie[];
  /** Nombre total d'échantillons de référence. */
  echantillonsReference: number;
  /** Nombre total d'échantillons observés. */
  echantillonsObserve: number;
}

/**
 * Epsilon de substitution pour les proportions nulles (convention PSI :
 * un bucket vide d'un seul côté ne doit pas produire log(0) — on lui
 * substitue une masse négligeable ; la contribution reste finie et
 * pénalise la catégorie apparue/disparue).
 */
const EPSILON = 1e-6;

/** Classe un PSI selon les seuils (< 0,1 stable / 0,1–0,25 surveillance / > 0,25 dérive). */
export function statutPsi(psi: number): StatutDerive {
  if (psi > SEUIL_PSI_SURVEILLANCE) return "derive";
  if (psi >= SEUIL_PSI_STABLE) return "surveillance";
  return "stable";
}

function sommeComptages(distribution: DistributionComptages): number {
  let total = 0;
  for (const valeur of Object.values(distribution)) {
    if (typeof valeur === "number" && Number.isFinite(valeur) && valeur > 0) {
      total += valeur;
    }
  }
  return total;
}

/**
 * Calcule le score PSI entre la distribution de référence (entraînement)
 * et la distribution observée (production). Déterministe : les catégories
 * sont l'UNION des clés des deux côtés, triées alphabétiquement.
 *
 * Sans données d'un côté (0 échantillon), retourne psi = 0 / stable :
 * PAS DE PREUVE de dérive sans observation (documenté honnête — un
 * accumulateur vide ne doit jamais bloquer la porte du pipeline).
 */
export function calculerScorePsi(
  reference: DistributionComptages,
  observe: DistributionComptages,
): ScoreDerive {
  const totalReference = sommeComptages(reference);
  const totalObserve = sommeComptages(observe);

  if (totalReference <= 0 || totalObserve <= 0) {
    return {
      psi: 0,
      statut: "stable",
      parCategorie: [],
      echantillonsReference: totalReference,
      echantillonsObserve: totalObserve,
    };
  }

  const categories = [
    ...new Set([...Object.keys(reference), ...Object.keys(observe)]),
  ].sort();

  let psi = 0;
  const parCategorie: ContributionCategorie[] = [];
  for (const categorie of categories) {
    const brutReference = (reference[categorie] ?? 0) / totalReference;
    const brutObserve = (observe[categorie] ?? 0) / totalObserve;
    // (p − q) × ln(p / q) — toujours ≥ 0 ((p−q) et ln(p/q) de même signe).
    const p = brutReference > 0 ? brutReference : EPSILON;
    const q = brutObserve > 0 ? brutObserve : EPSILON;
    const contribution = (p - q) * Math.log(p / q);
    psi += contribution;
    parCategorie.push({
      categorie,
      reference: brutReference,
      observe: brutObserve,
      psi: contribution,
    });
  }

  return {
    psi,
    statut: statutPsi(psi),
    parCategorie,
    echantillonsReference: totalReference,
    echantillonsObserve: totalObserve,
  };
}

/* ------------------------------------------------------------------ */
/* Accumulateur de comptages (intents / usage)                          */
/* ------------------------------------------------------------------ */

/** Options de l'accumulateur de dérive. */
export interface OptionsAccumulateur {
  /**
   * Chemin de persistance (défaut var/neural/stats/derive-comptages.json).
   * Passer null désactive la persistance (accumulateur purement mémoire,
   * utile aux tests et aux usages éphémères).
   */
  chemin?: string | null;
  /**
   * Nombre maximal de catégories suivies (garde-fou mémoire) : au-delà,
   * les nouvelles catégories tombent dans « __autres » (regroupement
   * standard des petits buckets en PSI). Défaut 500.
   */
  capCategories?: number;
}

/**
 * ACCUMULATEUR DE COMPTAGES PAR CATÉGORIE — la source d'usage de la dérive.
 *
 * Branchement prévu (découplé, cf. docs/mlops.md) : le runtime neuronal
 * connaît l'intention détectée de chaque requête (predireIntention /
 * engine) — un futur point d'appel appellera enregistrer(intention) par
 * requête ; l'endpoint métriques (autre agent) lira snapshot(). En attendant,
 * l'accumulateur est neutre : vide = aucune observation = psi 0.
 */
export class AccumulateurDerive {
  private readonly comptages: DistributionComptages = {};
  private readonly capCategories: number;
  private readonly chemin: string | null;
  private avertiCap = false;

  constructor(options: OptionsAccumulateur = {}) {
    this.capCategories = Math.max(1, options.capCategories ?? 500);
    this.chemin =
      options.chemin === undefined ? STATS_DERIVE_CHEMIN_DEFAUT : options.chemin;
  }

  /**
   * Enregistre une occurrence (ou un poids explicite) pour une catégorie.
   * Garde douce : catégorie vide ou poids non fini ≤ 0 ignorés silencieusement
   * (un télémètre ne doit jamais faire tomber une requête).
   */
  enregistrer(categorie: string, poids = 1): void {
    if (!categorie || !Number.isFinite(poids) || poids <= 0) return;
    let cible = categorie;
    if (
      !(categorie in this.comptages) &&
      Object.keys(this.comptages).length >= this.capCategories
    ) {
      cible = CATEGORIE_AUTRES;
      if (!this.avertiCap) {
        this.avertiCap = true;
        console.warn(
          `[MLOPS-DRIFT] Cap de ${this.capCategories} catégories atteint — les nouvelles catégories sont regroupées dans « ${CATEGORIE_AUTRES} ».`,
        );
      }
    }
    this.comptages[cible] = (this.comptages[cible] ?? 0) + poids;
  }

  /**
   * Copie défensive des comptages courants — le format exact exposé à
   * l'endpoint métriques futur (découplé de la représentation interne).
   */
  snapshot(): DistributionComptages {
    return { ...this.comptages };
  }

  /** Nombre total d'occurrences enregistrées (toutes catégories). */
  total(): number {
    return sommeComptages(this.comptages);
  }

  /** Nombre de catégories suivies. */
  taille(): number {
    return Object.keys(this.comptages).length;
  }

  /** Fusionne des comptages externes (reprise après redémarrage). */
  fusionner(comptages: DistributionComptages): void {
    for (const [categorie, valeur] of Object.entries(comptages)) {
      if (
        typeof valeur === "number" &&
        Number.isFinite(valeur) &&
        valeur > 0
      ) {
        this.enregistrer(categorie, valeur);
      }
    }
  }

  /** Vide l'accumulateur (nouvelle fenêtre d'observation). */
  reinitialiser(): void {
    for (const categorie of Object.keys(this.comptages)) {
      delete this.comptages[categorie];
    }
    this.avertiCap = false;
  }

  /**
   * PERSISTE les comptages (écriture ATOMIQUE tmp→rename, échec NON FATAL —
   * même convention que la persistance du cerveau). @returns true si OK.
   */
  async sauvegarder(): Promise<boolean> {
    if (this.chemin === null) return true; // persistance désactivée : no-op
    const tmp = `${this.chemin}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsp.mkdir(join(this.chemin, ".."), { recursive: true });
      const instantane = {
        version: 1,
        sauvegardeLe: new Date().toISOString(),
        comptages: this.comptages,
      };
      await fsp.writeFile(tmp, JSON.stringify(instantane), "utf8");
      await fsp.rename(tmp, this.chemin);
      return true;
    } catch (erreur: unknown) {
      console.warn(
        "[MLOPS-DRIFT] Sauvegarde des comptages impossible (non fatal) :",
        erreur instanceof Error ? erreur.message : String(erreur),
      );
      try {
        await fsp.unlink(tmp);
      } catch {
        // Déjà parti ou jamais créé.
      }
      return false;
    }
  }

  /**
   * Charge (ou crée) un accumulateur depuis le disque. Fichier absent,
   * corrompu ou format inconnu → accumulateur VIDE honnête (jamais
   * d'exception remontée au boot) — même convention que lireEtatAuto.
   */
  static async charger(
    options: OptionsAccumulateur = {},
  ): Promise<AccumulateurDerive> {
    const accumulateur = new AccumulateurDerive(options);
    const chemin =
      options.chemin === undefined ? STATS_DERIVE_CHEMIN_DEFAUT : options.chemin;
    if (chemin === null) return accumulateur;
    try {
      const brut = JSON.parse(
        await fsp.readFile(chemin, "utf8"),
      ) as { version?: number; comptages?: DistributionComptages } | null;
      if (
        brut !== null &&
        typeof brut === "object" &&
        brut.version === 1 &&
        typeof brut.comptages === "object" &&
        brut.comptages !== null
      ) {
        accumulateur.fusionner(brut.comptages);
      }
    } catch {
      // Absent ou corrompu : accumulateur vide (comportement par défaut).
    }
    return accumulateur;
  }
}

/* ------------------------------------------------------------------ */
/* Singleton HMR-safe (réutilisable par l'endpoint métriques futur)     */
/* ------------------------------------------------------------------ */

const globalAvecDerive = globalThis as typeof globalThis & {
  __gen3AccumulateurDerive?: AccumulateurDerive;
};

/**
 * Singleton process-wide (résiste au HMR comme le runtime neuronal) :
 * point d'entrée unique pour alimenter et lire l'usage par intention.
 * DÉCOUPLÉ volontairement — ni le moteur ni aucune route ne l'importent
 * encore (branchement futur documenté dans docs/mlops.md).
 */
export function accumulateurDeriveGlobal(): AccumulateurDerive {
  return (globalAvecDerive.__gen3AccumulateurDerive ??= new AccumulateurDerive());
}
