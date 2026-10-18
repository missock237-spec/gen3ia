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
import { EffecteurGenerationVisuelle } from "./effectors/visual";
import { EffecteurGenerationVideo } from "./effectors/video";
import { InterfaceVocaleTelephonique } from "./effectors/voice-phone";
import { NeuralEngine } from "./engine";
import {
  loadBrainState,
  deleteBrainState,
} from "./training/persistence";
import type { TrainingReport } from "./training/trainer";
import {
  exporterRegistreTokens,
  importerRegistreTokens,
  reinitialiserRegistreTokens,
} from "./encoding/text-encoder";

/**
 * RUNTIME NEURONAL — singleton caché sur globalThis (résiste au HMR de
 * Next.js dev : le cerveau n'est PAS reconstruit à chaque rechargement de
 * module).
 *
 * Assemblage complet du système Gen3 en mode neuronal :
 *  - réseau seedé (42 par défaut), espace résonant, générateur de veille ;
 *  - corps sémantique : Tool OS, moteur de compétences, effecteurs audio /
 *    visuel / vidéo / vocal-téléphonique, tous enregistrés au noyau ;
 *  - pools d'entrée « utilisateur_in » et de sortie « INTENTION_GENERALE » ;
 *  - VRAIS outils fonctionnels dans le Tool OS (etat_reseau, lister_competences,
 *    rapport_sante) — données réelles du réseau et du noyau ;
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
  /** Effecteur audio (moteur externe déconnecté — honnête). */
  effecteurAudio: EffecteurGenerationAudio;
  /** Effecteur visuel (moteur externe déconnecté — honnête). */
  effecteurVisuel: EffecteurGenerationVisuelle;
  /** Effecteur vidéo (moteur externe déconnecté — honnête). */
  effecteurVideo: EffecteurGenerationVideo;
  /** Interface vocale & téléphonique (moteurs externes déconnectés — honnête). */
  interfaceVocale: InterfaceVocaleTelephonique;
  /** Noyau central (orchestration des cycles + horloge virtuelle `time`). */
  noyau: NoyauCentralGen3;
  /** Moteur adapté au contrat IA du projet (generate/generateStream). */
  engine: NeuralEngine;
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

  // 2. Corps sémantique (chaque effecteur enregistre ses pools de sortie).
  const toolOs = new SystemeExploitationOutils(espace);
  const moteurCompetences = new MoteurSelectionCompetencesOutils(espace);
  const effecteurAudio = new EffecteurGenerationAudio(espace, toolOs);
  const effecteurVisuel = new EffecteurGenerationVisuelle(espace, toolOs);
  const effecteurVideo = new EffecteurGenerationVideo(espace, toolOs);
  const interfaceVocale = new InterfaceVocaleTelephonique(espace);

  // 3. Noyau central avec tous les effecteurs enregistrés.
  const noyau = new NoyauCentralGen3(reseau, espace, veille);
  noyau.enregistrerEffecteur(toolOs);
  noyau.enregistrerEffecteur(moteurCompetences);
  noyau.enregistrerEffecteur(effecteurAudio);
  noyau.enregistrerEffecteur(effecteurVisuel);
  noyau.enregistrerEffecteur(effecteurVideo);
  noyau.enregistrerEffecteur(interfaceVocale);

  // 4. Pools d'entrée/sortie du runtime (les pools média sont enregistrés
  //    par leurs effecteurs respectifs — cf. constructeurs ci-dessus).
  espace.registerInputPool(CANAL_UTILISATEUR_IN, [...POOL_UTILISATEUR_IN]);
  espace.registerOutputPool(CANAL_INTENTION_GENERALE, [...POOL_INTENTION_GENERALE]);

  // 5. VRAIS outils fonctionnels du Tool OS : données réelles du réseau.
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

  // 6. Moteur IA adapté au contrat du projet.
  const engine = new NeuralEngine(noyau, espace);

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
    historiqueEntrainement: [],
    creeLe: new Date().toISOString(),
  };

  // 7. Démarrage : tente de restaurer le cerveau persisté (synchrone, unique).
  const etat = loadBrainState();
  if (etat) {
    reseau.importState({ config: etat.config, synapses: etat.synapses });
    importerRegistreTokens(etat.tokenRegistry);
    runtime.historiqueEntrainement = [...etat.trainingHistory];
    console.log(
      `[NEURAL] Cerveau persisté restauré : ${etat.synapses.length} synapses, ${Object.keys(etat.tokenRegistry).length} neurones lexicaux (sauvegardé le ${etat.sauvegardeLe}).`,
    );
  }

  globalAvecNeural.__gen3NeuralRuntime = runtime;
  return runtime;
}

/**
 * Reset complet du cerveau : purge du fichier persisté, remise à zéro du
 * registre lexical, reconstruction intégrale du runtime (nouveau réseau
 * seedé). Retourne le nouveau runtime.
 */
export function resetBrain(): NeuralRuntime {
  deleteBrainState();
  reinitialiserRegistreTokens();
  globalAvecNeural.__gen3NeuralRuntime = undefined;
  return getNeuralRuntime();
}

/**
 * Sauvegarde le cerveau courant (réseau + registre lexical + historique
 * d'entraînement du runtime) — commodité serveur pour la Tâche 3.
 */
export async function sauvegarderCerveauRuntime(): Promise<boolean> {
  const runtime = getNeuralRuntime();
  const { saveBrainState } = await import("./training/persistence");
  return saveBrainState(
    runtime.reseau,
    exporterRegistreTokens(),
    runtime.historiqueEntrainement,
  );
}
