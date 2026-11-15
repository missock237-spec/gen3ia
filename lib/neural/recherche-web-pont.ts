/**
 * PONT RECHERCHE WEB — la GARANTIE « gen3 ne laisse jamais un utilisateur
 * sans réponse ».
 *
 * Directive : quand le moteur n'a PAS de matière face à une demande — pas
 * de paire cortex, pas de document de connaissances, pas de commande de
 * pilotage, texte décodé générique du SNN — il ne rend PAS la main avec une
 * réponse vague : il déclenche PAR DÉFAUT une recherche web réelle
 * (l'outil web.search de la plateforme, cascade DuckDuckGo → Wikipédia),
 * compose une réponse fondée sur les sources trouvées (citées), et si
 * la recherche elle-même échoue, il répond quand même — honnêtement et
 * explicitement — avec ce qu'il sait et comment l'utilisateur peut obtenir
 * une réponse utile. JAMAIS de silence, JAMAIS de « je ne sais pas » sec.
 *
 * Module PUR (comme connaissances-pont) : aucune I/O ici — l'appel réel à
 * la recherche est INJECTÉ au moteur (câblé par le runtime avec l'outil
 * web.search réel). Les tests injectent leurs propres résultats.
 */

import type { CompositionReponse } from "./engine";

/** Un résultat de recherche web (renvoyé par l'injecteur réel). */
export interface ResultatRechercheWeb {
  titre: string;
  url: string;
  extrait?: string;
}

/** Options de composition fondée sur la recherche. */
export interface OptionsPontRecherche {
  /** Résultats minimum pertinents pour composer une réponse fondée. */
  minPertinents?: number;
}

/** Seuil en dessous duquel la matière du moteur est jugée INSUFFISANTE :
 *  le repli du décodeur est un texte court, générique, sans appariement
 *  réel (le cortex n'a trouvé aucune paire, aucune connaissance). */
const LONGUEUR_MIN_REPONSE_SUFFISANTE = 120;
/** Score d'appariement cortex en dessous duquel la matière est faible. */
const SCORE_APPARIEMENT_MIN = 0.22;

/** Mots vides FR/EN basiques — les mots INFORMATIONNELS portent le besoin. */
const MOTS_VIDES = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "a", "au", "aux",
  "en", "sur", "pour", "avec", "sans", "que", "qui", "quoi", "comment", "est",
  "ce", "cette", "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses",
  "je", "tu", "il", "elle", "nous", "vous", "ils", "elles", "ne", "pas", "plus",
  "y", "d", "l", "s", "n", "t", "m", "se", "si", "par", "as", "be", "by", "for",
  "from", "in", "is", "it", "of", "on", "or", "the", "to", "was", "what", "when",
  "where", "which", "who", "with", "how", "do", "does", "i", "me", "my", "you",
  "your", "our", "their", "can", "could", "should", "would", "there", "that",
]);

/** Mots informatifs d'une demande (> 2 caractères, hors mots vides). */
function motsInformatifs(texte: string): string[] {
  return (texte ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((mot) => mot.length > 2 && !MOTS_VIDES.has(mot));
}

/** Recouvrement entre la demande et un texte (nombre de mots communs). */
function recouvrement(question: string[], texte: string): number {
  const mots = new Set(motsInformatifs(texte));
  return question.filter((mot) => mots.has(mot)).length;
}

/**
 * SAVOIR SUFFISANT ? — le juge honnête du filet de sécurité.
 *
 * Une composition est jugée INSUFFISANTE quand :
 *  - le texte est vide ou trop court pour répondre à une demande réelle ;
 *  - la source est le repli du décodeur (aucune matière : ni pilotage, ni
 *    connaissances, ni paire cortex apprise) et le texte est générique ;
 *  - le cortex a bien répondu mais avec un appariement très faible
 *    (motif distant de la demande — risque réel de hors-sujet).
 */
export function savoirInsuffisant(composition: CompositionReponse | null | undefined): boolean {
  if (!composition || !composition.texte?.trim()) return true;
  const texte = composition.texte.trim();
  if (texte.length < LONGUEUR_MIN_REPONSE_SUFFISANTE) return true;
  if (composition.source === "decoder_intention") return true;
  if (
    (composition.source === "cortex_corpus"
      || composition.source === "cortex_personnalisee"
      || composition.source === "cortex_contexte")
    && typeof composition.scoreAppariement === "number"
    && composition.scoreAppariement < SCORE_APPARIEMENT_MIN
  ) {
    return true;
  }
  return false;
}

/** Ouvre un extrait propre (guillemets français, borné). */
function citer(texte: string, max = 420): string {
  const net = (texte ?? "").replace(/\s+/g, " ").trim();
  if (net.length <= max) return net;
  return net.slice(0, max).replace(/\s+\S*$/, "") + " …";
}

/**
 * COMPOSITION FONDÉE SUR LA RECHERCHE WEB — même contrat que
 * composerDepuisConnaissances : blocs cités + sources ; ne renvoie une
 * matière QUE si des résultats sont pertinents pour la demande (recouvrement
 * lexical), sinon null (l'appelant passera au repli honnête).
 */
export function composerDepuisRechercheWeb(
  question: string,
  resultats: readonly ResultatRechercheWeb[],
  opts: OptionsPontRecherche = {},
): CompositionReponse | null {
  const demande = question?.trim();
  if (!demande || !resultats?.length) return null;

  const motsQuestion = motsInformatifs(demande);
  if (motsQuestion.length === 0) return null;

  const minPertinents = opts.minPertinents ?? 1;
  const classes = resultats
    .map((resultat) => ({
      resultat,
      communs: recouvrement(
        motsQuestion,
        `${resultat.titre ?? ""} ${resultat.extrait ?? ""}`,
      ),
    }))
    .filter(({ communs }) => communs >= 1)
    .sort((a, b) => b.communs - a.communs);

  if (classes.length < minPertinents) return null;
  const retenus = classes.slice(0, 3);

  const blocs = retenus.map(({ resultat }) => {
    const extrait = resultat.extrait?.trim() ? ` — « ${citer(resultat.extrait)} »` : "";
    return `• ${citer(resultat.titre ?? "Source", 120)}${extrait}\n  Source : ${resultat.url}`;
  });

  const texte = [
    "Ma matière interne (corpus appris et documents) ne couvre pas suffisamment votre demande — j'ai donc lancé automatiquement une recherche web pour vous répondre avec des informations réelles. Voici ce que j'ai trouvé :",
    "",
    blocs.join("\n\n"),
    "",
    "Ces sources sont externes : vérifiez les points critiques auprès d'elles directement. Si vous précisez votre besoin (contexte, domaine, contrainte), je peux affiner ma réponse.",
  ].join("\n");

  return {
    texte,
    source: "recherche_web",
    scoreAppariement: Number.parseFloat((retenus[0].communs / motsQuestion.length).toFixed(2)),
  };
}

/**
 * REPLI HONNÊTE — la DERNIÈRE ligne de défense : une réponse TOUJOURS
 * non vide, qui explique honnêtement l'état (pas de matière interne, recherche
 * web sans résultat exploitable), restitue ce que le moteur a produit si
 * quelque chose d'utile subsiste, et donne à l'utilisateur des voies
 * concrètes pour obtenir une réponse.
 */
export function composerRepliHonnete(
  question: string,
  composition?: CompositionReponse | null,
): CompositionReponse {
  const demande = question?.trim() || "votre demande";
  const resume = composition?.texte?.trim();
  // Matière subsistante : un texte LONG peut contenir des éléments utiles
  // (le repli décodeur est condamné comme RÉPONSE FINALE par le filet, mais
  // reste une matière restituable honnêtement, explicitement balisée).
  const utile =
    resume && resume.length >= LONGUEUR_MIN_REPONSE_SUFFISANTE
      ? `\n\nCe que je peux dire de plus proche de votre demande (matière décodée, à prendre avec recul) :\n« ${citer(resume, 320)} »`
      : "";

  const texte = [
    `Je n'ai pas de matière interne suffisante pour « ${citer(demande, 160)} » et la recherche web automatique n'a pas renvoyé de résultat exploitable — je préfère vous le dire clairement plutôt que d'inventer.`,
    utile,
    "",
    "Pour obtenir une réponse utile, voici ce qui fonctionne :",
    "• reformulez avec plus de contexte (domaine, objectif, contrainte, exemple attendu) ;",
    "• activez le bouton « Recherche web » du composer pour forcer une nouvelle recherche ;",
    "• déposez un document lié à votre demande : il entre dans ma base de connaissances et devient ma matière première.",
  ]
    .filter((bloc) => bloc.length > 0)
    .join("\n");

  return { texte, source: "repli_honnete" };
}
