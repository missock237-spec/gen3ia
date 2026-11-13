/**
 * ANALYSE D'INTENTION AUDIO — module PUR (aucun LLM, aucun réseau).
 *
 * Maillon du routage sonore automatique : décider SANS que l'utilisateur
 * ait à le demander si une demande est de la PAROLE (« lis ce texte » →
 * voix humaine réelle du professeur TTS), un BRUIT/AMBIANCE (« le son de
 * la pluie » → design sonore sémantique local) ou de la MUSIQUE (« une
 * berceuse » → moteur scénique local). Avant ce module, « le son de la
 * pluie » était LU À VOIX HAUTE par le TTS : erreur de rendu manifeste.
 *
 * DÉTERMINISME & HONNÊTETÉ : lexique FR+EN explicite (insensible à la
 * casse et aux accents, pluriels/dérivés couverts par stems de préfixe),
 * aucune prétention de compréhension profonde — hors vocabulaire, la
 * nature est « inconnu » (comportement historique préservé). Chaque
 * décision porte un motif court en FRANÇAIS (traçabilité honnête).
 *
 * PRIORITÉ ASSUMÉE : SON > VOIX > MUSIQUE.
 *  - « son » l'emporte toujours : le TTS ne doit JAMAIS lire un bruit à
 *    voix haute (« voix de la pluie » est un son, pas une parole) ;
 *  - « voix » l'emporte sur « musique » : « lis une berceuse doucement »
 *    est une PAROLE lente (vitesse expressive), pas un instrumental ;
 *  - « musique » ne s'applique qu'aux demandes musicales pures.
 *
 * Garde-fous d'ambiguïté (documentés, testés) : « pas » (négation « ne
 * … pas » ≠ bruits de pas), « porte » (verbe porter ≠ porte qui claque),
 * « train » (« en train de » ≠ le train qui siffle), « vente »/« window »/
 * « belle »… (faux amis des stems EN/FR).
 */

import { normaliserMot } from "./generation/scene-spec";

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

/** Nature détectée de la demande audio. */
export type NatureAudio = "voix" | "son" | "musique" | "inconnu";

/** Décision d'intention audio avec sa traçabilité. */
export interface IntentionAudio {
  nature: NatureAudio;
  /**
   * Vitesse expressive de la PAROLE (0.85 = ton posé, 1.15 = ton
   * dynamique, 1 = neutre). Définie uniquement pour nature="voix".
   */
  vitesse?: number;
  /** Motif court et honnête de la décision (traçabilité FR). */
  motif: string;
}

/* ------------------------------------------------------------------ */
/* Tokenisation (identique à la scène : accents pliés, signes séparés)  */
/* ------------------------------------------------------------------ */

/** Découpe un prompt en tokens normalisés (mots porteurs de sens). */
function tokenizer(prompt: string): string[] {
  return (prompt ?? "")
    .split(/[\s,.:;!?'’()\-_/]+/)
    .map(normaliserMot)
    .filter((mot) => mot.length >= 2 && mot.length <= 24);
}

/**
 * Correspondance stem → token : forme exacte d'abord, sinon préfixe pour
 * les stems d'au moins 4 caractères (pluriels/dérivés : « pluies »,
 * « averses », « orages »). Les stems courts restent EXACTS pour éviter
 * les faux amis (« pas » ≠ « passer », « mer » ≠ « mesurer »).
 */
function correspondStem(token: string, stem: string): boolean {
  return token === stem || (stem.length >= 4 && token.startsWith(stem));
}

/* ------------------------------------------------------------------ */
/* Lexique SFX — demandes de BRUITS / AMBIANCES                         */
/* ------------------------------------------------------------------ */

/**
 * Déclencheurs PHRASE (multi-mots) — la demande de bruit la plus
 * explicite. Testés sur le texte normalisé token-à-token joint.
 */
const PHRASES_SON: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:son|bruit)s?\s+de/, "son de / bruit de"],
  [/\beffets?\s+sonores?\b/, "effet sonore"],
  [/\bsound\s+of\b/, "sound of"],
];

/**
 * Stems SFX du moteur scénique (lib/neural/generation/scene-spec + couches
 * audio-composition) et extensions demandées par le propriétaire : tout
 * mot de ce lexique déclenche la nature « son » — jamais le TTS.
 */
const STEMS_SON: ReadonlyArray<string> = [
  // Météo & eau
  "pluie", "averse", "bruine", "orage", "tonnerre", "eclair", "foudre",
  "tempete", "vague", "maree", "ocean", "mer", "clapotis", "etang",
  "cascade", "ruisseau", "riviere", "torrent", "lac",
  // Air & feu
  "vent", "brise", "feu", "feux", "flamme", "brasier", "cheminee",
  "crepitement",
  // Nature & ville
  "foret", "oiseau", "ville", "rumeur", "circulation", "foule", "brouhaha",
  "grotte",
  // Objets sonores & vie urbaine
  "ambiance", "applaudissement", "pas", "porte", "cloche", "carillon",
  "sirene", "train", "avion", "horloge", "tictac", "pendule", "bruit",
  // Anglais
  "rain", "drizzle", "storm", "thunder", "lightning", "wave", "tide",
  "sea", "wind", "breeze", "fire", "flame", "bird", "forest",
  "creek", "stream", "lake", "city", "traffic", "applause", "footstep",
  "door", "siren", "plane", "crowd", "clock", "waterfall",
];

/**
 * Garde d'ambiguïté : reçoit la fenêtre de tokens, la position du token
 * reconnu et le token lui-même (retour true = accepter la décision).
 */
type Garde = (tokens: string[], i: number, token: string) => boolean;

/** Token précédent (ou null en début de prompt). */
function precedent(tokens: string[], i: number): string | null {
  return i > 0 ? tokens[i - 1]! : null;
}

/** La négation française « ne … [verbe …] pas » précède-t-elle la
 *  position i (fenêtre de 4 tokens : « ne sais pas », « n'aime pas »,
 *  « ne le fais pas ») ? */
function negationAvant(tokens: string[], i: number, fenetre = 4): boolean {
  for (let j = Math.max(0, i - fenetre); j < i; j++) {
    const mot = tokens[j];
    if (mot === "ne" || mot === "n") return true;
  }
  return false;
}

/** Déterminants FR : « la porte claque » ✓ mais « il porte un manteau » ✗. */
const DETERMINANTS: ReadonlySet<string> = new Set([
  "le", "la", "l", "les", "un", "une", "ce", "cet", "cette", "du", "de",
  "des", "au", "sa", "son", "ma", "mon", "ta", "ton", "notre", "votre",
  "leur",
]);

/**
 * Gardes d'ambiguïté du lexique SFX : un stem ambigu n'est reconnu que
 * si son contexte l'autorise (retour true = accepter).
 */
const GARDES_SON: ReadonlyMap<string, Garde> = new Map([
  // « pas » : bruits de pas ✓ ; « je ne sais pas », « pas mal » ✗.
  ["pas", (tokens, i, _t) =>
    !negationAvant(tokens, i) && tokens[i + 1] !== "mal"],
  // « porte » : « la porte claque » ✓ ; verbe « il porte » ✗.
  ["porte", (tokens, i) => {
    const prev = precedent(tokens, i);
    return prev !== null && DETERMINANTS.has(prev);
  }],
  // « train » : « le train siffle » ✓ ; « en train de dormir » ✗.
  ["train", (tokens, i) => precedent(tokens, i) !== "en"],
  // « vent » : « le vent » ✓ ; « la vente » ✗.
  ["vent", (_t, _i, token) => token !== "vente" && token !== "ventes"],
  // « plane » : « a plane » ✓ ; « planets » ✗.
  ["plane", (_t, _i, token) => token !== "planet" && token !== "planets"],
  // « wind » : « wind » ✓ ; « window » ✗ (faux ami du stem).
  ["wind", (_t, _i, token) => token !== "window" && token !== "windows"],
]);

/* ------------------------------------------------------------------ */
/* Lexique VOIX — demandes de PAROLE humaine                            */
/* ------------------------------------------------------------------ */

/** Déclencheurs phrase de parole (EN). */
const PHRASES_VOIX: ReadonlyArray<RegExp> = [/\btell\s+(?:me|us)\b/];

/** Stems de PAROLE (FR + EN). */
const STEMS_VOIX: ReadonlyArray<string> = [
  "lis", "lit", "lisez", "dis", "dit", "dites", "raconte", "recite",
  "narre", "narration", "voix", "parle", "podcast", "bulletin", "voice",
  "read",
];

/** Lits (meubles) : « un lit douillet » ✗ — « il lit le journal » ✓. */
const LITS_MEUBLES: ReadonlySet<string> = new Set([
  "un", "le", "au", "du", "dans", "mon", "ton", "son", "notre", "votre",
  "leur", "grand", "petit", "double", "sur",
]);

/** Gardes d'ambiguïté du lexique voix. */
const GARDES_VOIX: ReadonlyMap<string, Garde> = new Map([
  // « lit » : « il lit le journal » ✓ ; « un lit douillet » ✗.
  ["lit", (tokens, i) => {
    const prev = precedent(tokens, i);
    return prev === null || !LITS_MEUBLES.has(prev);
  }],
  // « parle » : « parle-moi » ✓ ; « le parlement » ✗.
  ["parle", (_t, _i, token) => !token.startsWith("parlem")],
]);

/* ------------------------------------------------------------------ */
/* Lexique MUSIQUE — demandes musicales pures                           */
/* ------------------------------------------------------------------ */

/** Stems musicaux (FR + EN). */
const STEMS_MUSIQUE: ReadonlyArray<string> = [
  "musique", "musical", "chanson", "instrument", "berceuse", "melodie",
  "beat", "piano", "guitar", "symphon", "music", "song", "lullaby",
  "melody",
];

/** Gardes d'ambiguïté du lexique musique. */
const GARDES_MUSIQUE: ReadonlyMap<string, Garde> = new Map([
  // « song » EN ✓ ; verbe FR « songer/songe » ✗.
  ["song", (_t, _i, token) => token === "song" || token === "songs"],
]);

/* ------------------------------------------------------------------ */
/* Vitesse expressive (parole uniquement)                               */
/* ------------------------------------------------------------------ */

const VITESSE_POSE = 0.85;
const VITESSE_DYNAMIQUE = 1.15;

/** Ton posé : méditation, berceuse, lecture douce… */
const STEMS_LENTS: ReadonlyArray<string> = [
  "medit", "berceuse", "doucement", "douce", "pose", "lentement", "apais",
  "calme", "zen", "endorm", "slowly", "gentl", "lullaby", "relax",
];

/** Ton dynamique : énergie, annonce, exclamation… */
const STEMS_VIFS: ReadonlyArray<string> = [
  "energ", "annonc", "exclam", "dynam", "upbeat", "vivement",
];

/* ------------------------------------------------------------------ */
/* Recherche dans le lexique                                            */
/* ------------------------------------------------------------------ */

/**
 * Retourne le premier stem du lexique reconnu dans les tokens (ordre du
 * prompt prioritaire), ou null. Les gardes d'ambiguïté filternt les faux
 * amis avant toute décision.
 */
function chercherStem(
  tokens: string[],
  stems: ReadonlyArray<string>,
  gardes?: ReadonlyMap<string, Garde>,
): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    for (const stem of stems) {
      if (!correspondStem(token, stem)) continue;
      const garde = gardes?.get(stem);
      if (garde && !garde(tokens, i, token)) continue;
      return stem;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Analyse                                                              */
/* ------------------------------------------------------------------ */

/**
 * Analyse DÉTERMINISTE de l'intention audio d'une demande :
 *  - « son » : bruit/ambiance explicite (déclencheurs « son de », « bruit
 *    de », « ambiance », « effet sonore », « sound of » + lexique SFX) —
 *    PRIORITAIRE sur « voix » (« voix de la pluie » = un son) ;
 *  - « voix » : parole humaine (lire, raconter, voix, podcast, bulletin…
 *    — « météo » ne compte qu'ancrée avec « bulletin ») + vitesse
 *    expressive automatique ;
 *  - « musique » : demande musicale pure ;
 *  - « inconnu » : hors vocabulaire — aucune invention.
 */
export function analyserIntentionAudio(prompt: string): IntentionAudio {
  const tokens = tokenizer(prompt);
  const texte = tokens.join(" ");

  // 1. SON — priorité maximale : un bruit n'est JAMAIS une parole.
  for (const [regex, label] of PHRASES_SON) {
    if (regex.test(texte)) {
      return { nature: "son", motif: `bruit demandé (${label})` };
    }
  }
  const stemSon = chercherStem(tokens, STEMS_SON, GARDES_SON);
  if (stemSon) {
    return { nature: "son", motif: `son reconnu (${stemSon})` };
  }

  // 2. VOIX — parole humaine : TTS réel + vitesse expressive.
  const stemBulletin = chercherStem(tokens, ["bulletin"]);
  if (stemBulletin) {
    // Ancre demandée : « météo » n'est parole qu'accompagnée du bulletin.
    const meteo = chercherStem(tokens, ["meteo"]);
    return parole(`parole demandée (bulletin${meteo ? " météo" : ""})`, tokens);
  }
  const phraseVoix = PHRASES_VOIX.some((regex) => regex.test(texte));
  const stemVoix = phraseVoix ? "tell me" : chercherStem(tokens, STEMS_VOIX, GARDES_VOIX);
  if (stemVoix) {
    return parole(`parole demandée (${stemVoix})`, tokens);
  }

  // 3. MUSIQUE — demande musicale pure (jamais de texte lu à voix haute).
  const stemMusique = chercherStem(tokens, STEMS_MUSIQUE, GARDES_MUSIQUE);
  if (stemMusique) {
    return { nature: "musique", motif: `musique demandée (${stemMusique})` };
  }

  // 4. INCONNU — honnêteté : aucun déclencheur reconnu.
  return {
    nature: "inconnu",
    motif: "aucun déclencheur FR/EN connu — nature indéterminée",
  };
}

/** Décision « voix » avec vitesse expressive automatique (ton posé
 *  prioritaire sur ton dynamique en cas de conflit — défaut neutre 1). */
function parole(base: string, tokens: string[]): IntentionAudio {
  const lent = chercherStem(tokens, STEMS_LENTS);
  const vif = lent ? null : chercherStem(tokens, STEMS_VIFS);
  const vitesse = lent ? VITESSE_POSE : vif ? VITESSE_DYNAMIQUE : 1;
  const suffixe = lent ? " — ton posé (0.85)" : vif ? " — ton dynamique (1.15)" : "";
  return { nature: "voix", vitesse, motif: `${base}${suffixe}` };
}
