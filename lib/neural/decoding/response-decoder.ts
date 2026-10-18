/**
 * DÉCODAGE DE RÉPONSE NEURONALE → TEXTE FRANÇAIS HONNÊTE.
 *
 * Le réseau neuronal Gen3 n'est PAS un modèle de langage : il ne génère pas
 * de contenu. Ce décodeur traduit l'état RÉEL du réseau (résonances des pools
 * d'intention, mots-clés captés, métriques de santé, actions du corps) en un
 * message français explicite. AUCUNE invention de contenu : chaque phrase est
 * alimentée par des données réelles du CycleReport et des résonances
 * mesurées, et les intentions média déclarent honnêtement que le moteur de
 * rendu externe est déconnecté en mode neuronal.
 *
 * Module PUR — aucune dépendance Node.
 */

import { INTENTION_GENERALE } from "../core/types";
import type { CycleReport } from "../core/types";

/** Réponse décodée du moteur neuronal. */
export interface NeuralDecodedResponse {
  /** Message français assemblé (honnête, données réelles uniquement). */
  texte: string;
  /** Intention gagnante (nom du pool) ou INTENTION_GENERALE. */
  intention: string;
  /** Score de résonance de l'intention gagnante. */
  scoreResonance: number;
  /** Résonances complètes mesurées ce cycle { pool → score }. */
  resonances: Record<string, number>;
  /** Mots-clés réellement captés dans le prompt. */
  motsCles: string[];
}

/** Options de décodage. */
export interface DecodageOptions {
  /** Seuil de détection d'intention (défaut 0.5). */
  seuilIntention?: number;
}

/**
 * DÉCODAGE PAR LATENCE (standard des réseaux à spikes) : poids de la
 * résonance d'un pool selon le cycle (index 0-based) de la fenêtre
 * d'inférence où il a spiké.
 *   - cycles 1-2 (index 0-1) → poids 1.0 : un pool ENTRAÎNÉ, dont les
 *     synapses depuis la zone de tokens sont renforcées, atteint son seuil
 *     tôt dans la fenêtre ;
 *   - cycle 3 (index 2) → poids 0.75 ;
 *   - cycle 4+ (index ≥ 3) → poids 0.5 : un pool activé uniquement par le
 *     bruit des synapses aléatoires initiales n'accumule assez d'énergie
 *     qu'en fin de fenêtre.
 * Pondérer la résonance par la latence du spike sépare le signal appris du
 * bruit synaptique — sans cela, les pools « chanceux » (une synapse
 * aléatoire forte depuis un token stimulé) s'activent en fin de fenêtre au
 * même moment que les pools entraînés et l'argmax devient aléatoire.
 */
export function poidsResonanceParCycle(indexCycle: number): number {
  if (indexCycle <= 1) return 1.0;
  if (indexCycle === 2) return 0.75;
  return 0.5;
}

/** Données réelles injectées dans les templates. */
interface DonneesTemplate {
  score: number;
  motsCles: string[];
  rapport: CycleReport;
}

/** Mention honnête commune aux intentions média (moteur externe déconnecté). */
const MENTION_MOTEUR_EXTERNE =
  "Le moteur de rendu externe est déconnecté en mode neuronal (test SNN) : aucune sortie média n'a été produite — l'intention a bien été reconnue par le réseau, l'exécution du rendu n'a pas eu lieu.";

function listeMotsCles(motsCles: string[]): string {
  if (motsCles.length === 0) return "aucun mot-clé distinct";
  return motsCles.join(", ");
}

function formatNombre(valeur: number): string {
  return Number.isInteger(valeur) ? String(valeur) : valeur.toFixed(3);
}

/**
 * Templates par intention : chaque fonction assemble un message en français à
 * partir des données réelles du cycle. Les pools média/télécom mentionnent
 * honnêtement l'absence du moteur externe.
 */
const TEMPLATES_INTENTION: Record<
  string,
  (donnees: DonneesTemplate) => string
> = {
  GENERER_IMAGE: (d) =>
    `Résonance visuelle détectée (score ${d.score.toFixed(2)}). L'intention « générer une image » a bien été reconnue par le réseau neuronal à partir des mots-clés : ${listeMotsCles(d.motsCles)}. ${MENTION_MOTEUR_EXTERNE}`,
  GENERER_AUDIO: (d) =>
    `Résonance sonore détectée (score ${d.score.toFixed(2)}). L'intention « générer un signal audio » a bien été reconnue par le réseau neuronal à partir des mots-clés : ${listeMotsCles(d.motsCles)}. ${MENTION_MOTEUR_EXTERNE}`,
  GENERER_VIDEO: (d) =>
    `Résonance vidéo détectée (score ${d.score.toFixed(2)}). L'intention « générer une séquence vidéo » a bien été reconnue par le réseau neuronal à partir des mots-clés : ${listeMotsCles(d.motsCles)}. ${MENTION_MOTEUR_EXTERNE}`,
  EXECUTER_OUTIL_OS: (d) =>
    `Résonance d'exécution d'outil détectée (score ${d.score.toFixed(2)}). Le réseau neuronal a reconnu l'intention d'exécuter un outil du système (mots-clés : ${listeMotsCles(d.motsCles)}). ${
      d.rapport.actionsCorps.some((a) => a.type === "EXECUTER_OUTIL_OS")
        ? "Une commande d'outil était liée à ce cycle : le Tool OS l'a exécutée en sandbox (voir les actions du corps sémantique)."
        : "Aucune commande d'outil n'était liée à ce cycle : le Tool OS n'a rien exécuté (l'intention seule a été détectée)."
    }`,
  CARTOGRAPHIER_COMPETENCES: (d) =>
    `Résonance de cartographie détectée (score ${d.score.toFixed(2)}). Le réseau neuronal a reconnu l'intention d'indexer le catalogue de compétences (mots-clés : ${listeMotsCles(d.motsCles)}). ${
      d.rapport.actionsCorps.some((a) => a.type === "CARTOGRAPHIER_COMPETENCES")
        ? "Le moteur de compétences a réellement indexé le catalogue ce cycle."
        : "Le seuil d'action du moteur de compétences n'a pas été franchi ce cycle : seule l'intention a été détectée."
    }`,
  SELECTIONNER_ET_EXECUTER_SKILL: (d) =>
    `Résonance de compétence détectée (score ${d.score.toFixed(2)}). Le réseau neuronal a reconnu l'intention de sélectionner et d'exécuter une compétence (mots-clés : ${listeMotsCles(d.motsCles)}). ${
      d.rapport.actionsCorps.some(
        (a) => a.type === "SELECTIONNER_ET_EXECUTER_SKILL",
      )
        ? "Une compétence a réellement été sélectionnée ce cycle (voir les actions du corps sémantique)."
        : "Aucune compétence n'a été sélectionnée ce cycle : l'intention seule a été détectée."
    }`,
  EVALUER_PERFORMANCE_SKILL: (d) =>
    `Résonance d'évaluation détectée (score ${d.score.toFixed(2)}). Le réseau neuronal a reconnu l'intention d'évaluer la performance d'une compétence (mots-clés : ${listeMotsCles(d.motsCles)}). ${
      d.rapport.actionsCorps.some((a) => a.type === "EVALUER_PERFORMANCE_SKILL")
        ? "Une évaluation réelle a été produite ce cycle (voir les actions du corps sémantique)."
        : "Aucune évaluation n'a été produite ce cycle : l'intention seule a été détectée."
    }`,
  INITIALISER_APPEL: (d) =>
    `Résonance d'appel téléphonique détectée (score ${d.score.toFixed(2)}). Le réseau neuronal a reconnu l'intention d'initier un appel (mots-clés : ${listeMotsCles(d.motsCles)}). Le moteur d'appels externe (Bland) est déconnecté en mode neuronal (test SNN) : aucun appel n'a été émis, aucun numéro n'a été composé.`,
  ECOUTER_AUDIO: (d) =>
    `Résonance d'écoute détectée (score ${d.score.toFixed(2)}). Le réseau neuronal a reconnu l'intention d'écouter le flux audio entrant (mots-clés : ${listeMotsCles(d.motsCles)}). La transcription vocale externe (STT) est déconnectée en mode neuronal (test SNN) : aucune transcription n'a été produite.`,
  EMETTRE_REPONSE_VOCALE: (d) =>
    `Résonance d'émission vocale détectée (score ${d.score.toFixed(2)}). Le réseau neuronal a reconnu l'intention d'émettre une réponse vocale (mots-clés : ${listeMotsCles(d.motsCles)}). La synthèse vocale externe est déconnectée en mode neuronal (test SNN) : aucun son n'a été émis.`,
  TERMINER_APPEL: (d) =>
    `Résonance de fin d'appel détectée (score ${d.score.toFixed(2)}). Le réseau neuronal a reconnu l'intention de terminer la communication (mots-clés : ${listeMotsCles(d.motsCles)}). Aucune ligne téléphonique n'est active en mode neuronal (test SNN) : aucun raccrochage réel n'a eu lieu.`,
};

/** Template par défaut : pool reconnu sans template dédié (données réelles). */
function templateGenerique(donnees: DonneesTemplate): string {
  return `Intention « ${donnees.rapport.mode === "TRAITEMENT_REQUETE" ? "requête" : "veille"} » : le pool « ${intentionPool(donnees)} » a résonné à ${donnees.score.toFixed(2)} (mots-clés : ${listeMotsCles(donnees.motsCles)}). Le moteur neuronal ne génère pas de contenu : cette réponse reflète l'état réel du réseau.`;
}

/** Nom d'intention sûr pour l'affichage (données réelles du rapport). */
function intentionPool(donnees: DonneesTemplate): string {
  return donnees.rapport.sante.modeActuel;
}

/** Assemble le message d'intention générale (données 100 % réelles). */
function messageIntentionGenerale(
  donnees: DonneesTemplate,
  resonances: Record<string, number>,
): string {
  const { rapport } = donnees;
  const pools = Object.keys(resonances);
  const meilleurScore = pools.reduce(
    (max, pool) => Math.max(max, resonances[pool] ?? 0),
    0,
  );
  return [
    `Réseau neuronal Gen3 en mode ${rapport.mode.toLowerCase()} : aucune intention dominante n'a franchi le seuil de résonance.`,
    `Mots-clés captés : ${listeMotsCles(donnees.motsCles)}.`,
    `Meilleure résonance observée : ${meilleurScore.toFixed(2)} sur ${pools.length} pools écoutés.`,
    `Santé du réseau : ${formatNombre(rapport.sante.cyclesTotaux)} cycles exécutés, énergie moyenne ${rapport.sante.energieMoyenne.toFixed(3)}, indice d'homéostasie ${rapport.sante.indiceHomeostasie.toFixed(2)}, ${rapport.neuronesActifs} neurone(s) actif(s) ce cycle.`,
    `Le moteur neuronal n'est pas un modèle de langage : en mode test SNN, cette réponse reflète uniquement l'état réel du réseau, sans génération de contenu externe.`,
  ].join(" ");
}

/**
 * Décode la réponse du cycle neuronal en message français honnête :
 *  - si le meilleur score de résonance ≥ seuil (0.5) : intention = pool
 *    gagnant, texte assemblé depuis les templates par intention ;
 *  - sinon : message d'intention générale listant les mots-clés captés, le
 *    mode, la santé du réseau et le nombre de neurones actifs.
 *
 * @param cycleReport Rapport réel du dernier cycle exécuté.
 * @param resonances Résonances mesurées sur les pools de sortie.
 * @param motsCles Mots-clés réellement captés dans le prompt d'entrée.
 */
export function decodeResponse(
  cycleReport: CycleReport,
  resonances: Record<string, number>,
  motsCles: string[],
  opts: DecodageOptions = {},
): NeuralDecodedResponse {
  const seuil = opts.seuilIntention ?? 0.5;

  // Pool gagnant : score maximal strictement au-dessus des autres (premier
  // en cas d'égalité parfaite — ordre d'insertion déterministe).
  let intentionGagnante: string | null = null;
  let meilleurScore = 0;
  for (const [pool, score] of Object.entries(resonances)) {
    if (score > meilleurScore) {
      meilleurScore = score;
      intentionGagnante = pool;
    }
  }

  const donnees: DonneesTemplate = {
    score: meilleurScore,
    motsCles,
    rapport: cycleReport,
  };

  if (intentionGagnante !== null && meilleurScore >= seuil) {
    const template =
      TEMPLATES_INTENTION[intentionGagnante] ?? templateGenerique;
    return {
      texte: template(donnees),
      intention: intentionGagnante,
      scoreResonance: meilleurScore,
      resonances: { ...resonances },
      motsCles: [...motsCles],
    };
  }

  return {
    texte: messageIntentionGenerale(donnees, resonances),
    intention: INTENTION_GENERALE,
    scoreResonance: meilleurScore,
    resonances: { ...resonances },
    motsCles: [...motsCles],
  };
}
