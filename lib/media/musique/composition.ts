/**
 * COMPOSITION MUSICALE ALGORITHMIQUE — DÉTERMINISTE, PUR NODE, SANS DÉPENDANCE.
 *
 * Mission propriétaire gen3ia (Task 2-a AUDIO) : « crée une musique de 2 min »
 * doit produire un VRAI fichier audio de ~120 s — pas une nappe muette
 * déguisée en musique. Ici la composition est réelle :
 *  - graine = hash FNV-1a de la demande → même demande = MÊMES octets
 *    (composition déterministe, testée) ;
 *  - progression d'accords diatonique par mesure (catalogue de style),
 *    mélodie (contour probabiliste sur la gamme, aimantée vers les notes
 *    d'accords), basse (motif par style, walking jazz), percussions légères
 *    (kick/snare/hat synthétisées) ;
 *  - structure intro / couplet / refrain / outro avec intensités graduées ;
 *  - rendu PCM 44 100 Hz STÉRÉO 16 bits (Buffer) par synthèse additive pure
 *    — oscillateurs sinusoïdaux, enveloppes (percussives vs soutenues),
 *    panoramique égal-puissance par couche.
 *
 * HONNÊTETÉ : c'est une composition algorithmique instrumentale — ce n'est
 * PAS un modèle génératif de type Suno/Stem. La note livrée au dit
 * explicitement. Aucune dépendance externe : uniquement Buffer + Math.
 */

import type { StyleMusique, TimbreMusique } from "./styles";

/** Fréquence d'échantillonnage du rendu (qualité CD). */
export const FREQUENCE_COMPOSITION = 44100;

/** Canaux du rendu (stéréo — largeur subtile par couche). */
export const CANAUX_COMPOSITION = 2;

/** Niveau crête cible après normalisation (≈ −1,4 dBFS). */
const CIBLE_CRETE = 0.85;

/** Bornes de durée acceptées par le compositeur (sécurité mémoire). */
export const DUREE_COMPOSITION_MIN_S = 10;
export const DUREE_COMPOSITION_MAX_S = 600;

/* ──────────────────────────────────────────────────────────────────────────
 * GRAINE DÉTERMINISTE (hash de la demande)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Hash FNV-1a 32 bits de la demande (UTF-8, trim, minuscules) — la graine
 * de la composition. Même demande → même graine → mêmes octets de musique.
 */
export function calculerGraine(demande: string): string {
  const octets = Buffer.from((demande ?? "").trim().toLowerCase(), "utf8");
  let h = 0x811c9dc5;
  for (let i = 0; i < octets.length; i++) {
    h ^= octets[i] as number;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** PRNG mulberry32 — déterministe, rapide, qualité suffisante pour la musique. */
function mulberry32(graine: number): () => number {
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * THÉORIE MUSICALE (diatonique, pur)
 * ────────────────────────────────────────────────────────────────────────── */

const GAMME_MAJEUR = [0, 2, 4, 5, 7, 9, 11] as const;
const GAMME_MINEUR = [0, 2, 3, 5, 7, 8, 10] as const;
const NOMS_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** MIDI → fréquence (Hz). */
function frequenceMidi(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Degré diatonique (index dans la gamme, extensible par octaves) → MIDI. */
function midiDegre(fondamentaleMidi: number, gamme: readonly number[], degre: number): number {
  const octave = Math.floor(degre / gamme.length);
  const idx = ((degre % gamme.length) + gamme.length) % gamme.length;
  return fondamentaleMidi + (gamme[idx] as number) + 12 * octave;
}

/** Nom lisible d'un accord (ex. « Am », « F », « G7 ») pour les métadonnées. */
function nomAccord(
  fondamentaleMidi: number,
  gamme: readonly number[],
  degre: number,
  septieme: boolean,
): string {
  const racine = midiDegre(fondamentaleMidi, gamme, degre);
  const tierce = midiDegre(fondamentaleMidi, gamme, degre + 2) - racine;
  const nom = NOMS_NOTES[((racine % 12) + 12) % 12] ?? "?";
  let qualite = "";
  if (tierce % 12 === 3) qualite = "m";
  else if (tierce % 12 !== 4) qualite = "sus";
  if (septieme) {
    const sept = midiDegre(fondamentaleMidi, gamme, degre + 6) - racine;
    qualite += sept % 12 === 10 ? "7" : "maj7";
  }
  return `${nom}${qualite}`;
}

/* ──────────────────────────────────────────────────────────────────────────
 * STRUCTURE (intro / couplet / refrain / outro)
 * ────────────────────────────────────────────────────────────────────────── */

export interface SectionMusicale {
  nom: "intro" | "couplet" | "refrain" | "outro";
  /** Intensité relative 0..1 de la section (densité, percussions). */
  intensite: number;
  debutMesure: number;
  nbMesures: number;
}

/** Découpe les mesures totales en sections graduées (déterministe). */
function planifierStructure(nbMesures: number): SectionMusicale[] {
  const intro = Math.min(2, Math.max(1, Math.floor(nbMesures * 0.1)));
  const outro = Math.min(2, Math.max(1, Math.floor(nbMesures * 0.1)));
  const milieu = Math.max(2, nbMesures - intro - outro);
  const sections: SectionMusicale[] = [
    { nom: "intro", intensite: 0.5, debutMesure: 0, nbMesures: intro },
  ];
  for (let i = 0; i < milieu; i++) {
    sections.push({
      nom: i % 2 === 0 ? "couplet" : "refrain",
      intensite: i % 2 === 0 ? 0.7 : 1,
      debutMesure: intro + i,
      nbMesures: 1,
    });
  }
  sections.push({ nom: "outro", intensite: 0.4, debutMesure: intro + milieu, nbMesures: outro });
  return sections;
}

/* ──────────────────────────────────────────────────────────────────────────
 * ÉVÉNEMENTS MUSICAUX
 * ────────────────────────────────────────────────────────────────────────── */

interface NoteEvenement {
  debutFrame: number;
  dureeFrames: number;
  midi: number;
  velosite: number;
  timbre: TimbreMusique;
  /** Panoramique −1 (gauche) .. +1 (droite). */
  pan: number;
}

type TypePercussion = "kick" | "snare" | "hat";

interface PercussionEvenement {
  debutFrame: number;
  type: TypePercussion;
  velosite: number;
  pan: number;
  /** Graine du bruit (déterminisme du rendu des percussions). */
  graineBruit: number;
}

/* ──────────────────────────────────────────────────────────────────────────
 * SYNTHÈSE ADDITIVE (pure, per-échantillon)
 * ────────────────────────────────────────────────────────────────────────── */

interface PartialDef {
  /** Multiplicateur de fréquence fondamentale. */
  mul: number;
  /** Amplitude relative. */
  amp: number;
}

interface TimbreDef {
  partials: readonly PartialDef[];
  /** Enveloppe percussive (décroissance exponentielle, tau en s) ou soutenue. */
  percussif: boolean;
  /** tau de décroissance (percussif) ou attaque (soutenu), en s. */
  tauOuAttaque: number;
  /** Durée de release pour les timbres soutenus. */
  releaseSec: number;
  /** Vibrato (amplitude relative, Hz) — cordes/flûte. */
  vibrato?: { amp: number; hz: number };
  /** Souffle (flûte). */
  souffle?: number;
}

const TIMBRES: Record<TimbreMusique, TimbreDef> = {
  piano: {
    partials: [{ mul: 1, amp: 1 }, { mul: 2, amp: 0.35 }, { mul: 3, amp: 0.12 }],
    percussif: true,
    tauOuAttaque: 0.9,
    releaseSec: 0,
  },
  guitare: {
    partials: [{ mul: 1, amp: 1 }, { mul: 2, amp: 0.3 }, { mul: 4, amp: 0.08 }],
    percussif: true,
    tauOuAttaque: 0.6,
    releaseSec: 0,
  },
  nappe: {
    partials: [{ mul: 1, amp: 0.8 }, { mul: 1.005, amp: 0.5 }, { mul: 2, amp: 0.2 }],
    percussif: false,
    tauOuAttaque: 0.3,
    releaseSec: 0.4,
  },
  cordes: {
    partials: [{ mul: 1, amp: 0.7 }, { mul: 2, amp: 0.25 }],
    percussif: false,
    tauOuAttaque: 0.25,
    releaseSec: 0.3,
    vibrato: { amp: 0.004, hz: 5 },
  },
  synthe: {
    partials: [{ mul: 1, amp: 0.9 }, { mul: 3, amp: 0.25 }, { mul: 5, amp: 0.12 }],
    percussif: false,
    tauOuAttaque: 0.02,
    releaseSec: 0.08,
  },
  cloche: {
    partials: [{ mul: 1, amp: 1 }, { mul: 2.76, amp: 0.5 }, { mul: 5.4, amp: 0.25 }, { mul: 8.9, amp: 0.1 }],
    percussif: true,
    tauOuAttaque: 1.8,
    releaseSec: 0,
  },
  orgue: {
    partials: [{ mul: 1, amp: 1 }, { mul: 2, amp: 0.45 }, { mul: 3, amp: 0.2 }],
    percussif: false,
    tauOuAttaque: 0.02,
    releaseSec: 0.05,
  },
  marimba: {
    partials: [{ mul: 1, amp: 1 }, { mul: 4, amp: 0.3 }, { mul: 9.2, amp: 0.1 }],
    percussif: true,
    tauOuAttaque: 0.35,
    releaseSec: 0,
  },
  flute: {
    partials: [{ mul: 1, amp: 0.95 }, { mul: 2, amp: 0.12 }],
    percussif: false,
    tauOuAttaque: 0.04,
    releaseSec: 0.1,
    souffle: 0.015,
  },
};

/** Panoramique égal-puissance → gains (gauche, droite). */
function gainsPan(pan: number): [number, number] {
  const theta = (Math.min(1, Math.max(-1, pan)) + 1) * (Math.PI / 4);
  return [Math.cos(theta), Math.sin(theta)];
}

/** Rend une note (synthèse additive + enveloppe) dans les canaux L/R. */
function rendreNote(
  gauche: Float32Array,
  droite: Float32Array,
  evt: NoteEvenement,
): void {
  const def = TIMBRES[evt.timbre] ?? TIMBRES.piano;
  const fs = FREQUENCE_COMPOSITION;
  const f0 = frequenceMidi(evt.midi);
  const [gL, gR] = gainsPan(evt.pan);
  const n = evt.dureeFrames;
  const debut = evt.debutFrame;
  const attaqueFrames = def.percussif
    ? Math.max(1, Math.round(0.004 * fs))
    : Math.max(1, Math.round(def.tauOuAttaque * fs));
  const releaseFrames = def.percussif ? 0 : Math.round(def.releaseSec * fs);
  const tau = def.percussif ? def.tauOuAttaque * fs : 0;
  // Phases initiales déterministes (déduites de la note — pas d'aléa).
  const phaseInit = new Float64Array(def.partials.length);
  for (let p = 0; p < def.partials.length; p++) {
    phaseInit[p] = ((evt.midi * 0.6180339887 * (p + 1)) % 1) * 2 * Math.PI;
  }
  const increments = def.partials.map((p) => (f0 * p.mul * 2 * Math.PI) / fs);
  const vibrateur = def.vibrato
    ? { inc: (def.vibrato.hz * 2 * Math.PI) / fs, phase: 0, amp: def.vibrato.amp }
    : null;
  const souffleGraine = ((evt.midi << 6) ^ evt.debutFrame) >>> 0;
  const souffle = def.souffle ?? 0;
  const bruit = def.souffle ? mulberry32(souffleGraine) : null;

  for (let i = 0; i < n; i++) {
    const idx = debut + i;
    if (idx >= gauche.length) break;
    const _t = i / fs;
    // Enveloppe.
    let g: number;
    if (i < attaqueFrames) {
      g = i / attaqueFrames;
    } else if (def.percussif) {
      g = Math.exp(-(i - attaqueFrames) / tau);
    } else {
      g = 1;
      const restant = n - i;
      if (restant < releaseFrames) g = restant / Math.max(1, releaseFrames);
    }
    if (g <= 0.00001) continue;
    // Vibrato (fondamentale seulement).
    let fmod = 1;
    if (vibrateur) {
      vibrateur.phase += vibrateur.inc;
      fmod = 1 + vibrateur.amp * Math.sin(vibrateur.phase);
    }
    // Somme des partiels.
    let echantillon = 0;
    for (let p = 0; p < def.partials.length; p++) {
      const partial = def.partials[p] as PartialDef;
      phaseInit[p] =
        (phaseInit[p] + (p === 0 ? increments[p] * fmod : (increments[p] as number))) % (2 * Math.PI);
      echantillon += partial.amp * Math.sin(phaseInit[p] as number);
    }
    if (bruit) echantillon += souffle * (bruit() * 2 - 1);
    const v = echantillon * g * evt.velosite;
    gauche[idx] = (gauche[idx] as number) + v * gL;
    droite[idx] = (droite[idx] as number) + v * gR;
  }
}

/** Rend une frappe de percussion (kick = chute de hauteur, snare/hat = bruit). */
function rendrePercussion(
  gauche: Float32Array,
  droite: Float32Array,
  evt: PercussionEvenement,
): void {
  const fs = FREQUENCE_COMPOSITION;
  const [gL, gR] = gainsPan(evt.pan);
  const bruit = mulberry32(evt.graineBruit);
  if (evt.type === "kick") {
    const n = Math.round(0.3 * fs);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const idx = evt.debutFrame + i;
      if (idx >= gauche.length) break;
      const t = i / fs;
      const freq = 48 + 75 * Math.exp(-t / 0.035); // 123 → 48 Hz
      phase += (freq * 2 * Math.PI) / fs;
      const g = Math.exp(-t / 0.16);
      const v = Math.sin(phase) * g * evt.velosite;
      gauche[idx] = (gauche[idx] as number) + v * gL;
      droite[idx] = (droite[idx] as number) + v * gR;
    }
    return;
  }
  const duree = evt.type === "snare" ? 0.16 : 0.05;
  const tau = evt.type === "snare" ? 0.06 : 0.022;
  const n = Math.round(duree * fs);
  let precedent = 0;
  for (let i = 0; i < n; i++) {
    const idx = evt.debutFrame + i;
    if (idx >= gauche.length) break;
    const t = i / fs;
    const g = Math.exp(-t / tau);
    const brut = bruit() * 2 - 1;
    // Différence finie = filtre passe-haut approximatif (charleston clinquant).
    const bruitFiltre = evt.type === "hat" ? brut - precedent : brut * 0.7 + precedent * 0.3;
    precedent = brut;
    let v = bruitFiltre * g * evt.velosite;
    if (evt.type === "snare") v += Math.sin((190 * 2 * Math.PI * t)) * g * 0.4 * evt.velosite;
    gauche[idx] = (gauche[idx] as number) + v * gL;
    droite[idx] = (droite[idx] as number) + v * gR;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * PLANIFICATION (graine → événements)
 * ────────────────────────────────────────────────────────────────────────── */

interface PlanCompose {
  notes: NoteEvenement[];
  percussions: PercussionEvenement[];
  sections: SectionMusicale[];
  accords: string[];
  nbMesures: number;
  mesureSec: number;
}

const VELOCITES = { forte: 0.9, mezza: 0.7, piano: 0.5, ombre: 0.32 };

function planifier(params: {
  graine: number;
  dureeSecondes: number;
  style: StyleMusique;
  intensiteGlobale?: number;
}): PlanCompose {
  const rng = mulberry32(params.graine);
  const style = params.style;
  const gamme = style.mode === "majeur" ? GAMME_MAJEUR : GAMME_MINEUR;
  const tempo = Math.min(190, Math.max(40, style.tempoBpm));
  const mesureSec = (4 * 60) / tempo;
  const nbMesures = Math.max(4, Math.round(params.dureeSecondes / mesureSec));
  const sections = planifierStructure(nbMesures);
  const framesParMesure = Math.round(mesureSec * FREQUENCE_COMPOSITION);
  const framesTotal = nbMesures * framesParMesure;
  const notes: NoteEvenement[] = [];
  const percussions: PercussionEvenement[] = [];
  const accords: string[] = [];

  // État de la mélodie (marche sur les degrés de la gamme).
  let degreMelodie = 7; // une octave au-dessus de la tonique
  const intensiteGlobale = Math.min(1, Math.max(0.05, params.intensiteGlobale ?? style.intensite));

  for (const section of sections) {
    for (let m = 0; m < section.nbMesures; m++) {
      const mesure = section.debutMesure + m;
      const debutFrame = mesure * framesParMesure;
      const degreAccord = style.progressionDegres[mesure % style.progressionDegres.length] ?? 0;
      accords.push(nomAccord(style.fondamentaleMidi, gamme, degreAccord, style.accordsSeptieme));
      const estIntroOutro = section.nom === "intro" || section.nom === "outro";
      const intensite = intensiteGlobale * section.intensite;

      // ── HARMONIE : accord tenu sur la mesure (3 ou 4 voix) ──
      const voixAccord = style.accordsSeptieme ? [0, 2, 4, 6] : [0, 2, 4];
      voixAccord.forEach((intervalle, iVoix) => {
        const midi = midiDegre(style.fondamentaleMidi, gamme, degreAccord + intervalle);
        notes.push({
          debutFrame,
          dureeFrames: framesParMesure,
          midi,
          velosite: (estIntroOutro ? VELOCITES.ombre : VELOCITES.mezza) * (1 - iVoix * 0.12) * intensiteGlobale,
          timbre: style.timbreHarmonie,
          pan: -0.28 + rng() * 0.08,
        });
      });

      // ── BASSE : motif selon la densité du style ──
      const battementsBasse = estIntroOutro
        ? [0]
        : style.percussion === "marquee" || style.id === "electronique"
          ? [0, 2]
          : style.accordsSeptieme
            ? [0, 1, 2, 3] // jazz : walking bass
            : [0, 2];
      for (const battement of battementsBasse) {
        const midi = midiDegre(style.fondamentaleMidi, gamme, degreAccord) - 12;
        const dureeBattement = framesParMesure / 4;
        const jitter = style.accordsSeptieme && battement > 0 ? Math.round(rng() * 2) - 1 : 0;
        notes.push({
          debutFrame: debutFrame + Math.round(battement * dureeBattement),
          dureeFrames: Math.round(dureeBattement * 0.92),
          midi: midi + jitter,
          velosite: VELOCITES.mezza * intensiteGlobale,
          timbre: style.timbreBasse,
          pan: (rng() - 0.5) * 0.06,
        });
      }

      // ── MÉLODIE : grille de croches, contour probabiliste, aimant chord-tones ──
      const densite = estIntroOutro ? 0.25 : section.nom === "refrain" ? 0.6 : 0.42;
      for (let slot = 0; slot < 8; slot++) {
        const fort = slot === 0 || slot === 4;
        if (rng() > densite + (fort ? 0.18 : 0)) continue;
        // Aimantation vers les notes de l'accord sur les temps forts.
        if (fort) {
          const cibles = [degreAccord, degreAccord + 2, degreAccord + 4];
          const proche = cibles.reduce((a, b) =>
            Math.abs(b - degreMelodie) < Math.abs(a - degreMelodie) ? b : a,
          );
          degreMelodie = proche;
        } else {
          const pas = [-2, -1, 1, 2][Math.floor(rng() * 4)] ?? 1;
          degreMelodie = Math.min(16, Math.max(4, degreMelodie + pas));
        }
        const midi = midiDegre(style.fondamentaleMidi, gamme, degreMelodie) + 12;
        const dureeSlots = rng() < 0.25 ? 2 : 1;
        const swingDecale = slot % 2 === 1 ? style.swing * (framesParMesure / 8) : 0;
        notes.push({
          debutFrame: debutFrame + Math.round((slot * framesParMesure) / 8 + swingDecale),
          dureeFrames: Math.round((dureeSlots * framesParMesure) / 8 * 0.9),
          midi,
          velosite: (fort ? VELOCITES.forte : VELOCITES.piano) * (0.6 + 0.4 * intensite),
          timbre: style.timbreMelodie,
          pan: 0.3 + rng() * 0.08,
        });
      }

      // ── PERCUSSIONS LÉGÈRES (selon style × section) ──
      const graineBruitBase = (params.graine ^ (mesure * 0x9e3779b9)) >>> 0;
      const pose = (battement16: number, type: TypePercussion, vel: number): void => {
        const position = Math.round((battement16 * framesParMesure) / 16);
        if (debutFrame + position >= framesTotal) return;
        percussions.push({
          debutFrame: debutFrame + position,
          type,
          velosite: vel * (0.5 + 0.5 * intensite),
          pan: type === "hat" ? 0.4 : (rng() - 0.5) * 0.1,
          graineBruit: (graineBruitBase + battement16 * 7919) >>> 0,
        });
      };
      if (!estIntroOutro || intensite > 0.25) {
        if (style.percussion === "legere") {
          for (const s of [2, 6, 10, 14]) if (!estIntroOutro) pose(s, "hat", 0.3);
          if (section.nom === "refrain") pose(0, "kick", 0.55);
        } else if (style.percussion === "moderee") {
          pose(0, "kick", 0.75);
          pose(8, "kick", 0.6);
          for (const s of [2, 6, 10, 14]) pose(s, "hat", 0.28);
          if (section.nom === "refrain") {
            pose(4, "snare", 0.5);
            pose(12, "snare", 0.5);
          }
        } else if (style.percussion === "marquee") {
          pose(0, "kick", 0.9);
          pose(8, "kick", 0.7);
          if (section.nom === "refrain" && style.id === "electronique") pose(11, "kick", 0.5);
          pose(4, "snare", 0.65);
          pose(12, "snare", 0.65);
          for (let s = 0; s < 16; s += 2) pose(s, "hat", s % 4 === 0 ? 0.3 : 0.22);
        }
      }
    }
  }

  notes.sort((a, b) => a.debutFrame - b.debutFrame);
  percussions.sort((a, b) => a.debutFrame - b.debutFrame);
  return { notes, percussions, sections, accords, nbMesures, mesureSec };
}

/* ──────────────────────────────────────────────────────────────────────────
 * COMPOSITION COMPLÈTE (événements → PCM stéréo 16 bits)
 * ────────────────────────────────────────────────────────────────────────── */

export interface CompositionMusicale {
  /** PCM 16 bits entrelacé (L,R) — entrée directe de l'encodeur WAV. */
  pcm: Buffer;
  frequence: number;
  canaux: number;
  /** Nombre d'images (frames) stéréo. */
  echantillons: number;
  /** Durée EXACTE du PCM (echantillons / frequence). */
  dureeSecondes: number;
  /** Graine hexadécimale (hash de la demande) — traçabilité. */
  seed: string;
  tempoBpm: number;
  /** Accords posés mesure par mesure (lecture honnête dans les méta). */
  accords: string[];
  structure: Array<{ nom: string; debutSec: number; dureeSec: number }>;
  nbMesures: number;
}

/**
 * Compose la musique complète pour une demande. DÉTERMINISTE : même
 * demande + même style → octets PCM identiques (testé).
 */
export function composerMusique(params: {
  demande: string;
  /** Durée cible en secondes (bornée 10..600). */
  dureeSecondes: number;
  /** Style ajusté issu de parseStyleMusique (jamais muté). */
  style: StyleMusique;
  /** Surcharge d'intensité globale (0..1). */
  intensite?: number;
}): CompositionMusicale {
  const duree = Math.min(
    DUREE_COMPOSITION_MAX_S,
    Math.max(DUREE_COMPOSITION_MIN_S, params.dureeSecondes || 120),
  );
  const seed = calculerGraine(params.demande);
  const graine = parseInt(seed, 16) >>> 0;
  const plan = planifier({
    graine,
    dureeSecondes: duree,
    style: params.style,
    ...(params.intensite !== undefined ? { intensiteGlobale: params.intensite } : {}),
  });

  // Nombre d'images EXACT : la durée livrée est celle du PCM, à l'échantillon près.
  const echantillons = Math.round(duree * FREQUENCE_COMPOSITION);
  const gauche = new Float32Array(echantillons);
  const droite = new Float32Array(echantillons);

  for (const evt of plan.notes) rendreNote(gauche, droite, evt);
  for (const evt of plan.percussions) rendrePercussion(gauche, droite, evt);

  // Normalisation crête + fondus globaux (anti-clic début/fin).
  let crete = 0;
  for (let i = 0; i < echantillons; i++) {
    const a = Math.abs(gauche[i] as number);
    const b = Math.abs(droite[i] as number);
    if (a > crete) crete = a;
    if (b > crete) crete = b;
  }
  const gain = crete > 1e-9 ? CIBLE_CRETE / crete : 0;
  const fadein = Math.round(0.08 * FREQUENCE_COMPOSITION);
  const fadeout = Math.round(Math.min(0.6, duree * 0.05) * FREQUENCE_COMPOSITION);
  const pcm = Buffer.alloc(echantillons * 2 * 2);
  let curseur = 0;
  for (let i = 0; i < echantillons; i++) {
    let env = 1;
    if (i < fadein) env = i / fadein;
    if (i >= echantillons - fadeout) env = Math.min(env, (echantillons - i) / fadeout);
    const l = Math.max(-1, Math.min(1, (gauche[i] as number) * gain * env));
    const r = Math.max(-1, Math.min(1, (droite[i] as number) * gain * env));
    pcm.writeInt16LE(Math.round(l * 32767), curseur);
    pcm.writeInt16LE(Math.round(r * 32767), curseur + 2);
    curseur += 4;
  }

  const structure = plan.sections.map((s) => {
    const debutSec = (s.debutMesure * plan.mesureSec);
    const dureeSec = s.nbMesures * plan.mesureSec;
    return { nom: s.nom, debutSec: Math.round(debutSec * 10) / 10, dureeSec: Math.round(dureeSec * 10) / 10 };
  });

  return {
    pcm,
    frequence: FREQUENCE_COMPOSITION,
    canaux: CANAUX_COMPOSITION,
    echantillons,
    dureeSecondes: Math.round((echantillons / FREQUENCE_COMPOSITION) * 1000) / 1000,
    seed,
    tempoBpm: params.style.tempoBpm,
    accords: plan.accords,
    structure,
    nbMesures: plan.nbMesures,
  };
}
