/**
 * CIBLAGE CONTEXTUEL GEN ADS — similitude sémantique requête ↔ publicité.
 *
 * Demande utilisateur : « l'affichage des publicités ne doit pas se faire de
 * manière aléatoire à chaque requête des utilisateurs — la pub qui doit
 * s'afficher doit avoir une similitude / un trait de ressemblance avec la
 * demande ».
 *
 * Moteur PUR (aucune dépendance serveur, aucun IO) : partagé par le client
 * (choix de l'annonce sous chaque réponse/résultat) et le serveur (tests,
 * évolutions futures). Déterministe et testable.
 *
 * Pipeline de ressemblance :
 *  1. normalisation (accents, casse, ponctuation) ;
 *  2. tokenisation + suppression des mots vides FR/EN ;
 *  3. racinisation légère FR/EN (pluriels, conjugaisons, dérivations usuelles) ;
 *  4. familles de synonymes thématiques FR/EN ;
 *  5. scoring : mots-clés déclarés par l'annonceur (signal fort) + recouvrement
 *     du texte publicitaire (titre, annonceur, description — signal plus faible).
 *
 * Une annonce n'est diffusée que si son score atteint CONTEXTUAL_MIN_SCORE :
 * quand AUCUNE annonce ne présente de ressemblance avec la requête, RIEN ne
 * s'affiche — l'aléatoire est éliminé, pas remplacé.
 */

/** Annonce minimale requise pour le scoring (structurelle, sans dépendance). */
export interface ContextualAdLike {
  id: string;
  title: string;
  advertiser: string;
  description?: string;
  /** Mots-clés de ciblage déclarés par l'annonceur (campagne Gen Ads). */
  keywords?: string[];
}

export type MatchKind = "exact" | "stem" | "synonym" | "substring";

/** Score minimal pour qu'une annonce soit considérée PERTINENTE. */
export const CONTEXTUAL_MIN_SCORE = 2;

/** Poids d'une correspondance de mot-clé déclaré (signal fort). */
const KEYWORD_WEIGHTS: Record<MatchKind, number> = {
  exact: 3,
  stem: 2.5,
  synonym: 2,
  substring: 1,
};

/** Poids du recouvrement du TEXTE publicitaire (signal plus faible). */
const CREATIVE_TITLE_TOKEN_WEIGHT = 1.5;
const CREATIVE_TITLE_MAX_TOKENS = 2;
const CREATIVE_DESCRIPTION_TOKEN_WEIGHT = 0.75;
const CREATIVE_DESCRIPTION_MAX_TOKENS = 2;

/** Longueur minimale pour une correspondance par sous-chaîne (bruit). */
const SUBSTRING_MIN_LENGTH = 4;
/** Nombre maximum de mots-clés déclarés pris en compte (parité campagnes). */
const MAX_KEYWORDS = 30;

/* ------------------------------------------------------------------ */
/* Normalisation & tokenisation                                        */
/* ------------------------------------------------------------------ */

/** Minuscules SANS accents ni ponctuation (« Café-Resto » → « cafe resto »). */
export function normalizeText(text: string): string {
  return (text ?? "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Mots vides FR/EN (comparés sur la forme NORMALISÉE, sans accents). */
const STOPWORDS = new Set<string>([
  // Français
  "le", "la", "les", "l", "un", "une", "des", "de", "du", "d", "au", "aux", "et", "ou",
  "mais", "donc", "or", "ni", "car", "que", "qu", "qui", "quoi", "dont", "ne", "pas",
  "plus", "moins", "tres", "bien", "etre", "suis", "es", "est", "sommes", "etes",
  "sont", "etait", "etaient", "sera", "seront", "avoir", "ai", "as", "avons", "avez",
  "ont", "avait", "avaient", "je", "tu", "il", "elle", "on", "nous", "vous", "ils",
  "elles", "me", "te", "se", "lui", "leur", "mon", "ma", "mes", "ton", "ta", "tes",
  "son", "sa", "ses", "notre", "nos", "votre", "vos", "ce", "cet", "cette", "ces",
  "ceci", "cela", "ca", "celui", "celle", "ceux", "dans", "sur", "sous", "avec",
  "sans", "pour", "par", "vers", "chez", "entre", "depuis", "pendant", "apres",
  "avant", "comme", "si", "tout", "toute", "toutes", "tous", "chaque", "autre",
  "meme", "aussi", "alors", "ainsi", "quand", "parce", "quel", "quelle", "quels",
  "quelles", "combien", "rien", "personne", "toujours", "encore", "jamais", "deja",
  "y", "en", "voici", "voila", "fais", "fait", "faire", "peux", "peut", "peuvent",
  "veux", "veut", "veulent", "vais", "va", "vas", "dois", "doit", "s'il", "st",
  // Anglais
  "the", "an", "and", "or", "but", "so", "if", "then", "than", "of", "to", "in",
  "at", "for", "with", "without", "from", "by", "about", "into", "over", "under",
  "between", "during", "before", "after", "is", "are", "was", "were", "be", "been",
  "being", "am", "do", "does", "did", "doing", "have", "has", "had", "having",
  "will", "would", "can", "could", "should", "shall", "may", "might", "must",
  "this", "that", "these", "those", "it", "its", "im", "ive", "id", "ill", "you",
  "youd", "youll", "youre", "youve", "he", "him", "his", "she", "shes", "her",
  "hers", "we", "wed", "well", "were2", "weve", "they", "them", "their", "theirs",
  "my", "me2", "our", "ours", "your", "yours", "not", "no", "yes", "very", "just",
  "only", "also", "too", "here", "there", "whats", "what", "which", "who", "whom",
  "whose", "when", "where", "why", "how", "all", "any", "both", "each", "few",
  "more", "most", "other", "some", "such", "own", "same", "once", "please", "help",
  "want", "need", "give", "show", "tell", "let", "get", "got", "make", "made",
  "dont", "doesnt", "didnt", "wont", "cant", "couldnt", "shouldnt", "isnt",
  "arent", "wasnt", "werent", "hasnt", "havent", "hadnt", "now", "ok", "hey",
]);

/** Découpe un texte en tokens normalisés exploitables (mots vides exclus). */
export function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

/* ------------------------------------------------------------------ */
/* Racinisation légère FR/EN                                           */
/* ------------------------------------------------------------------ */

/** Terminaisons usuelles FR/EN (les plus longues d'abord — ordre important). */
const STRIP_ENDINGS: readonly string[] = [
  "itaires", "ations", "ateurs",
  "ements", "itaire", "ation", "ateur", "ences", "istes", "ables", "ibles",
  "ement", "ances", "ismes", "euses", "ings", "iques",
  "ance", "ence", "isme", "iste", "able", "ible", "ales", "ques",
  "euse", "ive", "ifs", "ing", "ers", "els", "ons", "ont", "ant", "ent", "ans",
  "eux", "ale", "er", "ed", "el", "if", "ie", "ies",
  "e",
];

/** Nombre maximum de passes de racinisation (convergence des deux côtés). */
const MAX_STEM_PASSES = 4;
/**
 * Longueur minimale du radical produit. 4 : « prix » et « page » restent
 * intacts (le retrait de leur dernière lettre serait trop destructif), tout
 * en conservant la convergence banques→banque→banqu.
 */
const MIN_STEM_LENGTH = 4;

/**
 * Racinisation LÉGÈRE FR/EN :
 *  1. marqueur pluriel d'abord (« s »/« x ») — le singulier reprend sa
 *     forme de base avant tout autre retrait (banques → banque → banqu) ;
 *  2. puis rabot itératif des terminaisons courantes jusqu'à convergence.
 * Approximative par nature, mais SYMÉTRIQUE : requête et mots-clés passent
 * par la même fonction — deux formes d'un même mot convergent toujours.
 */
export function lightStem(word: string): string {
  let current = word;
  // Pluriels irréguliers en -al : « journaux » → « journal ».
  if (current.length >= 6 && current.endsWith("aux")) {
    current = `${current.slice(0, -3)}al`;
  }
  for (let pass = 0; pass < MAX_STEM_PASSES; pass += 1) {
    let stripped = false;
    if (current.length - 1 >= MIN_STEM_LENGTH && (current.endsWith("s") || current.endsWith("x"))) {
      current = current.slice(0, -1);
      stripped = true;
    } else {
      for (const ending of STRIP_ENDINGS) {
        if (current.length - ending.length >= MIN_STEM_LENGTH && current.endsWith(ending)) {
          current = current.slice(0, current.length - ending.length);
          stripped = true;
          break;
        }
      }
    }
    if (!stripped) break;
  }
  return current;
}

/* ------------------------------------------------------------------ */
/* Familles de synonymes thématiques FR/EN                             */
/* ------------------------------------------------------------------ */

/**
 * Familles sémantiques couvrant les grands domaines publicitaires — deux mots
 * d'une même famille présentent un « trait de ressemblance » même sans aucune
 * lettre commune. Formes NORMALISÉES (sans accents). NB : l'index retient la
 * PREMIÈRE famille d'un mot — un domaine donné ne figure donc qu'une fois.
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["tech", "technologie", "technologique", "numerique", "digital", "informatique",
    "logiciel", "software", "application", "app", "ordinateur", "computer",
    "gadget", "electronique", "hardware", "startup", "saas", "api", "code",
    "coder", "programmation", "developpeur", "dev"],
  ["ia", "ai", "intelligence", "artificielle", "machine", "learning",
    "apprentissage", "automatique", "automatisation", "automatise", "robot",
    "robotique", "chatbot", "llm", "gpt", "algorithme", "modele", "generee",
    "generatif", "generative", "agent", "agents"],
  ["web", "internet", "site", "hebergement", "domaine", "seo",
    "referencement", "trafic", "enligne", "online", "cloud", "serveur",
    "navigateur", "browser", "url", "lien", "page", "blog", "vitrine",
    "ecommerce", "boutique"],
  ["business", "entreprise", "societe", "commerce", "vendre", "vente", "sales",
    "affaires", "argent", "revenu", "revenue", "profit", "benefice", "client",
    "clientele", "strategie", "croissance", "projet", "patron", "dirigeant",
    "boite", "marche", "marches", "negoce"],
  ["marketing", "publicite", "pub", "advertising", "promotion", "promouvoir",
    "communication", "reseaux", "social", "influenceur", "influence",
    "abonne", "audience", "marque", "branding", "notoriete", "campagne",
    "annonce", "sponsor", "viral", "contenu"],
  ["finances", "finance", "financier", "banque", "credit", "epargne",
    "investissement", "investir", "bourse", "crypto", "bitcoin",
    "cryptomonnaie", "monnaie", "money", "fiscalite", "impot", "impots",
    "comptabilite", "comptable", "facture", "remboursement", "taux",
    "interet", "dette", "pret"],
  ["immobilier", "maison", "appartement", "terrain", "loyer", "location",
    "propriete", "residence", "habitat", "construction", "batir", "travaux",
    "renovation", "architecte", "chantier", "salon", "chambre", "meuble",
    "decoration", "deco", "jardin", "cloture", "toit"],
  ["voiture", "auto", "automobile", "vehicule", "transport", "moto",
    "conduire", "permis", "carburant", "essence", "garage", "pneu", "taxi",
    "bus", "train", "avion", "billet", "vol", "deplacement", "livraison",
    "livrer", "colis", "expedition"],
  ["sante", "medical", "medecin", "medecine", "hopital", "pharmacie",
    "bienetre", "fitness", "sport", "exercice", "muscle", "musculation",
    "nutrition", "alimentation", "regime", "perte", "poids", "therapie",
    "psychologie", "stress", "sommeil", "soins", "dentiste", "vue",
    "lunettes", "medicament"],
  ["cuisine", "recette", "cuisiner", "gastronomie", "restaurant", "nourriture",
    "food", "repas", "menu", "chef", "aliment", "plats", "gouter", "manger",
    "boisson", "jus", "cafe", "patisserie", "gateau", "boulangerie", "pain",
    "fastfood", "pizzeria", "traiteur", "epicerie"],
  ["voyage", "travel", "tourisme", "vacances", "hotel", "destination",
    "sejour", "tour", "safari", "visite", "plage", "montagne", "reservation",
    "agence", "aventure", "excursion", "camping", "passeport", "passport",
    "visa", "valise"],
  ["education", "formation", "cours", "apprendre", "etude", "etudes", "ecole",
    "universite", "diplome", "certification", "enseignement", "tutoriel",
    "coach", "soutien", "scolaire", "eleve", "etudiant", "professeur", "prof",
    "lecon", "examen", "concours", "memoire", "these", "soutenance", "atelier",
    "educatif", "educative"],
  ["mode", "vetement", "habits", "tenue", "chaussures", "beaute",
    "cosmetique", "style", "shopping", "textile", "robe", "chemise",
    "pantalon", "accessoire", "bijoux", "montre", "sac", "coiffure",
    "cheveux", "maquillage", "parfum", "peau", "ongles"],
  ["musique", "audio", "chanson", "chanteur", "artiste", "playlist",
    "podcast", "ecouter", "instrument", "guitare", "piano", "concert",
    "album", "beat", "production", "mixage", "micro"],
  ["video", "film", "cinema", "montage", "youtube", "streaming", "vlog",
    "clip", "visuel", "documentaire", "serie", "acteur", "realisation",
    "realisateur", "camera", "scenario", "animation", "reels", "shorts",
    "tiktok", "instagram", "spectacle"],
  ["image", "photo", "photographie", "photographe", "graphisme", "graphique",
    "design", "illustration", "logo", "dessin", "pixel", "retouche",
    "artistique", "creatif", "infographie", "charte", "couleurs", "poster",
    "affiche", "banniere", "identite"],
  ["jeu", "jeux", "game", "gaming", "joueur", "console", "esport",
    "divertissement", "amusement", "loisirs", "hobby", "casino", "paris",
    "loterie", "cartes", "puzzle", "passe", "temps", "fun"],
  ["agriculture", "ferme", "culture", "recolte", "plante", "elevage",
    "champ", "agricole", "semence", "engrais", "irrigation", "serre", "bio",
    "biologique", "ecologique", "nature", "environnement", "climat",
    "climatique", "durable", "recyclage", "pollution"],
  ["juridique", "droit", "legal", "avocat", "justice", "contrat", "loi",
    "tribunal", "conformite", "notaire", "huissier", "procedure", "litige",
    "conseil", "reglement", "reglementation", "licence", "brevet",
    "intellectuelle"],
  ["emploi", "travail", "job", "carriere", "recrutement", "cv", "poste",
    "salaire", "freelance", "professionnel", "metier", "stage", "embauche",
    "candidature", "entretien", "reussite", "competence", "experience",
    "reconversion", "teletravail", "bureau"],
  ["securite", "protection", "cybersecurite", "chiffrement", "donnees",
    "confidentialite", "antivirus", "sauvegarde", "backup", "piratage", "hack",
    "phishing", "arnaque", "fraude", "vigilance", "alarme", "surveillance",
    "assurance", "garantie", "risque"],
  ["energie", "electricite", "solaire", "panneau", "pile", "courant",
    "energetique", "renouvelable", "batterie", "recharge", "gaz", "petrole",
    "hydro", "eolienne", "nucleaire", "consommation", "ampoule"],
  ["telephone", "portable", "mobile", "smartphone", "forfait", "appel",
    "sms", "operateur", "sim", "fibre", "wifi", "connexion", "data",
    "abonnement", "numero", "contact", "message", "whatsapp", "telegram"],
  ["evenement", "evenementiel", "fete", "mariage", "anniversaire",
    "ceremonie", "noel", "nouvel", "an", "invitation", "invite", "organisateur",
    "dj", "lieu", "salle", "billetterie", "reception", "gala", "soiree"],
  ["animaux", "animal", "animalerie", "veterinaire", "vet", "chien", "chat",
    "chaton", "animalier", "croquettes", "toilettage", "dressage", "eleveur",
    "refuge", "adoption"],
  ["art", "livre", "lecture", "roman", "auteur", "ecrivain", "edition",
    "editeur", "bibliotheque", "librairie", "poesie", "theatre", "musee",
    "exposition", "galerie", "peinture", "sculpture", "histoire",
    "civilisation", "langue", "francais", "anglais", "traduction",
    "traduire", "dictionnaire"],
];

/** Index mot → famille (première famille contenant le mot). */
const SYNONYM_BY_WORD = new Map<string, number>();
/** Index radical → famille (tolère les variations morphologiques). */
const SYNONYM_BY_STEM = new Map<string, number>();
SYNONYM_GROUPS.forEach((group, groupIndex) => {
  for (const word of group) {
    if (!SYNONYM_BY_WORD.has(word)) SYNONYM_BY_WORD.set(word, groupIndex);
    const stem = lightStem(word);
    if (!SYNONYM_BY_STEM.has(stem)) SYNONYM_BY_STEM.set(stem, groupIndex);
  }
});

/** Familles de synonymes d'un mot (mot exact, puis radical). */
function synonymGroupsOf(word: string): number[] {
  const groups: number[] = [];
  const byWord = SYNONYM_BY_WORD.get(word);
  if (byWord !== undefined) groups.push(byWord);
  const byStem = SYNONYM_BY_STEM.get(lightStem(word));
  if (byStem !== undefined && !groups.includes(byStem)) groups.push(byStem);
  return groups;
}

/* ------------------------------------------------------------------ */
/* Contexte de diffusion                                               */
/* ------------------------------------------------------------------ */

/** Requête de l'utilisateur prétraitée une seule fois (O(1) par test). */
export interface ContextTokens {
  tokens: Set<string>;
  stems: Set<string>;
  groups: Set<number>;
  raw: string[];
}

/** Extrait les tokens exploitables du texte de la requête/réponse. */
export function extractContextTokens(text: string): ContextTokens {
  const raw = tokenize(text);
  const stems = new Set<string>();
  const groups = new Set<number>();
  for (const token of raw) {
    stems.add(lightStem(token));
    for (const group of synonymGroupsOf(token)) groups.add(group);
  }
  return { tokens: new Set(raw), stems, groups, raw };
}

/** Qualité d'une correspondance (du meilleur au plus faible). */
const WEAKNESS: Record<MatchKind, number> = { exact: 0, stem: 1, synonym: 2, substring: 3 };

/** Meilleure correspondance d'un mot contre le contexte de diffusion. */
function matchWord(word: string, context: ContextTokens): MatchKind | null {
  if (word.length < 2) return null;
  if (context.tokens.has(word)) return "exact";
  if (context.stems.has(lightStem(word))) return "stem";
  const wordGroups = synonymGroupsOf(word);
  if (wordGroups.some((group) => context.groups.has(group))) return "synonym";
  if (word.length >= SUBSTRING_MIN_LENGTH) {
    for (const token of context.raw) {
      if (
        token.length >= SUBSTRING_MIN_LENGTH &&
        (token.includes(word) || word.includes(token))
      ) {
        return "substring";
      }
    }
  }
  return null;
}

/**
 * Correspondance d'un mot-clé déclaré (possiblement multi-mots) : chaque mot
 * doit correspondre, la qualité retenue est la PLUS FAIBLE des mots — un
 * mot-clé ne vaut jamais plus que son maillon faible.
 */
function matchKeyword(keyword: string, context: ContextTokens): MatchKind | null {
  const words = tokenize(keyword);
  if (words.length === 0) return null;
  let weakest: MatchKind = "exact";
  for (const word of words) {
    const kind = matchWord(word, context);
    if (!kind) return null;
    if (WEAKNESS[kind] > WEAKNESS[weakest]) weakest = kind;
  }
  return weakest;
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

/** Nombre de TOKENS DISTINCTS du texte publicitaire présents dans le contexte. */
function countCreativeOverlap(text: string, context: ContextTokens): number {
  const matched = new Set<string>();
  for (const token of tokenize(text)) {
    const kind = matchWord(token, context);
    // Sous-chaîne ignorée pour le texte publicitaire (trop bruité).
    if (kind && kind !== "substring") {
      matched.add(lightStem(token));
    }
  }
  return matched.size;
}

/**
 * Score de ressemblance d'une annonce avec le contexte de diffusion :
 *  - mots-clés déclarés : exact 3 > radical 2,5 > synonyme 2 > sous-chaîne 1 ;
 *  - recouvrement du texte (titre + annonceur, puis description) plafonné.
 */
export function scoreAdRelevance(ad: ContextualAdLike, context: ContextTokens): number {
  let score = 0;

  const keywords = Array.isArray(ad.keywords) ? ad.keywords : [];
  for (const keyword of keywords.slice(0, MAX_KEYWORDS)) {
    const kind = matchKeyword(String(keyword), context);
    if (kind) score += KEYWORD_WEIGHTS[kind];
  }

  score +=
    Math.min(countCreativeOverlap(`${ad.title} ${ad.advertiser}`, context), CREATIVE_TITLE_MAX_TOKENS) *
    CREATIVE_TITLE_TOKEN_WEIGHT;

  if (ad.description) {
    score +=
      Math.min(countCreativeOverlap(ad.description, context), CREATIVE_DESCRIPTION_MAX_TOKENS) *
      CREATIVE_DESCRIPTION_TOKEN_WEIGHT;
  }

  return score;
}

/* ------------------------------------------------------------------ */
/* Classement & sélection                                              */
/* ------------------------------------------------------------------ */

export interface RankedAd<T extends ContextualAdLike> {
  ad: T;
  score: number;
}

/**
 * Classe les annonces par ressemblance avec le contexte, en écartant celles
 * sous le seuil CONTEXTUAL_MIN_SCORE. Tri stable (égalité → id croissant).
 * Contexte vide (aucun token) → AUCUNE annonce classée.
 */
export function rankAdsByRelevance<T extends ContextualAdLike>(
  ads: T[],
  contextText: string,
): RankedAd<T>[] {
  const context = extractContextTokens(contextText);
  if (context.raw.length === 0) return [];
  return ads
    .map((ad) => ({ ad, score: scoreAdRelevance(ad, context) }))
    .filter((ranked) => ranked.score >= CONTEXTUAL_MIN_SCORE)
    .sort((a, b) => b.score - a.score || (a.ad.id < b.ad.id ? -1 : 1));
}

/** Hachage stable FNV-1a : la même clé produit toujours le même index. */
export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Sélectionne L'annonce à diffuser pour ce contexte :
 *  - seules les annonces dépassant le seuil de ressemblance concourent ;
 *  - à score ÉGAL en tête, le choix est DÉTERMINISTE (hachage de la clé) :
 *    un re-render ne change jamais l'annonce d'une ligne donnée ;
 *  - si AUCUNE annonce ne présente de ressemblance : null (rien ne s'affiche).
 */
export function pickContextualAd<T extends ContextualAdLike>(
  ads: T[],
  contextText: string,
  tieBreakKey: string,
): T | null {
  const ranked = rankAdsByRelevance(ads, contextText);
  if (ranked.length === 0) return null;
  const topScore = ranked[0].score;
  const ties = ranked.filter((entry) => topScore - entry.score < 1e-9);
  if (ties.length === 1) return ties[0].ad;
  return ties[stableHash(tieBreakKey) % ties.length].ad;
}
