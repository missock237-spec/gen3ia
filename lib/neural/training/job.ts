import "server-only";

import { randomUUID } from "node:crypto";

import { getNeuralRuntime, sauvegarderCerveauRuntime } from "../runtime";
import { NeuralTrainer } from "./trainer";
import type { TrainingReport } from "./trainer";
import {
  buildDatasetFromCorpus,
  loadCorpusFromPublic,
  SEED_EXAMPLES,
} from "./dataset";
import { enregistrerPoolsDIntention } from "./trainer";
import { CORPUS_GEN3 } from "../generation/corpus";
import type { StatsApprentissageLangage } from "../generation/language";
import { executionLogger } from "@/lib/observability/logger";

/**
 * GESTIONNAIRE DE JOB D'ENTRAÎNEMENT NEURONAL (en mémoire du process).
 *
 * Le cerveau étant un singleton partagé (une seule instance PM2 en
 * production), UN SEUL entraînement peut tourner à la fois — un second
 * lancement est refusé explicitement (erreur 409) tant que le premier
 * n'est pas terminé.
 *
 * Le job est asynchrone et CHUNKÉ (cf. NeuralTrainer : setImmediate tous
 * les 25 échantillons) : le serveur reste réactif pendant l'entraînement,
 * la progression est interrogeable via GET /api/neural/train.
 */

/** État d'un job d'entraînement (données 100 % réelles). */
export interface NeuralTrainingJob {
  /** Identifiant unique du job. */
  id: string;
  /** en_cours | termine | echec. */
  status: "en_cours" | "termine" | "echec";
  /** Date ISO de lancement. */
  demarreLe: string;
  /** Date ISO de fin (si terminé). */
  termineLe?: string;
  /** Source du corpus (« llms » = public/llms*.txt du dépôt). */
  source: string;
  /** Nombre d'époques demandé. */
  epochs: number;
  /** Époque courante (progression). */
  epochCourante: number;
  /** Accuracy de la dernière époque mesurée (progression). */
  accuracyCourante: number;
  /** Nombre d'échantillons d'entraînement du job. */
  nbEchantillons: number;
  /** Répartition par label du jeu construit. */
  statsDataset: Record<string, number>;
  /** Message d'erreur si status = echec. */
  erreur?: string;
  /** Rapport final complet si status = termine. */
  rapport?: TrainingReport;
  /**
   * Apprentissage langagier du cortex (corpus conversationnel + amorçage) —
   * stats réelles du dernier passage (données réelles).
   */
  langage?: StatsApprentissageLangage;
}

/** Slots mémoire (résistent au HMR comme le runtime). */
const globalAvecJobs = globalThis as typeof globalThis & {
  __gen3NeuralTrainingJob?: NeuralTrainingJob;
};

/** Job en cours, le cas échéant (null sinon). */
export function getJobEnCours(): NeuralTrainingJob | null {
  const job = globalAvecJobs.__gen3NeuralTrainingJob;
  return job && job.status === "en_cours" ? job : null;
}

/** Dernier job connu (quel que soit son état). */
export function getDernierJob(): NeuralTrainingJob | null {
  return globalAvecJobs.__gen3NeuralTrainingJob ?? null;
}

/** Options de lancement. */
export interface LancerEntrainementOptions {
  /** Nombre d'époques (1..10, défaut 4). */
  epochs?: number;
  /** Cap d'échantillons par label pour le corpus (défaut 120). */
  maxParLabel?: number;
  /** Cap total d'échantillons corpus (défaut 2500). */
  maxTotal?: number;
  /** Renforcement synaptique supervisé (défaut 0.15). */
  lrBoost?: number;
  /** Cycles du noyau par échantillon (défaut 4). */
  cyclesParEchantillon?: number;
}

/**
 * Lance l'entraînement du cerveau neuronal sur le corpus du projet
 * (public/llms*.txt + SEED_EXAMPLES canoniques). Refuse (Error « conflit »)
 * si un entraînement est déjà en cours.
 */
export function lancerEntrainement(
  options: LancerEntrainementOptions = {},
): NeuralTrainingJob {
  if (getJobEnCours()) {
    throw new Error(
      "Un entraînement neuronal est déjà en cours — attendez sa fin (GET /api/neural/train) avant d'en relancer un.",
    );
  }

  const epochs = Math.max(1, Math.min(10, options.epochs ?? 4));
  const maxParLabel = Math.max(1, Math.min(500, options.maxParLabel ?? 120));
  const maxTotal = Math.max(
    SEED_EXAMPLES.length + 1,
    Math.min(8000, options.maxTotal ?? 2500),
  );
  const lrBoost = options.lrBoost ?? 0.15;
  const cyclesParEchantillon = options.cyclesParEchantillon ?? 4;

  const job: NeuralTrainingJob = {
    id: randomUUID(),
    status: "en_cours",
    demarreLe: new Date().toISOString(),
    source: "llms",
    epochs,
    epochCourante: 0,
    accuracyCourante: 0,
    nbEchantillons: 0,
    statsDataset: {},
  };
  globalAvecJobs.__gen3NeuralTrainingJob = job;

  // Exécution asynchrone : la réponse API revient immédiatement.
  void (async () => {
    try {
      const runtime = getNeuralRuntime();

      // 1. Corpus réel du dépôt + amorçage canonique supervisé.
      const corpus = await loadCorpusFromPublic();
      const jeuCorpus = buildDatasetFromCorpus(corpus, {
        maxParLabel,
        maxTotal,
      });
      const samples = [...jeuCorpus.samples, ...SEED_EXAMPLES];
      job.nbEchantillons = samples.length;
      // Répartition réelle du jeu combiné (corpus + amorçage canonique).
      const stats: Record<string, number> = {};
      for (const echantillon of samples) {
        stats[echantillon.label] = (stats[echantillon.label] ?? 0) + 1;
      }
      job.statsDataset = stats;

      // 2. Pools d'intention + entraîneur sur le cerveau singleton.
      enregistrerPoolsDIntention(runtime.espace);
      const trainer = new NeuralTrainer(
        runtime.reseau,
        runtime.espace,
        runtime.veille,
        runtime.noyau,
      );

      // 3. Boucle réelle avec progression observable.
      const rapport = await trainer.train(samples, {
        epochs,
        lrBoost,
        cyclesParEchantillon,
        onProgress: ({ epoch, accuracy }) => {
          job.epochCourante = epoch;
          job.accuracyCourante = accuracy;
        },
      });

      // 3-bis. CORTEX LANGAGIER : le corpus conversationnel d'amorçage est
      // réaffirmé à chaque session (idempotent) — les paires personnalisées
      // déjà apprises sont conservées (le cortex est idempotent sur les
      // doublons de motifs).
      job.langage = runtime.cortex.apprendre(CORPUS_GEN3);

      // 4. Persistance du cerveau appris (synapses + cortex langagier)
      //    + historique du runtime.
      const sauvegarde = await sauvegarderCerveauRuntime();
      runtime.historiqueEntrainement.push(rapport);
      if (runtime.historiqueEntrainement.length > 20) {
        runtime.historiqueEntrainement.splice(
          0,
          runtime.historiqueEntrainement.length - 20,
        );
      }

      job.status = "termine";
      job.termineLe = new Date().toISOString();
      job.rapport = rapport;
      executionLogger({
        requestId: "neural-training",
        userId: `job:${job.id}`,
      }).info(`Entraînement neuronal terminé (accuracy test: ${rapport.accuracyTest}, langage: ${job.langage.pairesAjoutees} paires ajoutées, sauvegarde: ${sauvegarde})`);
    } catch (error) {
      job.status = "echec";
      job.termineLe = new Date().toISOString();
      job.erreur =
        error instanceof Error ? error.message : "Erreur inconnue.";
      executionLogger({
        requestId: "neural-training",
        userId: `job:${job.id}`,
      }).error(`Échec de l'entraînement neuronal : ${job.erreur}`);
    }
  })();

  return job;
}
