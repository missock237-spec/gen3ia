/**
 * MOTEUR AUDIO NEURONAL — synthèse LOCALE et RÉELLE.
 *
 * Remplace l'ancienne synthèse vocale IA externe (ElevenLabs, supprimée
 * du projet). Ici, le son est SYNTHÉTISÉ PAR CALCUL à partir de l'état
 * réel du réseau neuronal Gen3 :
 *
 *  - la fondamentale et la gamme sont dérivées du hash du prompt
 *    (gamme pentatonique — consonance garantie) ;
 *  - les partiels harmoniques ont des amplitudes tirées de
 *    l'HISTOGRAMME RÉEL des poids synaptiques appris ;
 *  - la structure temporelle (segments, enveloppes) découle des poids
 *    de l'échantillon de synapses — un cerveau plus entraîné (poids
 *    renforcés) produit une texture sonore plus dense.
 *
 * Sortie : Buffer WAV PCM 16 bits MONO — un vrai fichier audio,
 * lisible par tout lecteur. Aucune voix synthétique : ce signal est
 * l'expression sonore de l'état neuronal, honnêtement étiqueté comme
 * tel.
 *
 * Dépendances : Node Buffer uniquement (contexte serveur).
 */

import {
  type NeuralSnapshot,
  rngDepuisSnapshot,
  hashTexte32,
} from "./snapshot";

/** Gamme pentatonique mineure (ratios de fréquence) — consonance naturelle. */
const GAMME_PENTATONIQUE = [1, 1.125, 1.25, 1.5, 1.6667, 2, 2.25, 2.5];

/** Fréquences de base candidates (La grave → Mi aigu). */
const FONDAMENTALES = [110, 123.47, 130.81, 146.83, 164.81];

export interface RenduAudioNeural {
  /** Buffer WAV complet (en-tête RIFF + échantillons PCM 16 bits). */
  wav: Buffer;
  sampleRate: number;
  dureeSecondes: number;
  /** Métadonnées réelles de synthèse (traçabilité honnête). */
  meta: {
    fondamentale: number;
    nbPartiels: number;
    amplitudeMoyenne: number;
  };
}

/** Construit un segment temporel (début, fin, intensité, note). */
interface Segment {
  debutS: number;
  dureeS: number;
  intensite: number;
  note: number;
}

/** Écrit l'en-tête WAV RIFF (PCM 16 bits mono). */
function construireEnTeteWav(
  nbEchantillons: number,
  sampleRate: number,
): Buffer {
  const tailleDonnees = nbEchantillons * 2;
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + tailleDonnees, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // taille du bloc fmt
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // débit octets
  buffer.writeUInt16LE(2, 32); // alignement bloc
  buffer.writeUInt16LE(16, 34); // bits par échantillon
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(tailleDonnees, 40);
  return buffer;
}

/**
 * Synthétise un signal audio neural. Déterministe : le même (prompt,
 * état du réseau) produit exactement le même fichier.
 */
export function genererAudioNeural(
  prompt: string,
  dureeSecondes: number,
  sampleRate: number,
  snapshot: NeuralSnapshot,
): RenduAudioNeural {
  const duree = Math.min(30, Math.max(1, Math.round(dureeSecondes * 100) / 100));
  const rate = Math.min(48000, Math.max(8000, Math.round(sampleRate)));
  const rng = rngDepuisSnapshot(snapshot, 2);

  // Fondamentale : hash du prompt → degré de la gamme.
  const degre = Math.abs(hashTexte32(prompt)) % FONDAMENTALES.length;
  const fondamentale = FONDAMENTALES[degre]!;

  // Partiels harmoniques : amplitude depuis l'histogramme réel des poids
  // (classe i → partiel i, normalisé par le maximum de l'histogramme).
  const maxHisto = Math.max(1, ...snapshot.histogramme);
  const partiels = GAMME_PENTATONIQUE.map((ratio, i) => {
    const classe = Math.min(9, i);
    const amplitude = (snapshot.histogramme[classe] ?? 0) / maxHisto;
    return { ratio, amplitude };
  }).filter((p) => p.amplitude > 0.02);

  // Segments temporels : découpage depuis les poids de l'échantillon
  // de synapses (structure réelle du cerveau → structure du morceau).
  const nbSegments = Math.max(3, Math.min(12, Math.round(duree)));
  const segments: Segment[] = [];
  let curseur = 0;
  for (let i = 0; i < nbSegments && curseur < duree; i++) {
    const synapse = snapshot.echantillonSynapses[
      Math.floor(i * snapshot.echantillonSynapses.length / nbSegments)
    ];
    const poids = synapse?.[2] ?? 0.3;
    const note = Math.abs(synapse?.[0] ?? i) % GAMME_PENTATONIQUE.length;
    const dureeSegment = Math.max(0.35, (duree / nbSegments) * (0.75 + poids * 0.6));
    const fin = Math.min(duree, curseur + dureeSegment);
    segments.push({
      debutS: curseur,
      dureeS: fin - curseur,
      intensite: 0.3 + poids * 0.65,
      note,
    });
    curseur = fin;
  }

  // Synthèse additive par échantillon avec enveloppes ADSR simplifiées.
  const nbEchantillons = Math.floor(duree * rate);
  const donnees = Buffer.alloc(nbEchantillons * 2);
  let sommeAbs = 0;

  // Curseur monotone sur les segments (audit perf O(n²)→O(n)) : les
  // segments sont triés par debutS — l'ancien `segments.find` rescannait
  // la liste pour CHAQUE échantillon (jusqu'à 1,44 M × 12 comparaisons à
  // 30 s / 48 kHz). Le curseur avance une seule fois au total.
  let indexSegment = 0;

  for (let n = 0; n < nbEchantillons; n++) {
    const t = n / rate;
    let echantillon = 0;

    // Drone de fond : fondamentale + premier partiel, amplitude douce.
    const pulsationLente = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.08 * t);
    echantillon +=
      0.22 * pulsationLente * Math.sin(2 * Math.PI * fondamentale * t);

    // Segments : arpège des partiels de la gamme selon la note du segment
    // (curseur monotone — voir commentaire au-dessus de la boucle).
    while (
      indexSegment < segments.length &&
      t >= segments[indexSegment]!.debutS + segments[indexSegment]!.dureeS
    ) {
      indexSegment++;
    }
    const courant = segments[indexSegment];
    const segment = courant && t >= courant.debutS ? courant : undefined;
    if (segment) {
      // Enveloppe attaque/relâche (30 % du segment de chaque côté).
      const local = (t - segment.debutS) / Math.max(0.001, segment.dureeS);
      const enveloppe =
        local < 0.3
          ? local / 0.3
          : local > 0.7
            ? (1 - local) / 0.3
            : 1;
      const frequenceNote = GAMME_PENTATONIQUE[segment.note % GAMME_PENTATONIQUE.length]! * fondamentale;
      for (const partiel of partiels) {
        echantillon +=
          segment.intensite *
          enveloppe *
          partiel.amplitude *
          0.16 *
          Math.sin(2 * Math.PI * frequenceNote * partiel.ratio * t);
      }
      // Souffle neuronal : bruit filtré simple (haute fréquence amortie).
      const souffle = (rng() * 2 - 1) * 0.015 * enveloppe * segment.intensite;
      echantillon += souffle;
    }

    // Normalisation douce (limiteur -3 dB).
    const borne = echantillon > 0.707 ? 0.707 : echantillon < -0.707 ? -0.707 : echantillon;
    sommeAbs += Math.abs(borne);
    donnees.writeInt16LE(Math.round(borne * 32767), n * 2);
  }

  const amplitudeMoyenne = nbEchantillons > 0 ? sommeAbs / nbEchantillons : 0;
  const wav = Buffer.concat([construireEnTeteWav(nbEchantillons, rate), donnees]);

  return {
    wav,
    sampleRate: rate,
    dureeSecondes: duree,
    meta: {
      fondamentale,
      nbPartiels: partiels.length,
      amplitudeMoyenne,
    },
  };
}

/** Construit une data URI (WAV) prête à persister ou lire. */
export function audioVersDataUri(wav: Buffer): string {
  return `data:audio/wav;base64,${wav.toString("base64")}`;
}
