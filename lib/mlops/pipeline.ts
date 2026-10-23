import "server-only";

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { executionLogger } from "@/lib/observability/logger";

import {
  RegistreModeles,
  empreinteArtefact,
  type ArtefactModele,
  type CanalModele,
  type DatasetModele,
  type ManifestModele,
  type MetriqueModele,
} from "./registry";
import {
  calculerScorePsi,
  SEUIL_PSI_SURVEILLANCE,
  type DistributionComptages,
  type ScoreDerive,
} from "./drift";
import {
  buildDatasetFromCorpus,
  loadCorpusFromPublic,
  SEED_EXAMPLES,
} from "../neural/training/dataset";

/**
 * PIPELINE D'ENTRAÎNEMENT À PORTE D'ÉVALUATION (Pilier 2 — MLOps ;
 * transposition locale du « training pipeline » Vertex AI — cf.
 * docs/mlops.md pour la migration Phase 3).
 *
 * 4 étapes IDEMPOTENTES, rapport exécutable en sortie :
 *   (a) INGESTION     — stats RÉELLES du corpus d'entraînement existant
 *                       (lib/neural/training/dataset.ts : public/llms*.txt
 *                       + amorçage canonique SEED_EXAMPLES) ; la
 *                       distribution par intention sert de RÉFÉRENCE au
 *                       score de dérive ;
 *   (b) ENTRAÎNEMENT  — délégation à un mécanisme INJECTABLE ; l'adaptateur
 *                       par défaut (creerAdaptateurNeuralLocal) délègue au
 *                       job d'entraînement existant (lancerEntrainement →
 *                       NeuralTrainer sur le cerveau singleton) ;
 *   (c) ÉVALUATION    — métriques du rapport d'entraînement comparées à la
 *                       BASELINE = manifeste de production courant du
 *                       registre, + score de dérive PSI (référence (a) vs
 *                       usage observé) ;
 *   (d) PORTE         — promotion en production SI toutes les métriques
 *                       passent ET si la dérive est acceptable ; SINON la
 *                       version est enregistrée en canal « experimental »
 *                       (quarantaine) avec la raison loggée.
 *
 * IDEMPOTENCE : une version déjà enregistrée n'est JAMAIS retravaillée
 * (pas de re-entraînement, pas de réécriture d'historique) — la porte est
 * réévaluée avec l'état courant (baseline + dérive) : une version
 * quarantainée peut donc être PROMUE plus tard si l'usage redevient
 * conforme, sans relancer d'entraînement.
 *
 * DÉCOUPLAGE : ce module n'importe PAS le runtime neuronal (import dynamique
 * réservé à l'adaptateur local exécuté) et ne touche à aucune route
 * /api/training existante. Les binaires ne transitent jamais par le
 * pipeline : seule leur empreinte (sha256) est enregistrée.
 */

/* ------------------------------------------------------------------ */
/* Artefacts de référence (chemins, jamais les binaires)                */
/* ------------------------------------------------------------------ */

/**
 * Artefact v2 de l'installation — MÊME chemin que CORTEX_V2_PATH de
 * lib/neural/runtime.ts, dupliqué volontairement : importer le runtime
 * construirait le cerveau complet, ce que le pipeline ne doit jamais faire.
 */
const CORTEX_V2_LOCAL = join(process.cwd(), "var", "neural", "cortex-v2.bin");
/** Artefact PRÉ-ENTRAÎNÉ livré (CORTEX_V2_PRETRAIN_PATH côté runtime). */
const CORTEX_V2_PRETRAIN = join(
  process.cwd(),
  "assets",
  "neural-pretrained",
  "cortex-v2.bin",
);

/* ------------------------------------------------------------------ */
/* Adaptateur d'entraînement (découplage du mécanisme réel)             */
/* ------------------------------------------------------------------ */

/** Contexte transmis au mécanisme d'entraînement injectable. */
export interface ContexteEntrainement {
  modelId: string;
  version: string;
  /** Nombre total d'échantillons de la phase d'ingestion. */
  echantillons: number;
  /** Hyperparamètres demandés (le mécanisme peut en appliquer d'autres). */
  hyperparams: Record<string, unknown>;
}

/** Résultat d'un mécanisme d'entraînement réel (métriques mesurées). */
export interface ResultatEntrainement {
  /** Métriques MESURÉES (ex. accuracy_test, accuracy_train). */
  metriques: MetriqueModele[];
  /** Hyperparamètres effectivement appliqués. */
  hyperparams: Record<string, unknown>;
  /** Identifiant du job/mécanisme, si applicable. */
  jobId?: string;
}

/**
 * Adaptateur d'entraînement : TOUT mécanisme réel (job neuronal local,
 * worker GPU via lib/training, futur Vertex AI Pipeline) s'adapte à cette
 * signature — le pipeline ne connaît que ce contrat.
 */
export type AdaptateurEntrainement = (
  contexte: ContexteEntrainement,
) => Promise<ResultatEntrainement>;

/** Options de l'adaptateur par défaut (mécanisme neuronal in-process). */
export interface OptionsAdaptateurNeuralLocal {
  /** Époques (défaut du job : 4). */
  epochs?: number;
  /** Cap d'échantillons par label (défaut du job : 120). */
  maxParLabel?: number;
  /** Cap total d'échantillons corpus (défaut du job : 2500). */
  maxTotal?: number;
  /** Délai d'attente du job asynchrone (défaut 15 min). */
  timeoutMs?: number;
}

/**
 * Adaptateur par défaut : délègue au mécanisme d'entraînement EXISTANT
 * (lancerEntrainement de lib/neural/training/job.ts — NeuralTrainer sur le
 * cerveau singleton, progression chunkée) et traduit son TrainingReport en
 * métriques de pipeline. Import DYNAMIQUE : le runtime neuronal n'est
 * construit que si cet adaptateur est réellement exécuté.
 *
 * Le branchement « training-worker » (GPU distant, TRAINING_WORKER_URL)
 * s'écrit comme un AUTRE AdaptateurEntrainement — aucune modification du
 * pipeline nécessaire (cf. docs/mlops.md § Branchements futurs).
 */
export function creerAdaptateurNeuralLocal(
  options: OptionsAdaptateurNeuralLocal = {},
): AdaptateurEntrainement {
  // `_contexte` : le job neuronal local lit directement le corpus du dépôt
  // (caps passés à la fabrique) — le contexte du pipeline n'y sert pas,
  // la signature reste celle du contrat AdaptateurEntrainement.
  return async (_contexte) => {
    const { lancerEntrainement, getDernierJob } = await import(
      "../neural/training/job"
    );
    const job = lancerEntrainement({
      epochs: options.epochs,
      maxParLabel: options.maxParLabel,
      maxTotal: options.maxTotal,
    });

    // Le job est asynchrone (retour immédiat) : polling borné du statut.
    const debut = Date.now();
    const timeoutMs = options.timeoutMs ?? 15 * 60_000;
    let final = getDernierJob();
    while (
      Date.now() - debut < timeoutMs &&
      (!final || final.id !== job.id || final.status === "en_cours")
    ) {
      await new Promise((resoudre) => setTimeout(resoudre, 250));
      final = getDernierJob();
    }

    if (!final || final.id !== job.id) {
      throw new Error(
        "Job d'entraînement neuronal introuvable après lancement (dérive d'état inattendue).",
      );
    }
    if (final.status !== "termine" || !final.rapport) {
      throw new Error(
        final.erreur ??
          "Entraînement neuronal non terminé dans le délai imparti (timeout).",
      );
    }
    return {
      metriques: [
        { nom: "accuracy_test", valeur: final.rapport.accuracyTest },
        { nom: "accuracy_train", valeur: final.rapport.accuracyTrain },
      ],
      hyperparams: {
        epochs: final.rapport.epochs,
        echantillonsEntraines: final.rapport.samples,
        dureeMs: final.rapport.dureeMs,
      },
      jobId: final.id,
    };
  };
}

/* ------------------------------------------------------------------ */
/* Étapes et rapport exécutable                                         */
/* ------------------------------------------------------------------ */

/** Étape (a) — ingestion : stats réelles du corpus d'entraînement. */
export interface EtapeIngestion {
  ok: boolean;
  erreur?: string;
  /** Empreinte du corpus brut (identité immuable du jeu d'entraînement). */
  corpusSha256: string | null;
  /** Chemins de corpus explorés (public/llms*.txt). */
  corpusChemins: string[];
  echantillonsCorpus: number;
  echantillonsAmorcage: number;
  /** Distribution par intention = RÉFÉRENCE du score de dérive. */
  distribution: DistributionComptages;
  datasets: DatasetModele[];
  dureeMs: number;
}

/** Étape (b) — entraînement délégué + empreinte de l'artefact produit. */
export interface EtapeEntrainement {
  /** exécuté | reprise (données relues du manifeste) | echec. */
  statut: "execute" | "reprise" | "echec";
  metriques: MetriqueModele[];
  hyperparams: Record<string, unknown>;
  jobId?: string;
  artefact?: ArtefactModele;
  erreur?: string;
  dureeMs: number;
}

/** Étape (c) — évaluation : comparaison à la baseline + dérive. */
export interface EtapeEvaluation {
  /** Version de production comparée (null = première version). */
  baselineVersion: string | null;
  comparaisons: ComparaisonMetrique[];
  derive: ScoreDerive;
  dureeMs: number;
}

/** Comparaison d'une métrique candidate à la baseline / son plancher. */
export interface ComparaisonMetrique {
  nom: string;
  valeur: number;
  /** Valeur de la même métrique sur la baseline (si existante). */
  baseline?: number;
  seuilMin?: number;
  statut: "ok" | "insuffisant";
  /** Motif FR du refus (statut insuffisant). */
  motif?: string;
}

/** Étape (d) — porte conditionnelle. */
export interface EtapePorte {
  decision: "promotion" | "quarantaine";
  /** Raisons FR de la quarantaine (vide si promotion). */
  raisons: string[];
  /** Version du manifeste enregistré (null = rien enregistré). */
  manifestVersion: string | null;
  /** Canal final du manifeste (null = rien enregistré). */
  canalFinal: CanalModele | null;
}

/** RAPPORT EXÉCUTABLE du pipeline (JSON-serialisable tel quel). */
export interface RapportPipeline {
  modelId: string;
  version: string;
  demarreLe: string;
  termineLe: string;
  /** true = version déjà enregistrée : porte réévaluée, pas de re-travail. */
  reprise: boolean;
  decision: "promotion" | "quarantaine";
  raisons: string[];
  etapes: {
    ingestion: EtapeIngestion;
    entrainement: EtapeEntrainement;
    evaluation: EtapeEvaluation;
    porte: EtapePorte;
  };
  /** Manifeste enregistré (experimental ou production) — null si échec. */
  manifest: ManifestModele | null;
}

/** Options d'exécution du pipeline. */
export interface OptionsPipeline {
  modelId: string;
  /** Version cible (X.Y.Z ou AAAAMMJJTHHMMSSZ — validée par le registre). */
  version: string;
  /** Auteur du manifeste (défaut « pipeline-mlops »). */
  auteur?: string;
  /** Parent explicite du lignage (défaut : baseline production courante). */
  parentVersion?: string;
  /** Hyperparamètres demandés (fusionnés avec ceux du mécanisme réel). */
  hyperparams?: Record<string, unknown>;
  /** Registre injectable (défaut : var/neural/registry). */
  registre?: RegistreModeles;
  /** Mécanisme d'entraînement injectable (défaut : adaptateur local). */
  adaptateur?: AdaptateurEntrainement;
  /** Distribution observée (défaut : aucune → psi 0, pas de preuve). */
  collecteurDerive?: { snapshot(): DistributionComptages };
  /** Planchers par nom de métrique (reportés dans le manifeste). */
  seuilsMin?: Record<string, number>;
  /** PSI maximal acceptable pour promouvoir (défaut 0.25 — dérive). */
  seuilDeriveMax?: number;
  /** Caps d'ingestion (défauts calqués sur job.ts : 120 / 2500). */
  maxParLabel?: number;
  maxTotal?: number;
  /** Artefact à empreinter (défaut : cortex v2 local, sinon pré-entraîné). */
  cheminArtefact?: string;
  /** SHA git forcé (défaut : git rev-parse HEAD, repli 0000000). */
  gitSha?: string;
}

/* ------------------------------------------------------------------ */
/* Aides internes                                                       */
/* ------------------------------------------------------------------ */

/** SHA du commit courant (pattern de scripts/version-manifest.mjs). */
const RE_GIT_SHA = /^[0-9a-f]{7,40}$/;

function gitShaCourant(): string {
  const env = process.env.GEN3IA_GIT_SHA?.trim().toLowerCase();
  if (env && RE_GIT_SHA.test(env)) return env;
  try {
    const sha = execSync("git rev-parse HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .toLowerCase();
    if (RE_GIT_SHA.test(sha)) return sha;
  } catch {
    // Hors dépôt git (artefact packagé) — repli documenté ci-dessous.
  }
  return "0000000";
}

/**
 * Résout le chemin de l'artefact à empreinter. Le pipeline ne construit
 * JAMAIS le cerveau : il empreinte le fichier PRODUIT par le mécanisme
 * d'entraînement (le job local persiste var/neural/cortex-v2.bin via
 * sauvegarderCerveauRuntime).
 */
function resoudreCheminArtefact(explicite: string | undefined): string {
  if (explicite) return explicite;
  if (existsSync(CORTEX_V2_LOCAL)) return CORTEX_V2_LOCAL;
  if (existsSync(CORTEX_V2_PRETRAIN)) return CORTEX_V2_PRETRAIN;
  throw new Error(
    "Aucun artefact neuronal à référencer (var/neural/cortex-v2.bin et assets/neural-pretrained/cortex-v2.bin absents) — lancez un entraînement au préalable ou passez options.cheminArtefact.",
  );
}

/** Capture défensive de la distribution observée (un télémètre fautif ne
 *  doit jamais faire tomber le pipeline). */
function capturerObserve(
  collecteur?: { snapshot(): DistributionComptages },
): DistributionComptages {
  try {
    const observe = collecteur?.snapshot();
    if (typeof observe === "object" && observe !== null) return observe;
  } catch (erreur: unknown) {
    console.warn(
      "[MLOPS-PIPELINE] Collecteur de dérive en échec (ignoré) :",
      erreur instanceof Error ? erreur.message : String(erreur),
    );
  }
  return {};
}

/** Étape (a) — stats réelles du corpus (mécanisme existant dataset.ts). */
async function ingesterCorpus(
  maxParLabel: number,
  maxTotal: number,
): Promise<EtapeIngestion> {
  const debut = Date.now();
  const chemins = ["public/llms.txt", "public/llms-full.txt"];
  try {
    const corpus = await loadCorpusFromPublic();
    const corpusSha256 = createHash("sha256")
      .update(corpus, "utf8")
      .digest("hex");
    const jeu = buildDatasetFromCorpus(corpus, { maxParLabel, maxTotal });
    // Jeu combiné identique au job réel : corpus + amorçage canonique.
    const echantillons = [...jeu.samples, ...SEED_EXAMPLES];
    const distribution: DistributionComptages = {};
    for (const echantillon of echantillons) {
      distribution[echantillon.label] =
        (distribution[echantillon.label] ?? 0) + 1;
    }
    return {
      ok: true,
      corpusSha256,
      corpusChemins: chemins,
      echantillonsCorpus: jeu.samples.length,
      echantillonsAmorcage: SEED_EXAMPLES.length,
      distribution,
      datasets: [
        {
          nom: "corpus-llms",
          reference: `sha256:${corpusSha256}`,
          echantillons: jeu.samples.length,
        },
        {
          nom: "amorcage-canonique",
          reference: "lib/neural/training/dataset.ts#SEED_EXAMPLES",
          echantillons: SEED_EXAMPLES.length,
        },
      ],
      dureeMs: Date.now() - debut,
    };
  } catch (erreur: unknown) {
    return {
      ok: false,
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
      corpusSha256: null,
      corpusChemins: chemins,
      echantillonsCorpus: 0,
      echantillonsAmorcage: 0,
      distribution: {},
      datasets: [],
      dureeMs: Date.now() - debut,
    };
  }
}

/** Compare les métriques candidates à la baseline (production courante). */
function evaluerComparaisons(
  metrics: MetriqueModele[],
  baseline: ManifestModele | null,
): ComparaisonMetrique[] {
  const parNom = new Map<string, number>(
    (baseline?.metrics ?? []).map((m) => [m.nom, m.valeur]),
  );
  return metrics.map((metrique) => {
    const valeurBaseline = parNom.get(metrique.nom);
    // Règle 1 : métrique présente sur la baseline → non-régression stricte.
    if (valeurBaseline !== undefined) {
      const ok = metrique.valeur >= valeurBaseline;
      return {
        nom: metrique.nom,
        valeur: metrique.valeur,
        baseline: valeurBaseline,
        seuilMin: metrique.seuilMin,
        statut: ok ? ("ok" as const) : ("insuffisant" as const),
        motif: ok
          ? undefined
          : `métrique « ${metrique.nom} » : ${metrique.valeur} < baseline ${valeurBaseline} (version ${baseline?.version ?? "?"})`,
      };
    }
    // Règle 2 : métrique nouvelle → plancher déclaré éventuel.
    if (typeof metrique.seuilMin === "number") {
      const ok = metrique.valeur >= metrique.seuilMin;
      return {
        nom: metrique.nom,
        valeur: metrique.valeur,
        seuilMin: metrique.seuilMin,
        statut: ok ? ("ok" as const) : ("insuffisant" as const),
        motif: ok
          ? undefined
          : `métrique « ${metrique.nom} » : ${metrique.valeur} < plancher déclaré ${metrique.seuilMin}`,
      };
    }
    // Nouvelle métrique sans plancher : non évaluable → acceptée.
    return {
      nom: metrique.nom,
      valeur: metrique.valeur,
      seuilMin: metrique.seuilMin,
      statut: "ok" as const,
    };
  });
}

/** Étape (d) — décision de porte (métriques + dérive). */
function evaluerPorte(
  comparaisons: ComparaisonMetrique[],
  derive: ScoreDerive,
  seuilDeriveMax: number,
): { decision: "promotion" | "quarantaine"; raisons: string[] } {
  const raisons: string[] = [];
  for (const comparaison of comparaisons) {
    if (comparaison.statut === "insuffisant" && comparaison.motif) {
      raisons.push(comparaison.motif);
    }
  }
  if (derive.psi > seuilDeriveMax) {
    raisons.push(
      `dérive PSI ${derive.psi.toFixed(4)} > seuil ${seuilDeriveMax} (statut « ${derive.statut} ») — distribution d'usage trop éloignée de la référence d'entraînement`,
    );
  }
  return { decision: raisons.length === 0 ? "promotion" : "quarantaine", raisons };
}

/** Distribution de référence relue d'un manifeste (hyperparams libres). */
function distributionDepuisManifest(
  manifeste: ManifestModele,
): DistributionComptages {
  const brut = manifeste.hyperparams["distributionEntrainement"];
  if (typeof brut !== "object" || brut === null || Array.isArray(brut)) {
    return {};
  }
  const distribution: DistributionComptages = {};
  for (const [cle, valeur] of Object.entries(brut)) {
    if (typeof valeur === "number" && Number.isFinite(valeur) && valeur > 0) {
      distribution[cle] = valeur;
    }
  }
  return distribution;
}

/* ------------------------------------------------------------------ */
/* Exécution                                                            */
/* ------------------------------------------------------------------ */

/**
 * Exécute le pipeline complet (4 étapes idempotentes) et retourne un
 * rapport exécutable. Les échecs durs (corpus absent, entraînement en
 * erreur) produisent un rapport de QUARANTAINE argumenté plutôt qu'une
 * exception : l'appelant (route, cron, script) peut toujours journaliser
 * le rapport tel quel.
 */
export async function executerPipeline(
  options: OptionsPipeline,
): Promise<RapportPipeline> {
  const modelId = options.modelId;
  const version = options.version;
  const registre = options.registre ?? new RegistreModeles();
  const seuilDeriveMax = options.seuilDeriveMax ?? SEUIL_PSI_SURVEILLANCE;
  const journal = executionLogger({
    requestId: "mlops-pipeline",
    userId: `pipeline:${modelId}`,
  });
  const demarreLe = new Date().toISOString();

  // ÉTAPE 0 — IDEMPOTENCE : version déjà enregistrée → jamais retravaillée.
  const existant = await registre.get(modelId, version);
  if (existant) {
    return reevaluerVersionExistante(
      options,
      existant,
      registre,
      seuilDeriveMax,
    );
  }

  // (a) INGESTION — stats réelles du corpus d'entraînement existant.
  const ingestion = await ingesterCorpus(
    options.maxParLabel ?? 120,
    options.maxTotal ?? 2500,
  );
  if (!ingestion.ok) {
    journal.error(
      `Pipeline ${modelId}@${version} : ingestion en échec — ${ingestion.erreur}`,
    );
    return {
      modelId,
      version,
      demarreLe,
      termineLe: new Date().toISOString(),
      reprise: false,
      decision: "quarantaine",
      raisons: [`ingestion en échec : ${ingestion.erreur}`],
      etapes: {
        ingestion,
        entrainement: {
          statut: "echec",
          metriques: [],
          hyperparams: {},
          erreur: "non exécutée (ingestion en échec)",
          dureeMs: 0,
        },
        evaluation: {
          baselineVersion: null,
          comparaisons: [],
          derive: calculerScorePsi({}, {}),
          dureeMs: 0,
        },
        porte: {
          decision: "quarantaine",
          raisons: ["ingestion en échec"],
          manifestVersion: null,
          canalFinal: null,
        },
      },
      manifest: null,
    };
  }

  // (b) ENTRAÎNEMENT — délégation au mécanisme réel (injectable) + empreinte
  //     de l'artefact produit (le job local persiste cortex-v2.bin).
  const adaptateur = options.adaptateur ?? creerAdaptateurNeuralLocal();
  const debutEntrainement = Date.now();
  let resultat: ResultatEntrainement;
  let artefact: ArtefactModele;
  let etapeEntrainement: EtapeEntrainement;
  try {
    resultat = await adaptateur({
      modelId,
      version,
      echantillons:
        ingestion.echantillonsCorpus + ingestion.echantillonsAmorcage,
      hyperparams: { ...(options.hyperparams ?? {}) },
    });
    const cheminArtefact = resoudreCheminArtefact(options.cheminArtefact);
    const empreinte = await empreinteArtefact(cheminArtefact);
    artefact = { chemin: cheminArtefact, ...empreinte };
    etapeEntrainement = {
      statut: "execute",
      metriques: resultat.metriques,
      hyperparams: { ...(options.hyperparams ?? {}), ...resultat.hyperparams },
      jobId: resultat.jobId,
      artefact,
      dureeMs: Date.now() - debutEntrainement,
    };
  } catch (erreur: unknown) {
    const message = erreur instanceof Error ? erreur.message : String(erreur);
    journal.error(
      `Pipeline ${modelId}@${version} : entraînement en échec — ${message}`,
    );
    return {
      modelId,
      version,
      demarreLe,
      termineLe: new Date().toISOString(),
      reprise: false,
      decision: "quarantaine",
      raisons: [`entraînement en échec : ${message}`],
      etapes: {
        ingestion,
        entrainement: {
          statut: "echec",
          metriques: [],
          hyperparams: {},
          erreur: message,
          dureeMs: Date.now() - debutEntrainement,
        },
        evaluation: {
          baselineVersion: null,
          comparaisons: [],
          derive: calculerScorePsi(
            ingestion.distribution,
            capturerObserve(options.collecteurDerive),
          ),
          dureeMs: 0,
        },
        porte: {
          decision: "quarantaine",
          raisons: ["entraînement en échec"],
          manifestVersion: null,
          canalFinal: null,
        },
      },
      manifest: null,
    };
  }

  // (c) ÉVALUATION — baseline = manifeste de production courant + dérive.
  const debutEvaluation = Date.now();
  const baseline = await registre.latest(modelId, "production");
  const derive = calculerScorePsi(
    ingestion.distribution,
    capturerObserve(options.collecteurDerive),
  );
  const seuilsMin = options.seuilsMin ?? {};
  const metriques = resultat.metriques.map((metrique) =>
    metrique.seuilMin === undefined && seuilsMin[metrique.nom] !== undefined
      ? { ...metrique, seuilMin: seuilsMin[metrique.nom] }
      : metrique,
  );
  const comparaisons = evaluerComparaisons(metriques, baseline);
  const etapeEvaluation: EtapeEvaluation = {
    baselineVersion: baseline?.version ?? null,
    comparaisons,
    derive,
    dureeMs: Date.now() - debutEvaluation,
  };

  // (d) PORTE CONDITIONNELLE — promotion SI métriques ≥ baseline (règle 1)
  //     / ≥ plancher (règle 2) ET dérive acceptable (psi ≤ seuil).
  const porte = evaluerPorte(comparaisons, derive, seuilDeriveMax);
  const parentVersion = options.parentVersion ?? baseline?.version;
  const manifestCommun = {
    modelId,
    version,
    createdAt: new Date().toISOString(),
    gitSha: options.gitSha ?? gitShaCourant(),
    auteur: options.auteur ?? "pipeline-mlops",
    artefact,
    datasets: ingestion.datasets,
    hyperparams: {
      ...etapeEntrainement.hyperparams,
      // Identité du corpus (reprise exacte sans relire les fichiers) et
      // distribution de référence embarquée : le manifeste est
      // AUTO-SUFFISANT pour recalculer une dérive plus tard.
      corpusSha256: ingestion.corpusSha256,
      distributionEntrainement: ingestion.distribution,
    },
    metrics: metriques,
    lineage: {
      ...(parentVersion ? { parentVersion } : {}),
      source: "pipeline" as const,
    },
  };

  let manifest: ManifestModele;
  let canalFinal: CanalModele;
  try {
    manifest = await registre.register({ ...manifestCommun, channel: "experimental" });
    if (porte.decision === "promotion") {
      if (derive.statut === "surveillance") {
        journal.warn(
          `Pipeline ${modelId}@${version} : promotion avec dérive « surveillance » (PSI ${derive.psi.toFixed(4)}) — à observer de près.`,
        );
      }
      await registre.promouvoir(modelId, version, "production");
      canalFinal = "production";
      journal.info(
        `Pipeline ${modelId}@${version} : PROMOTION en production (accuracy ${metriques.map((m) => `${m.nom}=${m.valeur}`).join(", ") || "n/a"}).`,
      );
    } else {
      canalFinal = "experimental";
      journal.warn(
        `Pipeline ${modelId}@${version} : QUARANTAINE (canal experimental) — ${porte.raisons.join(" ; ")}`,
      );
    }
    manifest = (await registre.get(modelId, version)) ?? manifest;
  } catch (erreur: unknown) {
    // Course concurrente sur la même version ou I/O disque : rapport
    // honnête, aucun manifeste partiel (le registre est atomique).
    const message = erreur instanceof Error ? erreur.message : String(erreur);
    journal.error(
      `Pipeline ${modelId}@${version} : enregistrement en échec — ${message}`,
    );
    return {
      modelId,
      version,
      demarreLe,
      termineLe: new Date().toISOString(),
      reprise: false,
      decision: "quarantaine",
      raisons: [`enregistrement en échec : ${message}`],
      etapes: {
        ingestion,
        entrainement: etapeEntrainement,
        evaluation: etapeEvaluation,
        porte: {
          decision: "quarantaine",
          raisons: [`enregistrement en échec : ${message}`],
          manifestVersion: null,
          canalFinal: null,
        },
      },
      manifest: null,
    };
  }

  return {
    modelId,
    version,
    demarreLe,
    termineLe: new Date().toISOString(),
    reprise: false,
    decision: porte.decision,
    raisons: porte.raisons,
    etapes: {
      ingestion,
      entrainement: etapeEntrainement,
      evaluation: etapeEvaluation,
      porte: {
        decision: porte.decision,
        raisons: porte.raisons,
        manifestVersion: manifest.version,
        canalFinal,
      },
    },
    manifest,
  };
}

/**
 * REPRISE (idempotence) : la version existe déjà — les étapes (a) et (b)
 * sont RELUES du manifeste (statut « reprise ») et la porte (c)+(d) est
 * réévaluée avec l'état ACTUEL du registre et de l'usage observé :
 *  - quarantainée + porte désormais passée → PROMOTION (sans re-entraîner) ;
 *  - déjà en production + porte passée → NO-OP strict (pointeur intact) ;
 *  - déjà en production + porte fermée → AVERTISSEMENT (la démotion est
 *    une opération opérateur : rollback(), jamais automatique).
 */
async function reevaluerVersionExistante(
  options: OptionsPipeline,
  existant: ManifestModele,
  registre: RegistreModeles,
  seuilDeriveMax: number,
): Promise<RapportPipeline> {
  const modelId = existant.modelId;
  const version = existant.version;
  const journal = executionLogger({
    requestId: "mlops-pipeline",
    userId: `pipeline:${modelId}`,
  });
  const demarreLe = new Date().toISOString();

  // (a)+(b) relus du manifeste (distribution de référence embarquée).
  const distribution = distributionDepuisManifest(existant);
  const referenceCorpus =
    existant.datasets.find((d) => d.nom === "corpus-llms")?.reference ?? null;
  const etapeIngestion: EtapeIngestion = {
    ok: true,
    corpusSha256:
      typeof existant.hyperparams["corpusSha256"] === "string"
        ? (existant.hyperparams["corpusSha256"] as string)
        : referenceCorpus?.startsWith("sha256:")
          ? referenceCorpus.slice("sha256:".length)
          : null,
    corpusChemins: [],
    echantillonsCorpus:
      existant.datasets.find((d) => d.nom === "corpus-llms")?.echantillons ?? 0,
    echantillonsAmorcage:
      existant.datasets.find((d) => d.nom === "amorcage-canonique")
        ?.echantillons ?? 0,
    distribution,
    datasets: existant.datasets,
    dureeMs: 0,
  };
  const etapeEntrainement: EtapeEntrainement = {
    statut: "reprise",
    metriques: existant.metrics,
    hyperparams: existant.hyperparams,
    artefact: existant.artefact,
    dureeMs: 0,
  };

  // (c) évaluation ACTUELLE (baseline courante + usage observé courant).
  const debutEvaluation = Date.now();
  const baseline = await registre.latest(modelId, "production");
  const derive = calculerScorePsi(
    distribution,
    capturerObserve(options.collecteurDerive),
  );
  const comparaisons = evaluerComparaisons(existant.metrics, baseline);
  const etapeEvaluation: EtapeEvaluation = {
    baselineVersion: baseline?.version ?? null,
    comparaisons,
    derive,
    dureeMs: Date.now() - debutEvaluation,
  };

  // (d) porte réévaluée — sans jamais retravailler la version elle-même.
  const porte = evaluerPorte(comparaisons, derive, seuilDeriveMax);
  let manifest = existant;
  let canalFinal: CanalModele = existant.channel;
  if (porte.decision === "promotion") {
    if (existant.channel !== "production") {
      await registre.promouvoir(modelId, version, "production");
      manifest = (await registre.get(modelId, version)) ?? existant;
      canalFinal = "production";
      journal.info(
        `Pipeline ${modelId}@${version} (reprise) : PROMOTION en production après réévaluation de la porte.`,
      );
    } else {
      // Déjà la production pointée : no-op strict (idempotence).
      journal.info(
        `Pipeline ${modelId}@${version} (reprise) : déjà en production, pointeur inchangé.`,
      );
    }
  } else if (existant.channel === "production") {
    journal.warn(
      `Pipeline ${modelId}@${version} (reprise) : porte fermée sur la version EN PRODUCTION (${porte.raisons.join(" ; ")}) — le pointeur n'est PAS modifié automatiquement (démotion = rollback opérateur).`,
    );
  } else {
    journal.warn(
      `Pipeline ${modelId}@${version} (reprise) : toujours en quarantaine — ${porte.raisons.join(" ; ")}`,
    );
  }

  return {
    modelId,
    version,
    demarreLe,
    termineLe: new Date().toISOString(),
    reprise: true,
    decision: porte.decision,
    raisons: porte.raisons,
    etapes: {
      ingestion: etapeIngestion,
      entrainement: etapeEntrainement,
      evaluation: etapeEvaluation,
      porte: {
        decision: porte.decision,
        raisons: porte.raisons,
        manifestVersion: manifest.version,
        canalFinal,
      },
    },
    manifest,
  };
}
