import "server-only";

import { CortexLangagierGen3 } from "@/lib/neural/generation/language";
import type { PaireLangage } from "@/lib/neural/generation/corpus";

import { parserDatasetGen3, separerTrainTest, MAX_PAIRES_DATASET } from "../engines/gen3-dataset";
import type {
  GpuProvider,
  GpuProviderCapabilities,
  ProviderJobState,
  ProviderLogLine,
  SubmitJobPayload,
} from "./types";

/* -------------------------------------------------------------------- */
/* FOURNISSEUR GEN3 LOCAL — le vrai moteur « Gen entraîne vos modèles »  */
/*                                                                      */
/* Contrairement au worker GPU et au mock, CE fournisseur exécute        */
/* RÉELLEMENT l'entraînement, ici, sur le CPU de la plateforme : Gen     */
/* construit un NOUVEAU cerveau Gen3 (un CortexLangagierGen3 vierge) et  */
/* l'entraîne sur les paires question/réponse du dataset de              */
/* l'utilisateur. `simulated` reste FALSE : les métriques (précision     */
/* train/test, vocabulaire, paires) sont MESURÉES, et l'artefact livré   */
/* est le vrai état du modèle entraîné (JSON exportable/importable).     */
/*                                                                      */
/* Déroulé d'une session :                                              */
/*  1. téléchargement + parsing des datasets du split "train" ;          */
/*  2. séparation déterministe train/test (testRatio) ;                  */
/*  3. apprentissage du corpus utilisateur (index IDF + plasticité) ;    */
/*  4. époques réelles : chaque passe mesure la précision de rappel sur  */
/*    le jeu d'entraînement (les rappels réussis renforcent la          */
/*    plasticité d'usage — l'évolution d'époque en époque est mesurée) ; */
/*  5. précision FINALE sur le jeu de test (jamais vu) ;                 */
/*  6. artefact : état complet du modèle (paires + poids d'usage +       */
/*    métriques) archivé dans R2, prêt pour l'export.                    */
/* -------------------------------------------------------------------- */

/** Chargeurs injectables (R2 par défaut ; mémoire pour les tests). */
export interface ChargeursGen3Local {
  /** Télécharge le contenu d'un dataset (clé de stockage → texte). */
  chargerDataset: (storageKey: string) => Promise<string>;
  /** Archive l'artefact du modèle entraîné → clé de stockage + taille. */
  archiverModele: (storageKey: string, corps: string) => Promise<number>;
}

const chargeursDefaut: ChargeursGen3Local = {
  async chargerDataset(storageKey: string): Promise<string> {
    const { downloadFromR2 } = await import("@/lib/storage/r2");
    const tampon = await downloadFromR2(storageKey, 6 * 1024 * 1024);
    return tampon.toString("utf-8");
  },
  async archiverModele(storageKey: string, corps: string): Promise<number> {
    const { putObject } = await import("@/lib/storage/r2");
    const corpsUtf8 = Buffer.from(corps, "utf-8");
    await putObject({
      key: storageKey,
      body: corpsUtf8,
      contentType: "application/json",
      contentLength: corpsUtf8.byteLength,
    });
    return corpsUtf8.byteLength;
  },
};

let chargeurs: ChargeursGen3Local = chargeursDefaut;

/** Injecte des chargeurs (tests) — usage interne/tests uniquement. */
export function configurerChargeursGen3Local(c: ChargeursGen3Local | null): void {
  chargeurs = c ?? chargeursDefaut;
}

interface SessionGen3 {
  payload: SubmitJobPayload;
  startedAt: number;
  terminee: boolean;
  annulee: boolean;
  erreur: string | null;
  /** 0..100 — progression RÉELLE (phases mesurées, pas un timer). */
  progression: number;
  etapeCourante: string;
  epochsDone: number;
  epochsTotal: number;
  /** Précision de rappel mesurée sur le train (dernière époque). */
  precisionTrain: number | null;
  /** Précision mesurée sur le jeu de test (jamais vu). */
  precisionTest: number | null;
  paires: number;
  vocabulaire: number;
  /** Historique réel de précision par époque. */
  history: Array<{ epoch: number; accuracy: number }>;
  logs: ProviderLogLine[];
  artifactKey: string | null;
  artifactTaille: number;
  /** Métriques complémentaires du run (early stopping, époques économisées). */
  metriquesSupplementaires: Record<string, number>;
}

const sessions = new Map<string, SessionGen3>();

/** Évince les sessions finies les plus anciennes (garde-fou mémoire). */
function evincer(): void {
  if (sessions.size <= 50) return;
  const terminees = [...sessions.entries()].filter(([, s]) => s.terminee);
  for (const [id] of terminees.slice(0, sessions.size - 50)) sessions.delete(id);
}

function log(session: SessionGen3, level: ProviderLogLine["level"], message: string): void {
  session.logs.push({ at: new Date().toISOString(), level, message: message.slice(0, 500) });
  if (session.logs.length > 200) session.logs.splice(0, session.logs.length - 200);
}

/** Arrive de paramètres bruts du plan → nombres bornés sûrs. */
function parametreNombre(payload: SubmitJobPayload, cle: string, defaut: number, min: number, max: number): number {
  const brut = payload.parameters[cle];
  const nombre = typeof brut === "number" ? brut : Number(brut);
  if (!Number.isFinite(nombre)) return defaut;
  return Math.min(max, Math.max(min, nombre));
}

/** Paramètre booléen tolérant d'un plan (bool/number/string). */
function parametreBooleen(payload: SubmitJobPayload, cle: string, defaut: boolean): boolean {
  const brut = payload.parameters[cle];
  if (typeof brut === "boolean") return brut;
  if (typeof brut === "number") return brut !== 0;
  if (typeof brut === "string") return ["1", "true", "vrai", "on", "yes"].includes(brut.trim().toLowerCase());
  return defaut;
}

/** Construit l'artefact JSON du modèle entraîné (état réel + traçabilité). */
function construireArtefact(session: SessionGen3, modele: CortexLangagierGen3, meta: Record<string, unknown>): string {
  const etat = modele.exporterEtat();
  return JSON.stringify(
    {
      format: "gen3-language-model",
      version: 1,
      moteur: "gen3-native",
      entraineLe: new Date().toISOString(),
      metriques: {
        precisionTrain: session.precisionTrain,
        precisionTest: session.precisionTest,
        paires: session.paires,
        vocabulaire: session.vocabulaire,
        history: session.history,
      },
      modele: etat,
      meta,
    },
    null,
    2,
  );
}

/** Exécute l'entraînement complet (async, chunké, jamais bloquant). */
async function executer(session: SessionGen3): Promise<void> {
  const jobId = session.payload.jobId;
  try {
    // ── 1. Parsing des datasets du split train ─────────────────────────
    session.etapeCourante = "Chargement des datasets";
    session.progression = 4;
    const datasetsTrain = session.payload.datasets.filter((d) => d.split === "train");
    if (datasetsTrain.length === 0) {
      throw new Error("Aucun dataset du split train : l'entraînement Gen3 natif exige au moins un dataset valide.");
    }
    const toutesPaires: Array<{ question: string; reponse: string }> = [];
    const avertissements: string[] = [];
    for (const dataset of datasetsTrain) {
      const contenu = await chargeurs.chargerDataset(dataset.storageKey);
      const resultat = parserDatasetGen3(dataset.format, contenu);
      toutesPaires.push(...resultat.paires);
      avertissements.push(...resultat.avertissements);
      log(
        session,
        "info",
        `Dataset ${dataset.storageKey.split("/").pop() ?? dataset.storageKey} (${dataset.format}) : ${resultat.paires.length} paire(s) retenue(s), ${resultat.ignores} ignorée(s).`,
      );
      for (const avert of resultat.avertissements.slice(0, 3)) log(session, "warn", avert);
    }
    if (toutesPaires.length < 4) {
      throw new Error(
        `Seulement ${toutesPaires.length} paire(s) exploitable(s) : au moins 4 sont nécessaires pour mesurer une précision honnête (train + test).`,
      );
    }
    log(session, "info", `${toutesPaires.length} paire(s) au total — cap ${MAX_PAIRES_DATASET} respecté.`);
    session.progression = 10;

    // ── 2. Séparation déterministe train / test ────────────────────────
    const ratioTest = parametreNombre(session.payload, "testRatio", 0.15, 0.05, 0.3);
    const { train, test } = separerTrainTest(toutesPaires, ratioTest);
    log(session, "info", `Séparation train/test : ${train.length} apprentissage, ${test.length} test (ratio ${ratioTest}).`);

    // ── 3. Apprentissage réel : Gen construit le modèle de l'utilisateur ─
    session.etapeCourante = "Apprentissage du corpus";
    session.progression = 15;
    await new Promise((resolve) => setImmediate(resolve));
    const modele = new CortexLangagierGen3();
    const pairesLangage: PaireLangage[] = train.map((p) => ({ motif: p.question, reponse: p.reponse, theme: "utilisateur" }));
    const stats = modele.apprendre(pairesLangage, { personnalisees: true });
    session.paires = stats.pairesAjoutees;
    session.vocabulaire = stats.vocabulaire;
    log(
      session,
      "info",
      `Modèle entraîné : ${stats.pairesAjoutees} paire(s) apprise(s) (${stats.pairesDoublons} doublon(s)), vocabulaire ${stats.vocabulaire} tokens.`,
    );

    // ── 4. Époques réelles : mesure + plasticité d'usage ───────────────
    // EARLY STOPPING (2026-10-25) : quand la précision train stagne pendant
    // « patience » époques consécutives (minDelta 0.5 pt), l'entraînement
    // s'arrête honnêtement — la plasticité d'usage n'apporte plus rien, les
    // époques restantes ne feraient que brûler du temps.
    const epochs = parametreNombre(session.payload, "epochs", 5, 1, 30);
    const earlyStopping = parametreBooleen(session.payload, "earlyStopping", true);
    const patience = 2;
    const minDelta = 0.005;
    session.epochsTotal = epochs;
    session.etapeCourante = "Époques d'entraînement";
    let meilleurePrecision = 0;
    let epoquesSansGain = 0;
    let arretAnticipe = false;
    for (let epoch = 1; epoch <= epochs && !session.annulee; epoch += 1) {
      let reussites = 0;
      for (const paire of train) {
        if (session.annulee) break;
        const reponse = modele.repondre(paire.question);
        // Rappel correct = la réponse restituée est celle attendue.
        if (reponse && reponse.texte === paire.reponse) reussites += 1;
      }
      const precision = train.length > 0 ? reussites / train.length : 0;
      session.history.push({ epoch, accuracy: Number(precision.toFixed(4)) });
      session.precisionTrain = precision;
      session.epochsDone = epoch;
      session.progression = Math.min(90, 15 + Math.round((epoch / epochs) * 75));
      log(session, "info", `Époque ${epoch}/${epochs} : précision train ${(precision * 100).toFixed(1)} %.`);

      // Early stopping : plateau détecté → arrêt économique documenté.
      if (earlyStopping) {
        if (precision > meilleurePrecision + minDelta) {
          meilleurePrecision = precision;
          epoquesSansGain = 0;
        } else {
          epoquesSansGain += 1;
          if (epoquesSansGain >= patience && epoch < epochs) {
            arretAnticipe = true;
            log(
              session,
              "info",
              `ARRÊT ANTICIPÉ à l'époque ${epoch}/${epochs} : précision en plateau depuis ${patience} époques (meilleur : ${(meilleurePrecision * 100).toFixed(1)} %) — sur-apprentissage évité, époques restantes économisées.`,
            );
            break;
          }
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (arretAnticipe) {
      session.metriquesSupplementaires = {
        early_stopped: 1,
        epochs_effectuees: session.epochsDone,
      };
    }
    if (session.annulee) {
      session.terminee = true;
      log(session, "warn", "Entraînement annulé : aucun artefact n'a été produit.");
      return;
    }

    // ── 5. Précision sur le jeu de test (jamais vu) ────────────────────
    session.etapeCourante = "Évaluation finale";
    session.progression = 92;
    let reussitesTest = 0;
    for (const paire of test) {
      const reponse = modele.repondre(paire.question);
      if (reponse && reponse.texte === paire.reponse) reussitesTest += 1;
    }
    session.precisionTest = test.length > 0 ? reussitesTest / test.length : null;
    log(
      session,
      "info",
      test.length > 0
        ? `Précision test (jamais vu) : ${(session.precisionTest! * 100).toFixed(1)} % sur ${test.length} paire(s).`
        : "Aucun jeu de test (dataset trop petit) : seule la précision train est mesurée.",
    );

    // ── 6. Artefact : le vrai modèle, exportable ───────────────────────
    session.etapeCourante = "Archivage du modèle";
    session.progression = 96;
    const artifactKey = `training/gen3-native/${jobId}/gen3-model.json`;
    const artefact = construireArtefact(session, modele, {
      jobId,
      engineId: session.payload.engineId,
      method: session.payload.method,
      datasets: session.payload.datasets.map((d) => ({ format: d.format, split: d.split })),
      avertissements,
    });
    const taille = await chargeurs.archiverModele(artifactKey, artefact);
    session.artifactKey = artifactKey;
    session.artifactTaille = taille;
    session.progression = 100;
    session.terminee = true;
    log(session, "info", `Modèle Gen3 archivé (${taille} octets) — exportable depuis le Studio.`);
  } catch (erreur) {
    session.erreur = erreur instanceof Error ? erreur.message : "Échec inconnu de l'entraînement Gen3 natif.";
    session.terminee = true;
    log(session, "error", session.erreur);
  }
}

/** Le fournisseur réel local — simulated reste FALSE partout. */
export function creerFournisseurGen3Local(): GpuProvider {
  return {
    id: "gen3-local",
    label: "Gen3 natif (local — entraîné par Gen)",
    engines: ["gen3-native"],

    async capabilities(): Promise<GpuProviderCapabilities> {
      return {
        providerId: "gen3-local",
        label: "Gen3 natif (local — entraîné par Gen)",
        gpus: [{ name: "CPU Gen3 (plateforme)", vramGb: 0, available: true }],
        maxDurationMinutes: 30,
        simulated: false,
      };
    },

    async submit(payload: SubmitJobPayload): Promise<{ externalId: string }> {
      evincer();
      const externalId = `gen3-${payload.jobId}`;
      const session: SessionGen3 = {
        payload,
        startedAt: Date.now(),
        terminee: false,
        annulee: false,
        erreur: null,
        progression: 2,
        etapeCourante: "Démarrage",
        epochsDone: 0,
        epochsTotal: parametreNombre(payload, "epochs", 5, 1, 30),
        precisionTrain: null,
        precisionTest: null,
        paires: 0,
        vocabulaire: 0,
        history: [],
        logs: [
          {
            at: new Date().toISOString(),
            level: "info",
            message: "Entraînement RÉEL par l'IA Gen3ia : votre dataset est appris par un cerveau Gen3 dédié (CPU local, aucun simulacre).",
          },
        ],
        artifactKey: null,
        artifactTaille: 0,
        metriquesSupplementaires: {},
      };
      sessions.set(externalId, session);
      void executer(session);
      return { externalId };
    },

    async status(externalId: string): Promise<ProviderJobState> {
      const session = sessions.get(externalId);
      if (!session) throw new Error("Session Gen3 inconnue (expirée après redémarrage du process) : relancez la tâche.");
      const status: ProviderJobState["status"] = session.terminee
        ? session.erreur
          ? "failed"
          : "completed"
        : "running";
      return {
        externalId,
        status,
        progressPercent: session.progression,
        currentStep: session.etapeCourante,
        epochsDone: session.epochsDone,
        epochsTotal: session.epochsTotal,
        // Convention honnête : « perte » = erreur de rappel (1 − précision).
        trainLoss: session.precisionTrain !== null ? 1 - session.precisionTrain : null,
        metrics: {
          ...(session.precisionTrain !== null ? { precisionTrain: session.precisionTrain } : {}),
          ...(session.precisionTest !== null ? { precisionTest: session.precisionTest } : {}),
          pairesApprises: session.paires,
          vocabulaire: session.vocabulaire,
          ...session.metriquesSupplementaires,
        },
        logs: session.logs,
        error: session.erreur,
        artifacts:
          session.artifactKey && session.terminee && !session.erreur
            ? [{ label: "Modèle Gen3 entraîné (JSON)", storageKey: session.artifactKey, sizeBytes: session.artifactTaille }]
            : [],
      };
    },

    async cancel(externalId: string): Promise<void> {
      const session = sessions.get(externalId);
      if (session && !session.terminee) session.annulee = true;
    },
  };
}

export const gen3LocalProvider: GpuProvider = creerFournisseurGen3Local();
