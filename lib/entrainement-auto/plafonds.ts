import "server-only";

/**
 * PLAFONDS DE L'AUTO-APPRENTISSAGE — tous ajustables par variables d'env,
 * bornés par des valeurs saines (le VPS de production dispose de 2 Go de
 * RAM : aucun téléchargement massif, aucune boucle gourmande).
 *
 * Chaque plafond est appliqué RÉELLEMENT au moment de l'usage (téléchargement,
 * parsing, entraînement) — jamais cosmétique.
 */

export interface PlafondsAuto {
  /** Taille maximale d'un fichier téléchargé depuis un hub (octets). */
  parFichierOctets: number;
  /** Budget de téléchargement total par cycle (octets, décompté réellement). */
  totalParCycleOctets: number;
  /** Lignes maximales analysées par dataset (protection parseur). */
  maxLignesParDataset: number;
  /** Paires conversationnelles maximales extraites par dataset. */
  maxPairesParDataset: number;
  /** Échantillons d'intention maximaux extraits par dataset. */
  maxEchantillonsParDataset: number;
  /** Échantillons maximaux soumis à l'entraîneur supervisé par cycle. */
  maxEchantillonsParCycle: number;
  /** Datasets maximaux ingérés par cycle. */
  maxDatasetsParCycle: number;
  /** Datasets maximaux par objectif dans un même cycle (équilibre). */
  maxParObjectif: number;
}

/** Lit un entier d'env borné — valeur absente/ invalide → défaut. */
function entierEnv(valeur: string | undefined, defaut: number, min: number, max: number): number {
  const n = Number(valeur?.trim() ?? "");
  if (!Number.isFinite(n) || n <= 0) return defaut;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const MO = 1_048_576;

export function plafondsAuto(env: NodeJS.ProcessEnv = process.env): PlafondsAuto {
  return {
    parFichierOctets: entierEnv(env.AUTO_APPRENTISSAGE_MAX_FICHIER_MO, 6, 1, 50) * MO,
    totalParCycleOctets: entierEnv(env.AUTO_APPRENTISSAGE_MAX_TOTAL_MO, 24, 1, 200) * MO,
    maxLignesParDataset: entierEnv(env.AUTO_APPRENTISSAGE_MAX_LIGNES, 1200, 50, 10_000),
    maxPairesParDataset: entierEnv(env.AUTO_APPRENTISSAGE_MAX_PAIRES, 400, 10, 2_000),
    maxEchantillonsParDataset: entierEnv(env.AUTO_APPRENTISSAGE_MAX_ECHANTILLONS, 300, 10, 2_000),
    maxEchantillonsParCycle: entierEnv(env.AUTO_APPRENTISSAGE_MAX_ECHANTILLONS_CYCLE, 240, 10, 2_000),
    maxDatasetsParCycle: entierEnv(env.AUTO_APPRENTISSAGE_MAX_DATASETS, 4, 1, 12),
    maxParObjectif: 2,
  };
}

/** Intervalle entre deux cycles (ms) — AUTO_APPRENTISSAGE_INTERVALLE_MIN, borné 15 min → 24 h. */
export function intervalleAutoMs(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = entierEnv(env.AUTO_APPRENTISSAGE_INTERVALLE_MIN, 120, 15, 24 * 60);
  return minutes * 60_000;
}

/** Délai avant le premier cycle après le boot (ms) — borné 10 s → 10 min. */
export function delaiInitialAutoMs(env: NodeJS.ProcessEnv = process.env): number {
  const secondes = entierEnv(env.AUTO_APPRENTISSAGE_DELAI_S, 20, 10, 600);
  return secondes * 1000;
}
