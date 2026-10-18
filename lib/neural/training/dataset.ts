import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { tokenize } from "../encoding/text-encoder";
import { INTENTION_GENERALE } from "../core/types";

/**
 * JEU DE DONNÉES D'ENTRAÎNEMENT SUPERVISÉ du moteur neuronal.
 *
 * Le réseau Gen3 apprend ses intentions par plasticité supervisée (cf.
 * training/trainer.ts) : chaque échantillon { text, label } est encodé sur la
 * zone de tokens, propagé k cycles, puis les synapses entrée → pool cible
 * sont renforcées. Ce module fournit :
 *  - INTENT_KEYWORDS : mots-clés FR+EN par pool d'intention ;
 *  - labelText : étiquetage lexical déterministe (premier match) ;
 *  - buildDatasetFromCorpus : découpe d'un corpus (public/llms*.txt) en
 *    phrases étiquetées, équilibrées par label ;
 *  - SEED_EXAMPLES : jeu d'amorçage canonique légitime (48 exemples écrits à
 *    la main, 12 intention générale + 6 par pool d'action) ;
 *  - loadCorpusFromPublic : lecture du corpus réel du dépôt.
 *
 * Le fichier (server-only) ne touche le système de fichiers que dans
 * loadCorpusFromPublic.
 */

/**
 * Mots-clés d'intention (FR + EN, comparaison sur les tokens normalisés sans
 * diacritiques). L'ORDRE des clés définit la priorité d'étiquetage : les pools
 * spécifiques d'abord, l'intention générale en dernier (repli).
 */
export const INTENT_KEYWORDS: Record<string, string[]> = {
  GENERER_IMAGE: [
    "image", "images", "visuel", "visual", "visuels",
    "photo", "photos", "dessin", "dessins", "drawing",
    "dessine", "dessiner", "portrait", "portraits",
    "illustration", "illustrations", "picture", "pictures",
  ],
  GENERER_AUDIO: [
    "audio", "son", "sons", "sound", "sounds", "sonore",
    "musique", "music", "voix", "voice", "podcast", "podcasts",
  ],
  GENERER_VIDEO: [
    "video", "videos", "animation", "animations",
    "film", "films", "clip", "clips", "movie", "movies",
  ],
  EXECUTER_OUTIL_OS: [
    "outil", "outils", "tool", "tools",
    "executer", "execute", "execution", "executions",
    "script", "scripts", "commande", "commandes",
    "command", "commands", "terminal", "shell",
  ],
  SELECTIONNER_ET_EXECUTER_SKILL: [
    "competence", "competences", "skill", "skills",
    "recherche", "search", "analyse", "analysis",
    "parse", "parser", "parsing",
  ],
  // TERMINER_APPEL est testé AVANT INITIALISER_APPEL : les verbes de clôture
  // (raccrocher, termine, clôture...) sont plus spécifiques que les mots
  // génériques d'appel (appel, téléphone...) — « Termine l'appel » doit être
  // étiqueté clôture, pas initiation.
  TERMINER_APPEL: [
    "raccrocher", "raccroche", "raccrochez",
    "terminer", "termine", "hangup", "hang", "cloture",
  ],
  INITIALISER_APPEL: [
    "appeler", "appelle", "appel", "appels", "call", "calls",
    "telephone", "phone", "phoner", "contacter", "contacte",
    "numero", "joindre",
  ],
  // Repli : conversation générale sans intention spécifique.
  [INTENTION_GENERALE]: [
    "bonjour", "salut", "hello", "coucou", "merci",
    "revoir", "parler", "discuter", "conversation", "chat",
  ],
};

/** Labels intentionnels connus (ordre d'étiquetage déterministe). */
export const LABELS_INTENTION: readonly string[] = Object.keys(INTENT_KEYWORDS);

/**
 * Étiquette lexicale d'un texte : PREMIER label dont l'un des mots-clés
 * apparaît parmi les tokens normalisés ; sinon INTENTION_GENERALE (repli
 * explicite — le pool 68-69 existe aussi comme intention apprise).
 */
export function labelText(text: string): string {
  const tokens = new Set(tokenize(text));
  for (const label of LABELS_INTENTION) {
    const motsCles = INTENT_KEYWORDS[label];
    for (const mot of motsCles) {
      if (tokens.has(mot)) return label;
    }
  }
  return INTENTION_GENERALE;
}

/** Options de construction du jeu de données. */
export interface DatasetOptions {
  /** Nombre maximal d'échantillons par label (défaut 120). */
  maxParLabel?: number;
  /** Nombre total maximal d'échantillons (défaut 2500). */
  maxTotal?: number;
  /** Inclure les exemples d'amorçage canoniques (défaut false — le corpus seul est demandé). */
  inclureSeed?: boolean;
}

/** Échantillon d'entraînement supervisé. */
export interface TrainingSample {
  text: string;
  label: string;
}

/** Jeu de données équilibré + statistiques par label. */
export interface TrainingDataset {
  samples: TrainingSample[];
  stats: Record<string, number>;
}

/**
 * Jeu d'amorçage canonique (48 exemples) : phrases simples, rédigées à la
 * main, couvrant chaque pool d'intention. C'est un jeu d'amorçage supervisé
 * légitime — l'équivalent des quelques exemples d'instruction que l'on donne
 * à un système avant de l'exposer au corpus réel ; il ne simule AUCUNE
 * donnée utilisateur.
 */
export const SEED_EXAMPLES: readonly TrainingSample[] = [
  // Intention générale (12) — conversation sans intention spécifique.
  { text: "Bonjour, comment vas-tu aujourd'hui ?", label: INTENTION_GENERALE },
  { text: "Salut ! Je voulais juste discuter un peu avec toi.", label: INTENTION_GENERALE },
  { text: "Merci beaucoup pour ton aide précieuse.", label: INTENTION_GENERALE },
  { text: "Hello ! Ravi de te parler.", label: INTENTION_GENERALE },
  { text: "Coucou, tu es là ?", label: INTENTION_GENERALE },
  { text: "On peut avoir une conversation tranquille ?", label: INTENTION_GENERALE },
  { text: "Je voulais te dire bonjour avant de partir.", label: INTENTION_GENERALE },
  { text: "Au revoir et merci pour la discussion.", label: INTENTION_GENERALE },
  { text: "Parlons de choses et d'autres.", label: INTENTION_GENERALE },
  { text: "C'est agréable de discuter ainsi.", label: INTENTION_GENERALE },
  { text: "Hey, comment ça va de ton côté ?", label: INTENTION_GENERALE },
  { text: "Je passe juste dire salut.", label: INTENTION_GENERALE },
  // Génération d'images (6).
  { text: "Génère une image de montagne enneigée au lever du soleil.", label: "GENERER_IMAGE" },
  { text: "Crée une illustration botanique détaillée d'une fougère.", label: "GENERER_IMAGE" },
  { text: "Je voudrais une photo artistique de la ville la nuit.", label: "GENERER_IMAGE" },
  { text: "Dessine-moi un portrait au crayon.", label: "GENERER_IMAGE" },
  { text: "Fais un visuel de couverture pour mon rapport annuel.", label: "GENERER_IMAGE" },
  { text: "Montre-moi une illustration du système solaire.", label: "GENERER_IMAGE" },
  // Génération audio (6).
  { text: "Génère un audio d'ambiance forestière pour me concentrer.", label: "GENERER_AUDIO" },
  { text: "Crée le son d'une pluie battante pendant dix minutes.", label: "GENERER_AUDIO" },
  { text: "Je voudrais une musique douce pour la lecture.", label: "GENERER_AUDIO" },
  { text: "Produis un podcast audio de synthèse de cet article.", label: "GENERER_AUDIO" },
  { text: "Fais une voix off pour ma présentation.", label: "GENERER_AUDIO" },
  { text: "Crée un son d'ambiance mystérieux pour mon jeu vidéo.", label: "GENERER_AUDIO" },
  // Génération vidéo (6).
  { text: "Génère une vidéo de présentation de mon produit.", label: "GENERER_VIDEO" },
  { text: "Crée une animation explicative du cycle de l'eau.", label: "GENERER_VIDEO" },
  { text: "Je voudrais un film court sur les abeilles.", label: "GENERER_VIDEO" },
  { text: "Fais un clip dynamique pour ma chanson.", label: "GENERER_VIDEO" },
  { text: "Anime une timeline vidéo de mon voyage.", label: "GENERER_VIDEO" },
  { text: "Monte une vidéo tutorielle pour débutants.", label: "GENERER_VIDEO" },
  // Exécution d'outils OS (6).
  { text: "Exécute l'outil de diagnostic du réseau.", label: "EXECUTER_OUTIL_OS" },
  { text: "Lance le script de sauvegarde automatique.", label: "EXECUTER_OUTIL_OS" },
  { text: "Passe la commande de nettoyage du cache.", label: "EXECUTER_OUTIL_OS" },
  { text: "Ouvre un terminal et liste les processus.", label: "EXECUTER_OUTIL_OS" },
  { text: "Démarre l'exécution du script de déploiement.", label: "EXECUTER_OUTIL_OS" },
  { text: "Run the build tool from the shell.", label: "EXECUTER_OUTIL_OS" },
  // Sélection / exécution de compétences (6).
  { text: "Lance la compétence web_search sur ce sujet.", label: "SELECTIONNER_ET_EXECUTER_SKILL" },
  { text: "Utilise le skill data_parser pour structurer ces données.", label: "SELECTIONNER_ET_EXECUTER_SKILL" },
  { text: "Fais une recherche ciblée sur ce sujet précis.", label: "SELECTIONNER_ET_EXECUTER_SKILL" },
  { text: "Lance une analyse complète de la page.", label: "SELECTIONNER_ET_EXECUTER_SKILL" },
  { text: "Parse le document et extrais les entités.", label: "SELECTIONNER_ET_EXECUTER_SKILL" },
  { text: "Sélectionne la compétence adaptée à ma demande.", label: "SELECTIONNER_ET_EXECUTER_SKILL" },
  // Appel téléphonique (6).
  { text: "Appelle le client pour confirmer le rendez-vous.", label: "INITIALISER_APPEL" },
  { text: "Passe un coup de téléphone au support.", label: "INITIALISER_APPEL" },
  { text: "Je voudrais joindre la direction par téléphone.", label: "INITIALISER_APPEL" },
  { text: "Contacter le fournisseur dès cet après-midi.", label: "INITIALISER_APPEL" },
  { text: "Compose le numéro du service après-vente.", label: "INITIALISER_APPEL" },
  { text: "Please call the doctor's office.", label: "INITIALISER_APPEL" },
  // Fin d'appel (6).
  { text: "Raccroche, la conversation est terminée.", label: "TERMINER_APPEL" },
  { text: "Tu peux raccrocher maintenant, merci.", label: "TERMINER_APPEL" },
  { text: "Termine l'appel en cours s'il te plaît.", label: "TERMINER_APPEL" },
  { text: "Je te laisse, termine la communication.", label: "TERMINER_APPEL" },
  { text: "Clôture la ligne, j'ai fini.", label: "TERMINER_APPEL" },
  { text: "Hang up the phone call now.", label: "TERMINER_APPEL" },
];

/**
 * Découpe un corpus brut en phrases étiquetées :
 *  - split sur [. ! ? \n] ;
 *  - conservation des phrases de 15..400 caractères (assez longues pour être
 *    signifiantes, assez courtes pour rester univoques) ;
 *  - étiquetage lexical (labelText) ;
 *  - équilibrage par label (cap maxParLabel, défaut 120) puis cap total
 *    (défaut 2500).
 */
export function buildDatasetFromCorpus(
  corpus: string,
  opts: DatasetOptions = {},
): TrainingDataset {
  const maxParLabel = opts.maxParLabel ?? 120;
  const maxTotal = opts.maxTotal ?? 2500;

  const compteur: Record<string, number> = {};
  const samples: TrainingSample[] = [];

  const phrases = corpus
    .split(/[.!?\n]+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 15 && p.length <= 400);

  for (const phrase of phrases) {
    if (samples.length >= maxTotal) break;
    const label = labelText(phrase);
    const deja = compteur[label] ?? 0;
    if (deja >= maxParLabel) continue;
    compteur[label] = deja + 1;
    samples.push({ text: phrase, label });
  }

  if (opts.inclureSeed) {
    for (const exemple of SEED_EXAMPLES) {
      if (samples.length >= maxTotal) break;
      const deja = compteur[exemple.label] ?? 0;
      if (deja >= maxParLabel) continue;
      compteur[exemple.label] = deja + 1;
      samples.push({ ...exemple });
    }
  }

  return { samples, stats: compteur };
}

/** Taille maximale du corpus chargé depuis public/ (2 Mo). */
export const CORPUS_MAX_OCTETS = 2 * 1024 * 1024;

/**
 * Charge le corpus d'entraînement depuis les fichiers publics du dépôt :
 * public/llms.txt PUIS public/llms-full.txt (concaténés, tronqués à 2 Mo).
 * Lève une erreur claire si les deux fichiers sont absents.
 */
export async function loadCorpusFromPublic(): Promise<string> {
  const base = path.join(process.cwd(), "public");
  const morceaux: string[] = [];

  const llms = await readFile(path.join(base, "llms.txt"), "utf8").catch(
    () => null,
  );
  if (llms !== null) morceaux.push(llms);

  const llmsFull = await readFile(
    path.join(base, "llms-full.txt"),
    "utf8",
  ).catch(() => null);
  if (llmsFull !== null) morceaux.push(llmsFull);

  if (morceaux.length === 0) {
    throw new Error(
      "Corpus d'entraînement neuronal introuvable : public/llms.txt et public/llms-full.txt sont absents du dépôt.",
    );
  }

  const corpus = morceaux.join("\n\n");
  return corpus.length > CORPUS_MAX_OCTETS
    ? corpus.slice(0, CORPUS_MAX_OCTETS)
    : corpus;
}
