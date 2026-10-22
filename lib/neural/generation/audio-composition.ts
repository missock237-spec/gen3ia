/**
 * MOTEUR AUDIO SCÉNIQUE v2 — design sonore LOCALE et RÉEL, sans IA
 * externe, sans GPU.
 *
 * Évolution du moteur v1 (nappe pentatonique) : le son RÉPOND AU
 * PROMPT. L'analyseur sémantique (scene-spec.ts) fournit la scène et
 * ce moteur compose en CALQUES :
 *
 *  - SFX sémantiques : pluie, vagues, vent, orage, feu, ruisseau,
 *    horloge, cloche, foule, pas, neige — synthétisés par calcul
 *    (bruits filtrés, événements, enveloppes) ;
 *  - AMBIANCE DE CADRE : chaque environnement a son fond sonore
 *    (océan → vagues, forêt → oiseaux, ville → rumeur, montagne →
 *    vent, désert → vent chaud, lac → clapotis) ;
 *  - MUSIQUE structurée : tempo et mode (majeur/mineur) dérivés de
 *    l'ambiance du prompt, motif à 4 phrases issu des synapses
 *    APPRISES (un cerveau différent joue une partition différente).
 *
 * Sortie : Buffer WAV PCM 16 bits mono — un vrai fichier audio.
 * HONNÊTETÉ : ce n'est PAS de la voix chantée ni une voix naturelle
 * (cf. docs/multimodal/gen3-multimodal.md — écart documenté avec les
 * références type ElevenLabs ; la lecture vocale du chat passe par la
 * voix du navigateur, Web Speech API).
 *
 * Dépendances : Node Buffer uniquement (contexte serveur).
 */

import { type NeuralSnapshot, rngDepuisSnapshot, hashTexte32 } from "./snapshot";
import type { SceneSpec } from "./scene-spec";

export interface RenduAudioScene {
  wav: Buffer;
  sampleRate: number;
  dureeSecondes: number;
  /** Traçabilité honnête : couches réellement mixées. */
  meta: {
    couches: string[];
    tempoBpm: number;
    mode: "majeur" | "mineur";
    fondamentale: number;
    ambiance: string;
    /** Amplitude moyenne réelle du mixage (diagnostic honnête). */
    amplitudeMoyenne: number;
  };
}

const BPM_AMBIANCE: Record<string, number> = {
  calme: 72,
  melancolique: 76,
  joyeux: 120,
  epique: 96,
  mysterieux: 84,
};

/** Degrés de gamme (ratios de fréquence) majeur / mineur naturel. */
const GAMME_MAJEUR = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2];
const GAMME_MINEUR = [1, 9 / 8, 6 / 5, 3 / 2, 8 / 5, 2];

const FONDAMENTALES = [130.81, 146.83, 164.81, 174.61, 196];

/** La scène appelle-t-elle le moteur v2 (sonore) ? */
export function sceneSonore(scene: SceneSpec): boolean {
  return scene.sons.length > 0 || scene.meteo.length > 0 || scene.cadre !== null;
}

/* ------------------------------------------------------------------ */
/* Outils de synthèse                                                   */
/* ------------------------------------------------------------------ */

/** Filtre passe-bas one-pole (lissage). */
function passeBas(etat: { y: number }, x: number, alpha: number): number {
  etat.y += alpha * (x - etat.y);
  return etat.y;
}

/** Bruit blanc depuis un RNG (déterministe). */
function bruit(rng: () => number): number {
  return rng() * 2 - 1;
}

/** Enveloppe trapezoïdale sur un événement local (0..1). */
function enveloppeLocale(local: number, attaque = 0.15, relache = 0.5): number {
  if (local < 0 || local > 1) return 0;
  if (local < attaque) return local / attaque;
  if (local > 1 - relache) return (1 - local) / relache;
  return 1;
}

/* ------------------------------------------------------------------ */
/* Couches SFX — chaque fabrique renvoie (t) => échantillon (stateful)  */
/* ------------------------------------------------------------------ */

/** Un échantillonneur : temps → contribution à l'échantillon. */
type Echantillonneur = (t: number) => number;

/** Une fabrique de couche : instancie un échantillonneur (avec son état). */
type FabriqueCouche = () => Echantillonneur;

/** Pluie : bruit filtré + fines gouttes. */
function couchePluie(rng: () => number): Echantillonneur {
  const etatF = { y: 0 };
  const gouttes = Array.from({ length: 6 }, () => ({ debut: rng() * 3, duree: 0.05 + rng() * 0.04, gain: 0.3 + rng() * 0.5 }));
  return (t) => {
    const base = passeBas(etatF, bruit(rng), 0.22) * 0.5;
    let goutte = 0;
    for (const g of gouttes) {
      const local = ((t + g.debut) % 0.9) / g.duree;
      if (local >= 0 && local <= 1) {
        goutte += enveloppeLocale(local, 0.4, 0.6) * Math.sin(2 * Math.PI * 1400 * t) * g.gain * 0.1;
      }
    }
    return base + goutte;
  };
}

/** Vagues : nappes de bruit qui montent et retombent (période ~6 s). */
function coucheVagues(rng: () => number): Echantillonneur {
  const etatF = { y: 0 };
  const dephasage = rng() * 6;
  return (t) => {
    const houle = 0.5 + 0.5 * Math.sin(2 * Math.PI * ((t + dephasage) / 6));
    const ressac = 0.5 + 0.5 * Math.sin(2 * Math.PI * ((t + dephasage) / 6 - 0.25));
    return passeBas(etatF, bruit(rng), 0.1) * (houle * 0.7 + ressac * 0.3) * 1.1;
  };
}

/** Vent : bruit modulé lentement (rafales). */
function coucheVent(rng: () => number): Echantillonneur {
  const etatF1 = { y: 0 };
  const etatF2 = { y: 0 };
  const phi = rng() * 6.28;
  return (t) => {
    const rafale = 0.45 + 0.35 * Math.sin(2 * Math.PI * 0.07 * t + phi) + 0.2 * Math.sin(2 * Math.PI * 0.19 * t + phi * 2);
    return passeBas(etatF2, passeBas(etatF1, bruit(rng), 0.08) * Math.max(0, rafale), 0.3) * 1.4;
  };
}

/** Orage : grondements graves + coup de tonnerre périodique. */
function coucheOrage(rng: () => number): Echantillonneur {
  const etatGr = { y: 0 };
  const period = 9 + rng() * 4;
  const coupure = rng() * period * 0.6;
  return (t) => {
    const local = (t - coupure) % period;
    let tonnerre = 0;
    if (local >= 0 && local < 2.2) {
      const env = enveloppeLocale(local / 2.2, 0.06, 0.85);
      tonnerre = passeBas(etatGr, bruit(rng), 0.035) * env * 2.4;
    }
    const grondement = passeBas(etatGr, bruit(rng), 0.02) * 0.5;
    return grondement + tonnerre;
  };
}

/** Feu : crépitements aléatoires + rumeur basse. */
function coucheFeu(rng: () => number): Echantillonneur {
  const etatF = { y: 0 };
  const crepitements = Array.from({ length: 14 }, () => ({
    periode: 0.35 + rng() * 1.4,
    phase: rng() * 2,
    gain: 0.25 + rng() * 0.7,
    freq: 900 + rng() * 1800,
  }));
  return (t) => {
    const rumeur = passeBas(etatF, bruit(rng), 0.05) * 0.45;
    let crepi = 0;
    for (const c of crepitements) {
      const local = ((t + c.phase) % c.periode) / 0.018;
      if (local >= 0 && local <= 1) {
        crepi += enveloppeLocale(local, 0.9, 0.1) * Math.sin(2 * Math.PI * c.freq * t) * c.gain * 0.24;
      }
    }
    return rumeur + crepi;
  };
}

/** Ruisseau : babillage aigu modulé. */
function coucheRuisseau(rng: () => number): Echantillonneur {
  const etatF = { y: 0 };
  const phi = rng() * 6.28;
  return (t) => {
    const modulation = 0.6 + 0.4 * Math.sin(2 * Math.PI * 2.3 * t + phi) * Math.sin(2 * Math.PI * 0.7 * t);
    return passeBas(etatF, bruit(rng), 0.4) * modulation * 0.42;
  };
}

/** Horloge : tic-tac chaque seconde (clic bref). */
function coucheHorloge(rng: () => number): Echantillonneur {
  const souffle = { y: 0 };
  return (t) => {
    const seconde = Math.floor(t);
    const local = t - seconde;
    const tic = seconde % 2 === 0;
    const freq = tic ? 1150 : 940;
    if (local < 0.035) {
      const env = enveloppeLocale(local / 0.035, 0.7, 0.3);
      return Math.sin(2 * Math.PI * freq * t) * env * 0.5 + passeBas(souffle, bruit(rng), 0.5) * 0.03;
    }
    return 0;
  };
}

/** Cloche : frappes espacées, partiels inharmoniques. */
function coucheCloche(rng: () => number): Echantillonneur {
  const periode = 3.2 + rng() * 1.6;
  const base = 220 * Math.pow(2, Math.floor(rng() * 5) / 12);
  const partiels = [1, 2.74, 5.4, 8.9];
  return (t) => {
    const local = t % periode;
    if (local > 2.6) return 0;
    const env = Math.exp(-local * 2.2);
    let frappe = 0;
    partiels.forEach((p, i) => {
      frappe += Math.sin(2 * Math.PI * base * p * t) * (0.5 / (i + 1));
    });
    return frappe * env * 0.55;
  };
}

/** Foule : rumeur médiane qui ondule (brouhaha). */
function coucheFoule(rng: () => number): Echantillonneur {
  const etatF = { y: 0 };
  const phi = rng() * 6.28;
  return (t) => {
    const ondulation = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.13 * t + phi) * Math.sin(2 * Math.PI * 0.31 * t);
    return passeBas(etatF, bruit(rng), 0.16) * (0.35 + ondulation * 0.5);
  };
}

/** Pas : frappes graves au tempo de la musique. */
function couchePas(bpm: number): Echantillonneur {
  const pasParSeconde = Math.max(0.6, bpm / 60 / 2);
  const periode = 1 / pasParSeconde;
  return (t) => {
    const local = t % periode;
    if (local > 0.09) return 0;
    const env = enveloppeLocale(local / 0.09, 0.12, 0.7);
    return Math.sin(2 * Math.PI * 82 * t) * env * 0.5;
  };
}

/** Oiseaux : gazouillis courts aigus, espacés. */
function coucheOiseaux(rng: () => number): Echantillonneur {
  const gazouillis = Array.from({ length: 5 }, () => ({
    periode: 2.6 + rng() * 3.4,
    phase: rng() * 4,
    freqA: 1900 + rng() * 1400,
    freqB: 2600 + rng() * 1600,
    duree: 0.16 + rng() * 0.2,
  }));
  return (t) => {
    let chanson = 0;
    for (const g of gazouillis) {
      const local = ((t + g.phase) % g.periode);
      if (local < g.duree) {
        const env = enveloppeLocale(local / g.duree, 0.25, 0.35);
        const glissando = g.freqA + (g.freqB - g.freqA) * (local / g.duree);
        chanson += Math.sin(2 * Math.PI * glissando * t) * env * 0.22;
      }
    }
    return chanson;
  };
}

/** Clapotis (lac) : petites vagues douces rapides. */
function coucheClapotis(rng: () => number): Echantillonneur {
  const etatF = { y: 0 };
  const phi = rng() * 6.28;
  return (t) => {
    const houle = 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.7 * t + phi);
    return passeBas(etatF, bruit(rng), 0.09) * houle * 0.5;
  };
}

/* ------------------------------------------------------------------ */
/* Composition                                                          */
/* ------------------------------------------------------------------ */

/**
 * Compose le morceau scénique. DÉTERMINISTE : même (prompt, scène,
 * état du réseau) → même fichier WAV bit-à-bit.
 */
export function genererAudioScene(
  prompt: string,
  dureeSecondes: number,
  sampleRate: number,
  snapshot: NeuralSnapshot,
  scene: SceneSpec,
): RenduAudioScene {
  const duree = Math.min(30, Math.max(1, Math.round(dureeSecondes * 100) / 100));
  const rate = Math.min(48000, Math.max(8000, Math.round(sampleRate)));
  const rng = rngDepuisSnapshot(snapshot, 5);

  const bpm = BPM_AMBIANCE[scene.ambiance] ?? 72;
  const mode: "majeur" | "mineur" =
    scene.ambiance === "joyeux" || scene.ambiance === "epique" ? "majeur" : "mineur";
  const fondamentale = FONDAMENTALES[Math.abs(hashTexte32(prompt)) % FONDAMENTALES.length]!;
  const gamme = mode === "majeur" ? GAMME_MAJEUR : GAMME_MINEUR;

  // Couches SFX : sons explicites + ambiance du cadre.
  const fabriques: Array<{ nom: string; gain: number; fabrique: FabriqueCouche }> = [];
  const ajouterSfx = (nom: string, gain: number, fabrique: FabriqueCouche) =>
    fabriques.push({ nom, gain, fabrique });

  if (scene.sons.includes("pluie") || scene.meteo.includes("pluie")) ajouterSfx("pluie", 0.5, () => couchePluie(rng));
  if (scene.sons.includes("vagues") || scene.cadre === "ocean") ajouterSfx("vagues", 0.55, () => coucheVagues(rng));
  if (scene.sons.includes("vent") || scene.cadre === "montagne" || scene.cadre === "desert") ajouterSfx("vent", 0.4, () => coucheVent(rng));
  if (scene.meteo.includes("orage")) ajouterSfx("orage", 0.6, () => coucheOrage(rng));
  if (scene.sons.includes("feu")) ajouterSfx("feu", 0.5, () => coucheFeu(rng));
  if (scene.sons.includes("ruisseau") || scene.cadre === "lac") ajouterSfx("ruisseau", 0.35, () => coucheRuisseau(rng));
  if (scene.sons.includes("horloge")) ajouterSfx("horloge", 0.4, () => coucheHorloge(rng));
  if (scene.sons.includes("cloche")) ajouterSfx("cloche", 0.45, () => coucheCloche(rng));
  if (scene.sons.includes("foule") || scene.cadre === "ville") ajouterSfx("foule", 0.3, () => coucheFoule(rng));
  if (scene.sons.includes("pas")) ajouterSfx("pas", 0.35, () => couchePas(bpm));
  if (scene.cadre === "foret" || scene.sujet?.type === "oiseau") ajouterSfx("oiseaux", 0.4, () => coucheOiseaux(rng));
  if (scene.cadre === "lac") ajouterSfx("clapotis", 0.3, () => coucheClapotis(rng));
  if (scene.meteo.includes("neige") || scene.meteo.includes("brouillard")) ajouterSfx("brume", 0.22, () => coucheVent(rng));
  if (fabriques.length === 0) {
    // Aucun son identifié mais cadre reconnu : vent doux par défaut.
    ajouterSfx("souffle", 0.25, () => coucheVent(rng));
  }

  // Motif musical : 4 phrases × 4 croches — degrés tirés des synapses APPRISES.
  const degres: number[] = [];
  for (let i = 0; i < 16; i++) {
    const synapse = snapshot.echantillonSynapses[
      Math.floor(i * snapshot.echantillonSynapses.length / 16)
    ];
    const poids = synapse?.[2] ?? 0.4;
    // Synapses fortes → degrés stables (tonique/dominante), faibles → degrés passants.
    const degre = poids > 0.6 ? [0, 3][i % 2]! : Math.floor(poids * 4.999) % gamme.length;
    degres.push(degre);
  }

  const beat = 60 / bpm;
  const croche = beat / 2;

  // Période de mélodie : une croche par note, mélodie active hors silences.
  const melodie = (t: number): number => {
    const index = Math.floor(t / croche);
    const local = (t % croche) / croche;
    const degre = degres[index % degres.length]!;
    const freq = fondamentale * 2 * gamme[degre]!;
    // Respiration de la phrase : 3 croches jouées, 1 silence.
    if (index % 4 === 3) return 0;
    const env = enveloppeLocale(local, 0.2, 0.4);
    return Math.sin(2 * Math.PI * freq * t) * env * 0.16;
  };

  // Drone : fondamentale + quinte, respiration lente.
  const drone = (t: number): number => {
    const pulsation = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.06 * t);
    return (
      (Math.sin(2 * Math.PI * fondamentale * t) * 0.5 +
        Math.sin(2 * Math.PI * fondamentale * 1.5 * t) * 0.22) *
      pulsation *
      0.3
    );
  };

  // Mixage échantillon par échantillon.
  const nbEchantillons = Math.floor(duree * rate);
  const donnees = Buffer.alloc(nbEchantillons * 2);
  const couchesActives = fabriques.map(({ fabrique, gain, nom }) => ({ nom, gain, fn: fabrique() }));
  let sommeAbs = 0;

  for (let n = 0; n < nbEchantillons; n++) {
    const t = n / rate;
    let echantillon = drone(t) + melodie(t);
    for (const couche of couchesActives) {
      echantillon += couche.fn(t) * couche.gain;
    }
    const borne = echantillon > 0.72 ? 0.72 : echantillon < -0.72 ? -0.72 : echantillon;
    sommeAbs += Math.abs(borne);
    donnees.writeInt16LE(Math.round(borne * 32767), n * 2);
  }
  const amplitudeMoyenne = nbEchantillons > 0 ? Number((sommeAbs / nbEchantillons).toFixed(4)) : 0;

  // En-tête WAV (identique au v1 — PCM 16 bits mono).
  const tailleDonnees = nbEchantillons * 2;
  const entete = Buffer.alloc(44);
  entete.write("RIFF", 0, "ascii");
  entete.writeUInt32LE(36 + tailleDonnees, 4);
  entete.write("WAVE", 8, "ascii");
  entete.write("fmt ", 12, "ascii");
  entete.writeUInt32LE(16, 16);
  entete.writeUInt16LE(1, 20);
  entete.writeUInt16LE(1, 22);
  entete.writeUInt32LE(rate, 24);
  entete.writeUInt32LE(rate * 2, 28);
  entete.writeUInt16LE(2, 32);
  entete.writeUInt16LE(16, 34);
  entete.write("data", 36, "ascii");
  entete.writeUInt32LE(tailleDonnees, 40);

  return {
    wav: Buffer.concat([entete, donnees]),
    sampleRate: rate,
    dureeSecondes: duree,
    meta: {
      couches: couchesActives.map((c) => c.nom),
      tempoBpm: bpm,
      mode,
      fondamentale: Number(fondamentale.toFixed(2)),
      ambiance: scene.ambiance,
      amplitudeMoyenne,
    },
  };
}

/** Data URI (WAV) prête à persister ou lire. */
export function audioSceneVersDataUri(wav: Buffer): string {
  return `data:audio/wav;base64,${wav.toString("base64")}`;
}
