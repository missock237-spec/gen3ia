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

/**
 * Mention des médias : la génération média est RÉELLE sur la plateforme
 * (moteurs locaux — visuel SVG, signal WAV, animation SMIL — calculés
 * depuis l'état du cerveau, et service média de conversation qui archive
 * en R2). L'intention seule n'exécute pas le rendu dans CE cycle : le
 * rendu effectif passe par le service média ou les effecteurs du Tool OS.
 */
const MENTION_MEDIAS_PLATEFORME =
  "Sur la plateforme, la création média est prise en charge réellement : envoyez simplement votre demande dans la conversation (ou passez par le Studio média) pour obtenir votre composition neuronale, calculée depuis l'état de mon réseau et archivée pour vous.";

function listeMotsCles(motsCles: string[]): string {
  if (motsCles.length === 0) return "aucun mot-clé distinct";
  return motsCles.join(", ");
}

function formatNombre(valeur: number): string {
  return Number.isInteger(valeur) ? String(valeur) : valeur.toFixed(3);
}

/**
 * Templates PAR INTENTION (composition conversationnelle) : chaque fonction
 * assemble une réponse à la première personne depuis les données réelles du
 * cycle. Les intentions média orientent vers le service média réel de la
 * plateforme ; les intentions d'action décrivent honnêtement ce qui a été
 * exécuté (actions du corps sémantique).
 */
const TEMPLATES_INTENTION: Record<
  string,
  (donnees: DonneesTemplate) => string
> = {
  GENERER_IMAGE: (d) =>
    `J'ai bien reconnu votre envie de créer une image (résonance ${d.score.toFixed(2)}, à partir de : ${listeMotsCles(d.motsCles)}). ${MENTION_MEDIAS_PLATEFORME}`,
  GENERER_AUDIO: (d) =>
    `Intention sonore détectée (résonance ${d.score.toFixed(2)}, à partir de : ${listeMotsCles(d.motsCles)}) — je peux synthétiser un signal audio réel depuis mes poids synaptiques. ${MENTION_MEDIAS_PLATEFORME}`,
  GENERER_VIDEO: (d) =>
    `Intention vidéo détectée (résonance ${d.score.toFixed(2)}, à partir de : ${listeMotsCles(d.motsCles)}) — je compose des animations vectorielles calculées depuis mon état neuronal. ${MENTION_MEDIAS_PLATEFORME}`,
  EXECUTER_OUTIL_OS: (d) =>
    `Je comprends que vous voulez agir sur mes outils (résonance ${d.score.toFixed(2)}, à partir de : ${listeMotsCles(d.motsCles)}). ${
      d.rapport.actionsCorps.some((a) => a.type === "EXECUTER_OUTIL_OS")
        ? "C'est fait : le Tool OS a réellement exécuté l'outil lié à ce cycle en sandbox — les données sont réelles, vous pouvez les consulter."
        : "Le Tool OS n'a rien exécuté ce cycle (l'intention seule a été reconnue) : précisez l'outil voulu et je l'exécute dans ma sandbox."
    }`,
  CARTOGRAPHIER_COMPETENCES: (d) =>
    `Vous m'interrogez sur mes compétences (résonance ${d.score.toFixed(2)}, à partir de : ${listeMotsCles(d.motsCles)}). ${
      d.rapport.actionsCorps.some((a) => a.type === "CARTOGRAPHIER_COMPETENCES")
        ? "J'ai réellement réindexé mon catalogue ce cycle — la liste à jour est disponible via mon outil lister_competences."
        : "Mon catalogue est disponible via mon outil lister_competences : génération de médias, outils système, cartographie des capacités."
    }`,
  SELECTIONNER_ET_EXECUTER_SKILL: (d) =>
    `Intention de compétence détectée (résonance ${d.score.toFixed(2)}, à partir de : ${listeMotsCles(d.motsCles)}). ${
      d.rapport.actionsCorps.some((a) => a.type === "SELECTIONNER_ET_EXECUTER_SKILL")
        ? "Une compétence a réellement été sélectionnée et exécutée ce cycle — son résultat est dans les actions du corps sémantique."
        : "Aucune compétence n'a franchi le seuil d'exécution ce cycle : dites-moi celle que vous voulez et je m'y mets."
    }`,
  EVALUER_PERFORMANCE_SKILL: (d) =>
    `Intention d'évaluation détectée (résonance ${d.score.toFixed(2)}, à partir de : ${listeMotsCles(d.motsCles)}). ${
      d.rapport.actionsCorps.some((a) => a.type === "EVALUER_PERFORMANCE_SKILL")
        ? "Une évaluation réelle a été produite ce cycle — consultez les actions du corps sémantique pour le détail."
        : "Aucune évaluation n'a été produite ce cycle : précisez la compétence à évaluer."
    }`,
  INITIALISER_APPEL: (d) =>
    `J'ai reconnu l'intention d'appel (résonance ${d.score.toFixed(2)}, à partir de : ${listeMotsCles(d.motsCles)}). La téléphonie est une capacité des automatisations de la plateforme (interface dédiée) : je ne déclenche pas d'appel depuis la conversation — mais je peux vous guider vers cette surface.`,
  ECOUTER_AUDIO: (d) =>
    `Intention d'écoute détectée (résonance ${d.score.toFixed(2)}, à partir de : ${listeMotsCles(d.motsCles)}). Je n'ai pas de flux audio en cours dans cette conversation : envoyez-moi un fichier audio en pièce jointe et je l'enregistrerai avec votre message.`,
  EMETTRE_REPONSE_VOCALE: (d) =>
    `Intention vocale détectée (résonance ${d.score.toFixed(2)}, à partir de : ${listeMotsCles(d.motsCles)}). Je réponds en texte ici — la synthèse vocale est disponible sur les surfaces voix de la plateforme.`,
  TERMINER_APPEL: (d) =>
    `Intention de fin d'appel reconnue (résonance ${d.score.toFixed(2)}, à partir de : ${listeMotsCles(d.motsCles)}). Aucune ligne n'est active dans cette conversation : rien à raccrocher, je reste à votre écoute.`,
};

/** Template par défaut : pool reconnu sans template dédié (données réelles). */
function templateGenerique(donnees: DonneesTemplate): string {
  return `J'ai reconnu l'intention « ${intentionPool(donnees)} » dans votre message (résonance ${donnees.score.toFixed(2)}, à partir de : ${listeMotsCles(donnees.motsCles)}). C'est une intention que je détecte mais que je ne sais pas encore exécuter ici — reformulez ou consultez la documentation de la plateforme pour la surface adaptée.`;
}

/** Nom d'intention sûr pour l'affichage (données réelles du rapport). */
function intentionPool(donnees: DonneesTemplate): string {
  return donnees.rapport.sante.modeActuel;
}

/** Assemble le message d'intention générale (conversationnel, données 100 % réelles). */
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

  const sujet =
    donnees.motsCles.length > 0
      ? `J'ai perçu les mots-clés : ${listeMotsCles(donnees.motsCles)}.`
      : "Votre message est arrivé sans mot-clé distinct que je connaisse encore.";

  return [
    `Je vous réponds en toute honnêteté : aucune de mes compétences conversationnelles n'a été retenue pour ce message (meilleure résonance ${meilleurScore.toFixed(2)} sur ${pools.length} pools écoutés).`,
    sujet,
    `Mon réseau tourne normalement (${formatNombre(rapport.sante.cyclesTotaux)} cycles exécutés, homéostasie ${rapport.sante.indiceHomeostasie.toFixed(2)}, ${rapport.neuronesActifs} neurone(s) actif(s)) — mais cette question sort de ce que j'ai appris jusqu'ici.`,
    `Je préfère vous le dire franchement plutôt que d'inventer : reformulez votre demande, ou alimentez mon entraînement depuis le Studio d'entraînement de la plateforme.`,
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
