import "server-only";

import { randomUUID } from "node:crypto";

import { getNeuralRuntime, sauvegarderCerveauRuntime } from "../runtime";
import { NeuralTrainer } from "./trainer";
import type { TrainingReport, RapportDomaines } from "./trainer";
import {
  buildDatasetFromCorpus,
  loadCorpusFromPublic,
  SEED_EXAMPLES,
} from "./dataset";
import {
  enregistrerPoolsDIntention,
  enregistrerPoolsDomaines,
} from "./trainer";
import {
  chargerEchantillonsDomaines,
  construirePairesDomaines,
} from "./domaines";
import { CORPUS_GEN3 } from "../generation/corpus";
import { entrainerDomainesParOndes } from "./entrainement-ondes";
import type { RapportEntrainementOndes } from "./entrainement-ondes";
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
 *
 * SOURCES (v3) :
 *  - « corpus »   : intentions d'action sur le corpus du projet (llms* +
 *    amorçage canonique) — comportement historique ;
 *  - « domaines » : couche des 18 domaines (échantillons JSONL commis ou
 *    datasets complets si présents) + paires du cortex langagier ;
 *  - « complet »  : les deux, dans le même job ;
 *  - « ondes »    : it.57 — NOUVEAU MOYEN D'ENTRAÎNEMENT par analyse et
 *    traitement des ONDES (cortex v1M, domaines CHOISIS via domainesOndes).
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
  /** Source demandée : corpus | domaines | complet. */
  source: string;
  /** Nombre d'époques demandé. */
  epochs: number;
  /** Époque courante (progression). */
  epochCourante: number;
  /** Accuracy de la dernière époque mesurée (progression). */
  accuracyCourante: number;
  /** Nombre d'échantillons d'entraînement du job (intentions). */
  nbEchantillons: number;
  /** Nombre d'échantillons de domaine du job (couche v3). */
  nbEchantillonsDomaines: number;
  /** Répartition par label du jeu d'intentions construit. */
  statsDataset: Record<string, number>;
  /** Répartition par domaine du jeu de domaines construit. */
  statsDomaines?: {
    parDomaine: Record<string, number>;
    parLangue: Record<string, number>;
    fichiersAbsents: string[];
  };
  /** Message d'erreur si status = echec. */
  erreur?: string;
  /** Rapport final complet si status = termine (intentions). */
  rapport?: TrainingReport;
  /** Rapport final de la couche des domaines si entraînée. */
  rapportDomaines?: RapportDomaines;
  /** it.57 — rapport de la session d'entraînement PAR ONDES (source « ondes »). */
  rapportOndes?: RapportEntrainementOndes;
  /**
   * Apprentissage langagier du cortex (corpus conversationnel + amorçage +
   * paires de domaine) — stats réelles du dernier passage.
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
  /** Source : corpus (défaut) | domaines | complet | ondes (it.57). */
  source?: "corpus" | "domaines" | "complet" | "ondes";
  /** Cap d'échantillons de domaine par dataset (défaut 120). */
  maxParDomaine?: number;
  /** Utiliser les datasets complets si présents sur disque (défaut false). */
  complet?: boolean;
  /** it.57 — ENTRAÎNEMENT PAR ONDES : domaines CHOISIS (liste de labels ;
   *  vide = tous les 18). Analysés puis traités SOUS ONDES par le cortex
   *  v1M (lib/neural/training/entrainement-ondes.ts). */
  domainesOndes?: string[];
}

/**
 * Lance l'entraînement du cerveau neuronal. Refuse (Error « conflit ») si un
 * entraînement est déjà en cours. Selon la source : intentions (corpus),
 * 18 domaines (domaines) ou les deux (complet) — le cortex langagier reçoit
 * dans tous les cas les paires de domaine disponibles.
 */
export function lancerEntrainement(
  options: LancerEntrainementOptions = {},
): NeuralTrainingJob {
  if (getJobEnCours()) {
    throw new Error(
      "Un entraînement neuronal est déjà en cours — attendez sa fin (GET /api/neural/train) avant d'en relancer un.",
    );
  }

  const source = options.source ?? "corpus";
  const epochs = Math.max(1, Math.min(10, options.epochs ?? 4));
  const maxParLabel = Math.max(1, Math.min(500, options.maxParLabel ?? 120));
  const maxTotal = Math.max(
    SEED_EXAMPLES.length + 1,
    Math.min(8000, options.maxTotal ?? 2500),
  );
  const maxParDomaine = Math.max(
    10,
    Math.min(2000, options.maxParDomaine ?? 120),
  );
  const lrBoost = options.lrBoost ?? 0.15;
  const cyclesParEchantillon = options.cyclesParEchantillon ?? 4;

  const job: NeuralTrainingJob = {
    id: randomUUID(),
    status: "en_cours",
    demarreLe: new Date().toISOString(),
    source,
    epochs,
    epochCourante: 0,
    accuracyCourante: 0,
    nbEchantillons: 0,
    nbEchantillonsDomaines: 0,
    statsDataset: {},
  };
  globalAvecJobs.__gen3NeuralTrainingJob = job;

  // Exécution asynchrone : la réponse API revient immédiatement.
  void (async () => {
    try {
      const runtime = getNeuralRuntime();
      const trainer = new NeuralTrainer(
        runtime.reseau,
        runtime.espace,
        runtime.veille,
        runtime.noyau,
      );

      // ── 1. INTENTIONS (sources « corpus » et « complet ») ────────────────
      if (source === "corpus" || source === "complet") {
        const corpus = await loadCorpusFromPublic();
        const jeuCorpus = buildDatasetFromCorpus(corpus, {
          maxParLabel,
          maxTotal,
        });
        const samples = [...jeuCorpus.samples, ...SEED_EXAMPLES];
        job.nbEchantillons = samples.length;
        const stats: Record<string, number> = {};
        for (const echantillon of samples) {
          stats[echantillon.label] = (stats[echantillon.label] ?? 0) + 1;
        }
        job.statsDataset = stats;

        enregistrerPoolsDIntention(runtime.espace);
        const rapport = await trainer.train(samples, {
          epochs,
          lrBoost,
          cyclesParEchantillon,
          onProgress: ({ epoch, accuracy }) => {
            job.epochCourante = epoch;
            job.accuracyCourante = accuracy;
          },
        });
        job.rapport = rapport;
        runtime.historiqueEntrainement.push(rapport);
      }

      // ── 2. DOMAINES (sources « domaines » et « complet ») ────────────────
      if (source === "domaines" || source === "complet") {
        const chargement = await chargerEchantillonsDomaines({
          maxParDomaine,
          complet: options.complet,
        });
        if (chargement.samples.length > 0) {
          job.nbEchantillonsDomaines = chargement.samples.length;
          job.statsDomaines = {
            parDomaine: chargement.parDomaine,
            parLangue: chargement.parLangue,
            fichiersAbsents: chargement.fichiersAbsents,
          };
          enregistrerPoolsDomaines(runtime.espace);
          const rapportDomaines = await trainer.trainDomaines(
            chargement.samples,
            {
              epochs,
              lrBoost,
              cyclesParEchantillon,
              onProgress: ({ epoch, accuracy }) => {
                job.epochCourante = epoch;
                job.accuracyCourante = accuracy;
              },
            },
          );
          job.rapportDomaines = rapportDomaines;
        } else {
          executionLogger({
            requestId: "neural-training",
            userId: `job:${job.id}`,
          }).warn(
            `Entraînement « ${source} » : aucun échantillon de domaine trouvé (fichiers absents : ${chargement.fichiersAbsents.join(", ") || "aucun"}).`,
          );
        }
      }

      // ── 2-bis. ONDES (source « ondes » — it.57, demande propriétaire) ───
      //    NOUVEAU MOYEN D'ENTRAÎNEMENT : analyse des ondes + traitement
      //    des ondes sur le cortex v1M, domaines CHOISIS par le propriétaire.
      if (source === "ondes") {
        const chargementOndes = await chargerEchantillonsDomaines({
          maxParDomaine,
          complet: options.complet,
        });
        const filtre = options.domainesOndes?.length
          ? new Set(options.domainesOndes.map((d) => d.trim().toLowerCase()).filter(Boolean))
          : null;
        const exemplesOndes = chargementOndes.samples
          .filter((s) => !filtre || filtre.has(s.label.toLowerCase()))
          .map((s) => ({ texte: s.text, domaine: s.label }));
        if (runtime.cortexV2 && exemplesOndes.length > 0) {
          job.nbEchantillonsDomaines = exemplesOndes.length;
          job.statsDomaines = {
            parDomaine: chargementOndes.parDomaine,
            parLangue: chargementOndes.parLangue,
            fichiersAbsents: chargementOndes.fichiersAbsents,
          };
          const rapportOndes = entrainerDomainesParOndes(
            runtime.cortexV2.cortex,
            runtime.cortexV2.champ,
            exemplesOndes,
            { cyclesParEchantillon, lrBoost, maxParDomaine },
          );
          job.rapportOndes = rapportOndes;
        } else {
          executionLogger({
            requestId: "neural-training",
            userId: `job:${job.id}`,
          }).warn(
            runtime.cortexV2
              ? `Entraînement « ondes » : aucun échantillon de domaine trouvé (fichiers absents : ${chargementOndes.fichiersAbsents.join(", ") || "aucun"}).`
              : "Entraînement « ondes » : cortex v2 indisponible (trop de mémoire ?) — session ignorée.",
          );
        }
      }

      // ── 3. CORTEX LANGAGIER ─────────────────────────────────────────────
      //    Corpus d'amorçage canonique (idempotent) + paires de domaine
      //    réelles extraites des datasets (plafonnées).
      let statsLangage = runtime.cortex.apprendre(CORPUS_GEN3);
      try {
        const pairesDomaines = await construirePairesDomaines();
        if (pairesDomaines.length > 0) {
          const statsDomaines = runtime.cortex.apprendre(pairesDomaines);
          statsLangage = {
            pairesAjoutees:
              statsLangage.pairesAjoutees + statsDomaines.pairesAjoutees,
            pairesDoublons:
              statsLangage.pairesDoublons + statsDomaines.pairesDoublons,
            vocabulaire: statsDomaines.vocabulaire,
            totalPaires: statsDomaines.totalPaires,
          };
        }
      } catch {
        // Paires de domaine indisponibles : le corpus canonique suffit.
      }
      job.langage = statsLangage;

      // ── 4. PERSISTANCE + historique ─────────────────────────────────────
      const sauvegarde = await sauvegarderCerveauRuntime();
      if (runtime.historiqueEntrainement.length > 20) {
        runtime.historiqueEntrainement.splice(
          0,
          runtime.historiqueEntrainement.length - 20,
        );
      }

      job.status = "termine";
      job.termineLe = new Date().toISOString();
      executionLogger({
        requestId: "neural-training",
        userId: `job:${job.id}`,
      }).info(
        `Entraînement neuronal « ${source} » terminé` +
          (job.rapport
            ? ` (intentions: accuracy test ${job.rapport.accuracyTest})`
            : "") +
          (job.rapportDomaines
            ? ` (domaines: accuracy test ${job.rapportDomaines.accuracyTest}, ${job.rapportDomaines.samples} échantillons)`
            : "") +
          (job.rapportOndes
            ? ` (ondes: ${job.rapportOndes.totalEchantillons} échantillons, ${job.rapportOndes.domaines.length} domaine(s), énergie transportée par le bus consolidée)`
            : "") +
          `, langage: ${job.langage.pairesAjoutees} paires ajoutées, sauvegarde: ${sauvegarde}`,
      );
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
