/**
 * EXPÉRIENCE D'ENTRAÎNEMENT RÉELLE — COMPRÉHENSION SÉMANTIQUE APPRISE
 * (mission « TERMINAL COMPLETION » — WS 2, exigences strictes : pas de
 * faux entraînement, datasets train/validation/test SÉPARÉS, généralisation
 * mesurée sur des exemples non vus, reproductibilité par graine,
 * paramètres appris persistés et versionnés).
 *
 * Protocole :
 *  1. DATASET RÉEL : le corpus d'amorçage du cerveau (CORPUS_GEN3 — données
 *     commises, réelles) est converti en échantillons texte→intention par
 *     buildDatasetFromCorpus (labels réels du dépôt) ;
 *  2. SÉPARATION EXPLICITE 70/15/15 (train / validation / test) par mélange
 *     déterministe (LCG seedé) — le test n'est JAMAIS vu pendant
 *     l'entraînement ;
 *  3. BASELINE : accuracy de référence mesurée sur le test AVANT tout
 *     entraînement (aucune plasticité) — prouve que le gain vient bien de
 *     l'apprentissage, pas d'une fuite ;
 *  4. ENTRAÎNEMENT RÉEL : NeuralTrainer (plasticité synaptique SNN réelle)
 *     sur le TRAIN uniquement ;
 *  5. MESURES : accuracy train / validation / test APRÈS — la
 *     GÉNÉRALISATION est accuracyTest − baselineTest (gain sur non-vus) ;
 *  6. PERSISTANCE VERSIONNÉE : snapshot du cerveau entraîné + manifeste
 *     SHA-256 (graine, stats, accuracies) ;
 *  7. REPRODUCTIBILITÉ : même graine + resetBrain() → mêmes splits (hash
 *     identique) et mêmes accuracies — testé.
 *
 * CPU/RAM : consommation réelle mesurée (mémoire avant/après, durée).
 */

import { createHash } from "node:crypto";

import { getNeuralRuntime } from "../runtime";
import { NeuralTrainer } from "./trainer";
import { buildDatasetFromCorpus, type TrainingSample } from "./dataset";
import { CORPUS_GEN3 } from "../generation/corpus";
import { sauvegarderVersion, type ManifesteVersion } from "../persistance-versions";

/** Séparation déterministe 70/15/15 (LCG seedé — famille du dépôt). */
export function separerDataset(
  samples: readonly TrainingSample[],
  seed: number,
): { train: TrainingSample[]; validation: TrainingSample[]; test: TrainingSample[] } {
  const melange = [...samples];
  let graine = (seed || 42) >>> 0;
  const alea = () => {
    graine = (graine * 1_664_525 + 1_013_904_223) >>> 0;
    return graine / 0xffffffff;
  };
  for (let i = melange.length - 1; i > 0; i--) {
    const j = Math.floor(alea() * (i + 1));
    const tmp = melange[i];
    melange[i] = melange[j];
    melange[j] = tmp;
  }
  const nbTest = Math.max(1, Math.floor(melange.length * 0.15));
  const nbVal = Math.max(1, Math.floor(melange.length * 0.15));
  const nbTrain = Math.max(1, melange.length - nbTest - nbVal);
  return {
    train: melange.slice(0, nbTrain),
    validation: melange.slice(nbTrain, nbTrain + nbVal),
    test: melange.slice(nbTrain + nbVal),
  };
}

/** Empreinte reproductible des splits (ordre + contenu). */
export function hashSplits(splits: { train: TrainingSample[]; validation: TrainingSample[]; test: TrainingSample[] }): string {
  const h = createHash("sha256");
  for (const [nom, liste] of [["train", splits.train], ["val", splits.validation], ["test", splits.test]] as const) {
    h.update(nom);
    for (const s of liste) h.update(`${s.label}\u0000${s.text}\u0001`);
  }
  return h.digest("hex").slice(0, 32);
}

/** Rapport réel de l'expérience (aucune donnée inventée). */
export interface RapportExperience {
  seed: number;
  dataset: { total: number; train: number; validation: number; test: number; labels: number; parLabel: Record<string, number> };
  hashSplits: string;
  /** Accuracy de référence sur le test AVANT entraînement (aucune plasticité). */
  baselineTest: number;
  accuracies: { train: number; validation: number; test: number };
  /** Généralisation sur non-vus = accuracyTest − baselineTest (≥ 0 attendu). */
  generalisation: number;
  dureeMs: number;
  ram: { avantMo: number; apresMo: number };
  version: ManifesteVersion | null;
  epoques: number;
}

export interface OptionsExperience {
  seed?: number;
  epoques?: number;
  maxTotal?: number;
  /** Snapshot versionné (défaut true en usage réel ; false en tests). */
  versionner?: boolean;
  racineVersions?: string;
}

/** EXÉCUTE l'expérience complète (dataset réel → entraînement réel → mesures réelles). */
export async function executerExperienceSemantique(options: OptionsExperience = {}): Promise<RapportExperience> {
  const seed = options.seed ?? 42;
  const epoques = options.epoques ?? 8;
  const debut = Date.now();
  const ramAvant = process.memoryUsage();

  // 1) Dataset réel depuis le corpus commis du cerveau.
  const texte = CORPUS_GEN3.map((p) => `${p.motif}. ${p.reponse}`).join("\n");
  const dataset = buildDatasetFromCorpus(texte, { inclureSeed: true, maxTotal: options.maxTotal ?? 2_500 });
  if (dataset.samples.length < 60) {
    throw new Error(`dataset réel insuffisant (${dataset.samples.length} échantillons) — expérience refusée (jamais prétendre)`);
  }

  // 2) Séparation explicite train/validation/test (graine).
  const splits = separerDataset(dataset.samples, seed);
  const hash = hashSplits(splits);

  // 3) Runtime réel + baseline sur le test AVANT entraînement.
  const runtime = getNeuralRuntime();
  const trainer = new NeuralTrainer(runtime.reseau, runtime.espace, runtime.veille, runtime.noyau);
  const baselineTest = trainer.evaluerEchantillons(splits.test, 4);

  // 4) Entraînement RÉEL (plasticité synaptique) sur le TRAIN uniquement.
  const rapportEntrainement = await trainer.train(splits.train, { epochs: epoques, testRatio: 0 });

  // 5) Mesures après entraînement (aucune plasticité pendant l'évaluation).
  const accTrain = trainer.evaluerEchantillons(splits.train.slice(0, 120), 4);
  const accValidation = trainer.evaluerEchantillons(splits.validation, 4);
  const accTest = trainer.evaluerEchantillons(splits.test, 4);
  const ramApres = process.memoryUsage();

  // 6) Persistance versionnée des paramètres appris (couché sur disque).
  let version: ManifesteVersion | null = null;
  if (options.versionner !== false) {
    const ok = await (await import("../runtime")).sauvegarderCerveauRuntime();
    if (ok) {
      version = sauvegarderVersion(
        `experience-semantique-seed${seed}`,
        {
          seed,
          epoques,
          hashSplits: hash,
          accuracies: { train: accTrain, validation: accValidation, test: accTest },
          baselineTest,
          dataset: dataset.stats,
        },
        options.racineVersions,
      );
    }
  }

  const arrondi = (x: number) => Math.round(x * 1000) / 1000;
  return {
    seed,
    dataset: {
      total: dataset.samples.length,
      train: splits.train.length,
      validation: splits.validation.length,
      test: splits.test.length,
      labels: Object.keys(dataset.stats).length,
      parLabel: dataset.stats,
    },
    hashSplits: hash,
    baselineTest: arrondi(baselineTest),
    accuracies: { train: arrondi(accTrain), validation: arrondi(accValidation), test: arrondi(accTest) },
    generalisation: arrondi(accTest - baselineTest),
    dureeMs: Date.now() - debut,
    ram: { avantMo: Math.round(ramAvant.heapUsed / 1_048_576), apresMo: Math.round(ramApres.heapUsed / 1_048_576) },
    version,
    epoques: rapportEntrainement.epochs,
  };
}
