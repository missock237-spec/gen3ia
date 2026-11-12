/**
 * CATALOGUE DE STYLES MUSICAUX + ANALYSE DE LA DEMANDE (français naturel).
 *
 * Mission propriétaire gen3ia (Task 2-a AUDIO) : « la génération d'audio
 * doit être EN RAPPORT avec la demande de l'utilisateur… une vraie MUSIQUE
 * générable (ex. crée une musique de 2 min → un vrai fichier audio de
 * ~120 s livré dans la conversation) ».
 *
 * Ce module est PUR (aucun I/O, aucune dépendance) : il transforme une
 * demande en français naturel — « une musique calme de 2 minutes au piano »
 * — en paramètres musicaux exploitables par la composition algorithmique :
 *  - STYLE (id du catalogue, avec tempo, gamme, progression d'accords,
 *    timbres par couche, intensité, percussions, swing) ;
 *  - DURÉE (« 2 min », « 90 secondes », « 1 min 30 », « une heure » → bornée) ;
 *  - HUMEUR (calme, triste, joyeuse, énergique, sommeil, dramatique) qui
 *    module tempo/intensité/mode de façon déterministe ;
 *  - TEMPO explicite (« 120 bpm ») — l'utilisateur gagne toujours ;
 *  - INSTRUMENTS cités (« au piano », « à la guitare ») qui orientent les
 *    timbres des couches mélodie/harmonie.
 *
 * AUCUNE ambiguïté cachée : tout ce qui est détecté est renvoyé dans le
 * résultat (booleans `styleDemande` / `dureeDetectee` / `humeur`) pour que
 * le tool et le planner sachent exactement ce qui a été inféré.
 */

/** Timbres synthétiques disponibles (additifs purs, Node sans dépendance). */
export const TIMBRES_MUSIQUE = [
  "piano",
  "guitare",
  "nappe",
  "cordes",
  "synthe",
  "cloche",
  "orgue",
  "marimba",
  "flute",
] as const;

export type TimbreMusique = (typeof TIMBRES_MUSIQUE)[number];

/** Densité des percussions légères du style. */
export type PercussionMusique = "aucune" | "legere" | "moderee" | "marquee";

export interface StyleMusique {
  /** Identifiant stable (utilisable comme paramètre `style` du tool). */
  id: string;
  /** Libellé français lisible (messages utilisateur / meta). */
  label: string;
  /** Tempo nominal en BPM (modulé par l'humeur/tempo explicite). */
  tempoBpm: number;
  /** Note fondamentale (MIDI) de la couche harmonie (mélodie +12). */
  fondamentaleMidi: number;
  /** Mode de la gamme diatonique. */
  mode: "majeur" | "mineur";
  /** Racine diatonique (0 = tonique) de chaque accord, 1 accord par mesure. */
  progressionDegres: number[];
  /** Ajouter la 7ᵉ diatonique aux accords (jazz/lofi). */
  accordsSeptieme: boolean;
  /** Timbre de la couche accords/nappe. */
  timbreHarmonie: TimbreMusique;
  /** Timbre de la couche mélodie. */
  timbreMelodie: TimbreMusique;
  /** Timbre de la couche basse. */
  timbreBasse: TimbreMusique;
  /** Intensité 0..1 — densité, vélocités percussions. */
  intensite: number;
  percussion: PercussionMusique;
  /** Shuffle 0..0.35 (jazz, lofi). */
  swing: number;
  /** Description honnête (note livrée à l'utilisateur). */
  description: string;
}

/** Catalogue de styles — NE JAMAIS MUTER (les demandes en reçoivent une copie ajustée). */
export const CATALOGUE_STYLES: readonly StyleMusique[] = [
  {
    id: "lofi",
    label: "lofi",
    tempoBpm: 72,
    fondamentaleMidi: 57, // A3
    mode: "mineur",
    progressionDegres: [0, 3, 5, 4],
    accordsSeptieme: true,
    timbreHarmonie: "piano",
    timbreMelodie: "synthe",
    timbreBasse: "piano",
    intensite: 0.55,
    percussion: "moderee",
    swing: 0.18,
    description: "Lofi chill : tempo lent, accords 7ᵉ, swing doux, ambiance d'étude.",
  },
  {
    id: "pop",
    label: "pop",
    tempoBpm: 112,
    fondamentaleMidi: 48, // C3
    mode: "majeur",
    progressionDegres: [0, 4, 5, 3],
    accordsSeptieme: false,
    timbreHarmonie: "piano",
    timbreMelodie: "synthe",
    timbreBasse: "piano",
    intensite: 0.75,
    percussion: "marquee",
    swing: 0,
    description: "Pop entraînante : I–V–vi–IV, mélodie accrocheuse, rythmique franche.",
  },
  {
    id: "cinematique",
    label: "cinématique",
    tempoBpm: 84,
    fondamentaleMidi: 50, // D3
    mode: "mineur",
    progressionDegres: [0, 5, 2, 6],
    accordsSeptieme: false,
    timbreHarmonie: "cordes",
    timbreMelodie: "piano",
    timbreBasse: "cordes",
    intensite: 0.5,
    percussion: "legere",
    swing: 0,
    description: "Cinématique : nappes de cordes, respiration large, montées émotionnelles.",
  },
  {
    id: "electronique",
    label: "électronique",
    tempoBpm: 124,
    fondamentaleMidi: 45, // A2
    mode: "mineur",
    progressionDegres: [0, 5, 3, 4],
    accordsSeptieme: false,
    timbreHarmonie: "nappe",
    timbreMelodie: "synthe",
    timbreBasse: "synthe",
    intensite: 0.8,
    percussion: "marquee",
    swing: 0,
    description: "Électronique : pulsation régulière, nappes, basse synthétique dansante.",
  },
  {
    id: "acoustique",
    label: "acoustique",
    tempoBpm: 96,
    fondamentaleMidi: 55, // G3
    mode: "majeur",
    progressionDegres: [0, 3, 4, 5],
    accordsSeptieme: false,
    timbreHarmonie: "guitare",
    timbreMelodie: "piano",
    timbreBasse: "guitare",
    intensite: 0.45,
    percussion: "legere",
    swing: 0.05,
    description: "Acoustique : guitare sèche / piano, chaleureux et organique.",
  },
  {
    id: "jazz",
    label: "jazz",
    tempoBpm: 108,
    fondamentaleMidi: 53, // F3
    mode: "majeur",
    progressionDegres: [1, 4, 0, 3],
    accordsSeptieme: true,
    timbreHarmonie: "piano",
    timbreMelodie: "piano",
    timbreBasse: "piano",
    intensite: 0.6,
    percussion: "moderee",
    swing: 0.28,
    description: "Jazz : ii–V–I, accords 7ᵉ, walking bass et swing.",
  },
  {
    id: "ambient",
    label: "ambient",
    tempoBpm: 60,
    fondamentaleMidi: 48, // C3
    mode: "majeur",
    progressionDegres: [0, 5, 3, 2],
    accordsSeptieme: false,
    timbreHarmonie: "nappe",
    timbreMelodie: "cloche",
    timbreBasse: "nappe",
    intensite: 0.15,
    percussion: "aucune",
    swing: 0,
    description: "Ambient : nappes très lentes, cloches éparses, aucune percussion.",
  },
  {
    id: "rock",
    label: "rock",
    tempoBpm: 122,
    fondamentaleMidi: 52, // E3
    mode: "mineur",
    progressionDegres: [0, 5, 6, 4],
    accordsSeptieme: false,
    timbreHarmonie: "guitare",
    timbreMelodie: "guitare",
    timbreBasse: "synthe",
    intensite: 0.85,
    percussion: "marquee",
    swing: 0,
    description: "Rock : guitares tranchantes, backbeat marqué, énergie constante.",
  },
  {
    id: "classique",
    label: "classique",
    tempoBpm: 90,
    fondamentaleMidi: 48, // C3
    mode: "majeur",
    progressionDegres: [0, 3, 4, 0],
    accordsSeptieme: false,
    timbreHarmonie: "cordes",
    timbreMelodie: "piano",
    timbreBasse: "cordes",
    intensite: 0.35,
    percussion: "aucune",
    swing: 0,
    description: "Classique : quatuor de cordes, phrases chantantes, sans percussions.",
  },
] as const;

/** Style par défaut quand la demande ne cite aucun style identifiable. */
export const STYLE_PAR_DEFAUT_ID = "pop";

/** Durée par défaut (scénario propriétaire : « crée une musique de 2 min »). */
export const DUREE_PAR_DEFAUT_S = 120;

/** Bornes de durée du tool musique.creer (les demandes hors bornes sont bornées). */
export const DUREE_MIN_S = 30;
export const DUREE_MAX_S = 300;

/** Mots-clés par style — PREMIER tableau dont une entrée matche qui gagne. */
const MOTS_CLES_STYLES: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "lofi", re: /\b(?:lo-?fi|chill)\b|\b(?:[ée]tude|study|boom-?bap|étudiant)\b/iu },
  { id: "jazz", re: /\b(?:jazz|swing|bossa|bebop|bop)\b/iu },
  {
    id: "ambient",
    re: /\b(?:ambient|ambiant|zen|spa)\b|m[ée]ditation|relaxation|sommeil|endorm|dormir|d[ée]tente|paisible/iu,
  },
  {
    id: "electronique",
    re: /[ée]lectronique|\b(?:techno|house|edm|trance|synthwave|electro|dance|club|dj|synthwave)\b/iu,
  },
  {
    id: "cinematique",
    re: /cin[ée]matique|cin[ée]ma|[ée]pique|\bepic\b|bande originale|bande-son|\btrailer\b|orchestre|hollywood/iu,
  },
  { id: "acoustique", re: /acoustique|folk|guitare s[èe]che|ballade|\bpiano\b|au piano|chanson/iu },
  { id: "rock", re: /\b(?:rock|punk|m[ée]tal)\b/iu },
  { id: "classique", re: /classique|classical|symphonie|concerto|\bvalse\b|quatuor|baroque/iu },
  { id: "pop", re: /\bpop\b/iu },
];

/** Instruments cités → timbre correspondant. */
const MOTS_CLES_INSTRUMENTS: ReadonlyArray<{ timbre: TimbreMusique; re: RegExp }> = [
  { timbre: "piano", re: /\bpiano(?:s)?\b|pianiste/iu },
  { timbre: "guitare", re: /guitare|acoustic guitar/iu },
  { timbre: "cordes", re: /cordes|violon(?:celle)?|quatuor|archet/iu },
  { timbre: "nappe", re: /nappe(?:s)?|pad(?:s)?|drone/iu },
  { timbre: "cloche", re: /cloche(?:s)?|carillon|glockenspiel/iu },
  { timbre: "flute", re: /fl[ûu]te/iu },
  { timbre: "orgue", re: /\borgue\b|orgue de barbare|hammond/iu },
  { timbre: "marimba", re: /marimba|xylophone|kalimba/iu },
  { timbre: "synthe", re: /synth[ée]|synth(?:etiseur)?|moog|vintage synth/iu },
];

/** Humeurs détectées — ordre de priorité fixe (déterministe). */
const HUMEURS: ReadonlyArray<{
  id: string;
  label: string;
  re: RegExp;
  facteurTempo: number;
  deltaIntensite: number;
  mode?: "majeur" | "mineur";
}> = [
  {
    id: "sommeil",
    label: "sommeil",
    re: /sommeil|endorm|dormir|berceuse|\bsleep\b|nuit/iu,
    facteurTempo: 0.78,
    deltaIntensite: -0.4,
  },
  {
    id: "calme",
    label: "calme",
    re: /calme|douce?|d[ée]tent|apais|paisible|seren?in|doux/iu,
    facteurTempo: 0.92,
    deltaIntensite: -0.25,
  },
  {
    id: "triste",
    label: "triste",
    re: /triste|m[ée]lancol|nostalgi|douce am[èe]re|chagrin/iu,
    facteurTempo: 0.9,
    deltaIntensite: -0.15,
    mode: "mineur",
  },
  {
    id: "dramatique",
    label: "dramatique",
    re: /dramatique|tension|suspens|mena[çc]ant|angoissant|angoisse/iu,
    facteurTempo: 0.95,
    deltaIntensite: 0.2,
    mode: "mineur",
  },
  {
    id: "energique",
    label: "énergique",
    re: /[ée]nergique|dynamique|puissant|intense|\bfast\b|sport|workout|motivation/iu,
    facteurTempo: 1.12,
    deltaIntensite: 0.3,
  },
  {
    id: "joyeuse",
    label: "joyeuse",
    re: /joyeu|heureu|entra[îi]nant|festif|\bf[êe]te\b|soleil|printemps|bonheur/iu,
    facteurTempo: 1.08,
    deltaIntensite: 0.2,
    mode: "majeur",
  },
];

/** Nombres français acceptés pour les minutes (les chiffres restent prioritaires). */
const NOMBRES_FR: Record<string, number> = {
  "une": 1,
  "un": 1,
  "deux": 2,
  "trois": 3,
  "quatre": 4,
  "cinq": 5,
  "six": 6,
  "sept": 7,
  "huit": 8,
  "neuf": 9,
  "dix": 10,
  "quinze": 15,
  "vingt": 20,
  "trente": 30,
};

/** Résultat de l'analyse d'une demande musicale en français naturel. */
export interface DemandeMusiqueParsee {
  /** Style ajusté (copie du catalogue modulée par humeur/instruments/tempo). */
  style: StyleMusique;
  /** `true` quand la demande citait explicitement un style (sinon défaut). */
  styleDemande: boolean;
  /** Durée retenue (demandée bornée 30..300 s, sinon défaut 120 s). */
  dureeSecondes: number;
  /** `true` quand une durée a été détectée dans la demande. */
  dureeDetectee: boolean;
  /** Durée brute détectée AVANT bornage (utile aux messages honnêtes). */
  dureeDemandeeBrute?: number;
  /** Humeur détectée (« neutre » si aucune). */
  humeur: string;
  /** Tempo final retenu (bpm). */
  tempoBpm: number;
  /** Timbres d'instruments déduits des instruments cités (ordre de détection). */
  instruments: TimbreMusique[];
}

/** Bornage centralisé de la durée (comportement unique parse/tool). */
export function bornerDuree(duree: number): number {
  if (!Number.isFinite(duree)) return DUREE_PAR_DEFAUT_S;
  return Math.min(DUREE_MAX_S, Math.max(DUREE_MIN_S, Math.round(duree)));
}

/**
 * Extrait la durée d'une demande en français naturel :
 * « 2 min », « 2 minutes », « 90 secondes », « 90 s », « 1 min 30 »,
 * « une minute et demie », « demi-heure », « une heure », « deux minutes »…
 * Retourne `null` quand rien n'est détecté.
 */
export function extraireDureeSecondes(demande: string): number | null {
  const t = demande.toLowerCase().replace(/[’']/gu, " ");

  // 1) Format combiné « 2 min », « 2 minutes 30 », « 1 min 30 »,
  //    « 2 min et 30 s », « 1 minute et 30 secondes ».
  const combine = /(\d+)\s*(?:minutes?|min)\s*(?:et\s*)?(\d{1,2})?\s*(?:s(?:ec(?:onde)?s?)?)?\b/iu.exec(t);
  if (combine) {
    const minutes = Number(combine[1]);
    const secondes = combine[2] ? Number(combine[2]) : 0;
    const total = minutes * 60 + secondes;
    if (total > 0) return total;
  }

  // 2) Secondes seules : « 90 secondes », « 90 s », « 120s ».
  const sec = /(\d+)\s*(?:secondes?|sec|s)\b/iu.exec(t);
  if (sec) return Number(sec[1]);

  // 3) Heures (« une heure », « 1 heure » — borné ensuite à 300 s max).
  const heureMatch = /(\d+|une?)\s*heure\b/iu.exec(t);
  if (heureMatch) return 3600;

  // 4) Nombres français écrits en toutes lettres + « demie ».
  const minFr = /(?:une|un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|quinze|vingt|trente)\s+minutes?\b/iu.exec(t);
  if (minFr) {
    const n = NOMBRES_FR[minFr[0].trim().split(/\s+/)[0] ?? ""] ?? 1;
    const demie = /minute(?:s)?\s+et\s+demie?s?\b/iu.test(t);
    return n * 60 + (demie ? 30 : 0);
  }
  if (/demi-?\s*heure/iu.test(t)) return 180;
  return null;
}

/** Bornes de tempo plausibles (garde anti-délire « 9999 bpm »). */
const TEMPO_MIN_BPM = 40;
const TEMPO_MAX_BPM = 190;

/** Style de base du catalogue par id (`undefined` si id inconnu). */
export function styleParId(id: string): StyleMusique | undefined {
  return CATALOGUE_STYLES.find((s) => s.id === id);
}

/**
 * Applique à une COPIE du style de base les modulations déduites du texte :
 * humeur (tempo/intensité/mode), tempo explicite (« 120 bpm » — l'utilisateur
 * gagne toujours) et instruments cités (timbres mélodie/harmonie). Pur et
 * déterministe — séparé de parseStyleMusique pour qu'un style IMPOSÉ par le
 * planner conserve les nuances de la demande (humeur/instruments).
 */
export function appliquerModulations(base: StyleMusique, demande: string): {
  style: StyleMusique;
  humeur: string;
  instruments: TimbreMusique[];
} {
  const t = (demande ?? "").toLowerCase();
  const style: StyleMusique = { ...base };

  // ── Humeur (première entrée qui matche — priorité fixe) ──
  let humeur = "neutre";
  for (const h of HUMEURS) {
    if (h.re.test(t)) {
      humeur = h.id;
      style.tempoBpm = Math.round(style.tempoBpm * h.facteurTempo);
      style.intensite = Math.min(1, Math.max(0.05, style.intensite + h.deltaIntensite));
      if (h.mode) style.mode = h.mode;
      break;
    }
  }

  // ── Tempo explicite (« 120 bpm ») — l'utilisateur gagne TOUJOURS ──
  const bpmMatch = /(\d{2,3})\s*bpm\b/iu.exec(t);
  if (bpmMatch) {
    const bpm = Number(bpmMatch[1]);
    if (bpm >= TEMPO_MIN_BPM && bpm <= TEMPO_MAX_BPM) style.tempoBpm = bpm;
  }

  // ── Instruments cités → timbres (mélodie ; harmonie pour piano/guitare) ──
  const instruments: TimbreMusique[] = [];
  for (const ins of MOTS_CLES_INSTRUMENTS) {
    if (ins.re.test(t)) {
      instruments.push(ins.timbre);
      style.timbreMelodie = ins.timbre;
      if (ins.timbre === "piano" || ins.timbre === "guitare") {
        style.timbreHarmonie = ins.timbre;
      }
    }
  }

  return { style, humeur, instruments };
}

/**
 * Analyse une demande musicale française naturelle → paramètres de
 * composition. Déterministe : même demande → même résultat.
 */
export function parseStyleMusique(demande: string): DemandeMusiqueParsee {
  const texte = (demande ?? "").trim();
  const t = texte.toLowerCase();

  // ── 1) Style ──
  const styleMatch = MOTS_CLES_STYLES.find((e) => e.re.test(t));
  const styleDemande = Boolean(styleMatch);
  const base = styleParId(styleMatch?.id ?? STYLE_PAR_DEFAUT_ID) ?? CATALOGUE_STYLES[0];
  const modulations = appliquerModulations(base, texte);
  const style = modulations.style;
  const humeur = modulations.humeur;
  const instruments = modulations.instruments;

  // ── 2) Durée ──
  const dureeBrute = extraireDureeSecondes(texte);
  const dureeDetectee = dureeBrute !== null;

  return {
    style,
    styleDemande,
    dureeSecondes: dureeDetectee ? bornerDuree(dureeBrute) : DUREE_PAR_DEFAUT_S,
    dureeDetectee,
    ...(dureeDetectee && dureeBrute !== bornerDuree(dureeBrute) ? { dureeDemandeeBrute: dureeBrute } : {}),
    humeur,
    tempoBpm: style.tempoBpm,
    instruments,
  };
}

/** Liste des ids de style admis (messages d'erreur / description du tool). */
export function idsStylesMusique(): string[] {
  return CATALOGUE_STYLES.map((s) => s.id);
}
