import "server-only";

import { createRng } from "./core/rng";
import { ReseauNeuronalGen3 } from "./core/network";
import { EspaceFiltreResonant } from "./core/resonant-space";
import { GenerateurAutoOscillation } from "./core/auto-oscillation";
import { NoyauCentralGen3 } from "./core/central-core";
import {
  POOL_UTILISATEUR_IN,
  POOL_INTENTION_GENERALE,
  CANAL_UTILISATEUR_IN,
  CANAL_INTENTION_GENERALE,
} from "./core/types";
import { SystemeExploitationOutils } from "./effectors/tool-os";
import { MoteurSelectionCompetencesOutils } from "./effectors/skills-engine";
import { EffecteurGenerationAudio } from "./effectors/audio";
import type { GenerateurLocalMedia } from "./effectors/audio";
import { EffecteurGenerationVisuelle } from "./effectors/visual";
import { EffecteurGenerationVideo } from "./effectors/video";
import { InterfaceVocaleTelephonique } from "./effectors/voice-phone";
import { NeuralEngine } from "./engine";
import {
  loadBrainState,
  deleteBrainState,
} from "./training/persistence";
import type { TrainingReport } from "./training/trainer";
import { CortexLangagierGen3 } from "./generation/language";
import type { EtatLangage } from "./generation/language";
import { CORPUS_GEN3 } from "./generation/corpus";
import {
  exporterRegistreTokens,
  importerRegistreTokens,
  reinitialiserRegistreTokens,
} from "./encoding/text-encoder";
import { capturerSnapshot } from "./generation/snapshot";
import { genererVisuelNeural, visuelVersDataUri } from "./generation/visual-engine";
import { genererAudioNeural, audioVersDataUri } from "./generation/audio-engine";
import { genererVideoNeural, videoVersDataUri } from "./generation/video-engine";
import { CentralSupervisor, HippocampusMemory } from "./memory/hippocampus";

/**
 * RUNTIME NEURONAL — singleton caché sur globalThis (résiste au HMR de
 * Next.js dev : le cerveau n'est PAS reconstruit à chaque rechargement de
 * module).
 *
 * Assemblage complet du système Gen3 :
 *  - réseau seedé (42 par défaut), espace résonant, générateur de veille ;
 *  - corps sémantique : Tool OS, moteur de compétences, effecteurs audio /
 *    visuel / vidéo / vocal-téléphonique, tous enregistrés au noyau —
 *    les effecteurs média exécutent les MOTEURS LOCAUX RÉELS
 *    (lib/neural/generation/ — SVG, WAV, SVG animé calculés depuis
 *    l'état APPRIS du cerveau, aucune IA externe) ;
 *  - hippocampe (mémoire court terme) + superviseur central (boucle
 *    cognitive Capteurs → Hippocampe → Cortex → Action → Mémoire),
 *    portage du système de l'utilisateur (Inportateur.pdf) ;
 *  - pools d'entrée « utilisateur_in » et de sortie « INTENTION_GENERALE » ;
 *  - VRAIS outils fonctionnels dans le Tool OS (etat_reseau,
 *    lister_competences, rapport_sante, generer_visuel_neural,
 *    generer_signal_audio, generer_animation) — données réelles ;
 *  - au démarrage : tentative de chargement du cerveau persisté
 *    (var/neural/brain-v1.json) → importState si présent.
 */

/** Runtime complet du système neuronal (composants câblés). */
export interface NeuralRuntime {
  /** Le cerveau (réseau de neurones seedé/chargé). */
  reseau: ReseauNeuronalGen3;
  /** Espace d'entrée-sortie résonant (canaux ↔ pools). */
  espace: EspaceFiltreResonant;
  /** Générateur d'auto-oscillation (veille / rêve). */
  veille: GenerateurAutoOscillation;
  /** Tool OS (registre d'outils + sandbox). */
  toolOs: SystemeExploitationOutils;
  /** Moteur de sélection de compétences (catalogue réel). */
  moteurCompetences: MoteurSelectionCompetencesOutils;
  /** Effecteur audio (moteur local réel — synthèse WAV). */
  effecteurAudio: EffecteurGenerationAudio;
  /** Effecteur visuel (moteur local réel — composition SVG). */
  effecteurVisuel: EffecteurGenerationVisuelle;
  /** Effecteur vidéo (moteur local réel — animation SVG SMIL). */
  effecteurVideo: EffecteurGenerationVideo;
  /** Interface vocale & téléphonique (moteurs externes déconnectés — honnête). */
  interfaceVocale: InterfaceVocaleTelephonique;
  /** Noyau central (orchestration des cycles + horloge virtuelle `time`). */
  noyau: NoyauCentralGen3;
  /** Moteur adapté au contrat IA du projet (generate/generateStream). */
  engine: NeuralEngine;
  /** Hippocampe — mémoire de travail à court terme (fenêtre de discussion). */
  hippocampe: HippocampusMemory;
  /** Superviseur central — boucle cognitive complète. */
  superviseur: CentralSupervisor;
  /**
   * Cortex langagier — noyau de génération de langage (corpus appris +
   * paires personnalisées du Studio d'entraînement + plasticité d'usage).
   */
  cortex: CortexLangagierGen3;
  /** Historique des rapports d'entraînement persistés (données réelles). */
  historiqueEntrainement: TrainingReport[];
  /** Date ISO de création du runtime. */
  creeLe: string;
}

/** Emplacement du singleton sur globalThis (résiste au HMR). */
const globalAvecNeural = globalThis as typeof globalThis & {
  __gen3NeuralRuntime?: NeuralRuntime;
};

/** Graine par défaut du runtime (reproductibilité). */
export const SEED_RUNTIME = 42;

/**
 * Retourne le runtime neuronal complet (singleton). Le premier appel
 * construit et câble tout le système, puis tente de restaurer le cerveau
 * persisté si présent.
 */
export function getNeuralRuntime(): NeuralRuntime {
  const existant = globalAvecNeural.__gen3NeuralRuntime;
  if (existant) return existant;

  // 1. Cerveau + espace résonant + veille (RNG seedé pour le bruit de fond).
  const reseau = new ReseauNeuronalGen3({ seed: SEED_RUNTIME });
  const espace = new EspaceFiltreResonant();
  const veille = new GenerateurAutoOscillation(
    reseau,
    0.15,
    0.15,
    createRng(SEED_RUNTIME + 1),
  );

  // 2. Moteurs locaux RÉELS des effecteurs média : le contenu est calculé
  //    depuis l'état APPRIS du cerveau (poids synaptiques, histogramme) —
  //    déterministe, aucune IA externe, aucun simulacre.
  const moteurVisuelLocal: GenerateurLocalMedia = (args) => {
    const prompt =
      typeof args["prompt"] === "string" && args["prompt"].length > 0
        ? args["prompt"]
        : "Fractale neuronale abstraite";
    const ratio =
      typeof args["ratio"] === "string" ? args["ratio"] : args["resolution"] ?? "1:1";
    const snapshot = capturerSnapshot(reseau, prompt);
    const rendu = genererVisuelNeural(prompt, String(ratio), snapshot);
    return {
      statut_rendu: "TERMINE",
      mime: "image/svg+xml",
      data_uri: visuelVersDataUri(rendu.svg),
      resolution: `${rendu.width}x${rendu.height}`,
      meta: rendu.meta,
      prompt,
    };
  };

  const moteurAudioLocal: GenerateurLocalMedia = (args) => {
    const prompt =
      typeof args["prompt"] === "string" && args["prompt"].length > 0
        ? args["prompt"]
        : "Signal d'harmonique pure et pulsation fluide";
    const duree =
      typeof args["duree_secondes"] === "number" ? args["duree_secondes"] : 3;
    const frequence =
      typeof args["frequence_echantillonnage"] === "number"
        ? args["frequence_echantillonnage"]
        : 22050;
    const snapshot = capturerSnapshot(reseau, prompt);
    const rendu = genererAudioNeural(prompt, duree, frequence, snapshot);
    return {
      statut_rendu: "TERMINE",
      mime: "audio/wav",
      data_uri: audioVersDataUri(rendu.wav),
      duree: rendu.dureeSecondes,
      frequence: rendu.sampleRate,
      octets: rendu.wav.length,
      meta: rendu.meta,
      prompt,
    };
  };

  const moteurVideoLocal: GenerateurLocalMedia = (args) => {
    const prompt =
      typeof args["prompt"] === "string" && args["prompt"].length > 0
        ? args["prompt"]
        : "Transition fluide de structures neuronales";
    const duree =
      typeof args["duree_secondes"] === "number" ? args["duree_secondes"] : 4;
    const snapshot = capturerSnapshot(reseau, prompt);
    const rendu = genererVideoNeural(prompt, duree, snapshot);
    return {
      statut_rendu: "TERMINE",
      mime: "image/svg+xml",
      data_uri: videoVersDataUri(rendu.svg),
      duree: rendu.dureeSecondes,
      resolution: `${rendu.width}x${rendu.height}`,
      meta: rendu.meta,
      prompt,
    };
  };

  // 3. Corps sémantique (chaque effecteur enregistre ses pools de sortie).
  const toolOs = new SystemeExploitationOutils(espace);
  const moteurCompetences = new MoteurSelectionCompetencesOutils(espace);
  const effecteurAudio = new EffecteurGenerationAudio(espace, toolOs, moteurAudioLocal);
  const effecteurVisuel = new EffecteurGenerationVisuelle(espace, toolOs, moteurVisuelLocal);
  const effecteurVideo = new EffecteurGenerationVideo(espace, toolOs, moteurVideoLocal);
  const interfaceVocale = new InterfaceVocaleTelephonique(espace);

  // 4. Noyau central avec tous les effecteurs enregistrés.
  const noyau = new NoyauCentralGen3(reseau, espace, veille);
  noyau.enregistrerEffecteur(toolOs);
  noyau.enregistrerEffecteur(moteurCompetences);
  noyau.enregistrerEffecteur(effecteurAudio);
  noyau.enregistrerEffecteur(effecteurVisuel);
  noyau.enregistrerEffecteur(effecteurVideo);
  noyau.enregistrerEffecteur(interfaceVocale);

  // 5. Pools d'entrée/sortie du runtime (les pools média sont enregistrés
  //    par leurs effecteurs respectifs — cf. constructeurs ci-dessus).
  espace.registerInputPool(CANAL_UTILISATEUR_IN, [...POOL_UTILISATEUR_IN]);
  espace.registerOutputPool(CANAL_INTENTION_GENERALE, [...POOL_INTENTION_GENERALE]);

  // 6. VRAIS outils fonctionnels du Tool OS : données réelles du réseau +
  //    génération média locale réelle (contenu complet dans la réponse).
  toolOs.enregistrerOutil(
    "etat_reseau",
    () => ({
      stats: reseau.getStats(),
      sante: { ...noyau.metriquesSante },
      horlogeVirtuelle: noyau.time,
    }),
    "Statistiques complètes du réseau neuronal (compteurs, poids, histogramme, santé).",
  );
  toolOs.enregistrerOutil(
    "lister_competences",
    () =>
      Array.from(moteurCompetences.catalogueSkills.entries()).map(
        ([nom, meta]) => ({ nom, ...meta }),
      ),
    "Catalogue des compétences cibles indexées par le moteur de compétences.",
  );
  toolOs.enregistrerOutil(
    "rapport_sante",
    () => ({ ...noyau.metriquesSante }),
    "Rapport de santé du noyau central (cycles, énergie, homéostasie, mode).",
  );
  toolOs.enregistrerOutil(
    "generer_visuel_neural",
    moteurVisuelLocal,
    "Génère une composition visuelle SVG calculée depuis l'état réel du réseau (moteur local, aucune IA externe).",
  );
  toolOs.enregistrerOutil(
    "generer_signal_audio_neural",
    moteurAudioLocal,
    "Synthétise un signal WAV calculé depuis l'histogramme réel des poids synaptiques (moteur local).",
  );
  toolOs.enregistrerOutil(
    "generer_animation_neurale",
    moteurVideoLocal,
    "Génère une animation vectorielle SVG SMIL calculée depuis l'état réel du réseau (moteur local).",
  );

  // 7. Hippocampe + Superviseur central (boucle cognitive de l'utilisateur).
  const hippocampe = new HippocampusMemory(10);
  const superviseur = new CentralSupervisor(noyau, reseau, 5);

  // 8. Cortex langagier : corpus d'amorçage canonique (réappris à chaque
  //    démarrage, pur et déterministe) — les paires personnalisées seront
  //    restaurées à l'étape 9 depuis la persistance du cerveau.
  const cortex = new CortexLangagierGen3();
  const statsCorpus = cortex.apprendre(CORPUS_GEN3);

  // 9. Moteur IA adapté au contrat du projet (cortex + hippocampe câblés :
  //    conversation réelle + mémoire de reprise).
  const engine = new NeuralEngine(noyau, espace, cortex, hippocampe);

  const runtime: NeuralRuntime = {
    reseau,
    espace,
    veille,
    toolOs,
    moteurCompetences,
    effecteurAudio,
    effecteurVisuel,
    effecteurVideo,
    interfaceVocale,
    noyau,
    engine,
    hippocampe,
    superviseur,
    cortex,
    historiqueEntrainement: [],
    creeLe: new Date().toISOString(),
  };

  // 10. Démarrage : tente de restaurer le cerveau persisté (synchrone, unique).
  const etat = loadBrainState();
  if (etat) {
    reseau.importState({ config: etat.config, synapses: etat.synapses });
    importerRegistreTokens(etat.tokenRegistry);
    runtime.historiqueEntrainement = [...etat.trainingHistory];
    // Paires langagières personnalisées + poids d'usage appris.
    if (etat.langage) {
      const statsLangage = cortex.importerEtat(etat.langage);
      console.log(
        `[NEURAL] Langage restauré : ${statsLangage.pairesAjoutees} paire(s) personnalisée(s), vocabulaire ${cortex.tailleVocabulaire} tokens.`,
      );
    }
    console.log(
      `[NEURAL] Cerveau persisté restauré : ${etat.synapses.length} synapses, ${Object.keys(etat.tokenRegistry).length} neurones lexicaux (sauvegardé le ${etat.sauvegardeLe}).`,
    );
  } else {
    console.log(
      `[NEURAL] Cortex langagier amorcé : ${statsCorpus.pairesAjoutees} paires, vocabulaire ${statsCorpus.vocabulaire} tokens.`,
    );
  }

  globalAvecNeural.__gen3NeuralRuntime = runtime;
  return runtime;
}

/**
 * Reset complet du cerveau : purge du fichier persisté, remise à zéro du
 * registre lexical, reconstruction intégrale du runtime (nouveau réseau
 * seedé + cortex langagier réamorcé sur le corpus canonique). Retourne le
 * nouveau runtime.
 */
export function resetBrain(): NeuralRuntime {
  deleteBrainState();
  reinitialiserRegistreTokens();
  globalAvecNeural.__gen3NeuralRuntime = undefined;
  return getNeuralRuntime();
}

/**
 * Sauvegarde le cerveau courant (réseau + registre lexical + état du cortex
 * langagier + historique d'entraînement du runtime) — commodité serveur.
 */
export async function sauvegarderCerveauRuntime(): Promise<boolean> {
  const runtime = getNeuralRuntime();
  const { saveBrainState } = await import("./training/persistence");
  const langage: EtatLangage = runtime.cortex.exporterEtat();
  return saveBrainState(
    runtime.reseau,
    exporterRegistreTokens(),
    runtime.historiqueEntrainement,
    langage,
  );
}
