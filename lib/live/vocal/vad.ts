/**
 * VAD — détection d'activité vocale réelle (mission LOT 4 : VAD, début/fin
 * de parole). Réutilise la mesure RÉELLE existante comprendreAudioWav
 * (lib/neural/multimodal — RMS, taux de passage à zéro) sur des segments
 * WAV PCM16 mono. HYSTÉRÉSIS : la parole démarre après un début continu
 * (anti-claquement) et ne se termine qu'après un silence continu (anti-
 * coupure micro) — déterministe et testable sur WAV synthétiques réels.
 */

import { comprendreAudioWav } from "@/lib/neural/multimodal/comprehension-multimodale";

export interface ConfigVad {
  /** RMS [0..1] au-delà duquel on considère la parole (démarrage). */
  seuilParole: number;
  /** RMS [0..1] en dessous duquel on considère le silence (arrêt). */
  seuilSilence: number;
  /** Durée minimale continue de parole pour un début (ms). */
  minParoleMs: number;
  /** Durée de silence continu pour une fin de tour (ms). */
  minSilenceMs: number;
  /** Durée d'un segment analysé (ms) — cadence du flux. */
  segmentMs: number;
}

export const CONFIG_VAD_DEFAUT: ConfigVad = {
  seuilParole: 0.04,
  seuilSilence: 0.02,
  minParoleMs: 180,
  minSilenceMs: 700,
  segmentMs: 120,
};

export type EvenementVad = "parole.debut" | "parole.encours" | "parole.fin";

/** État continu du VAD sur le flux de segments. */
export class Vad {
  private enParole = false;
  private dureeParoleMs = 0;
  private dureeSilenceMs = 0;

  constructor(private config: ConfigVad = CONFIG_VAD_DEFAUT) {}

  /** Traite un segment WAV PCM16 mono et retourne l'événement VAD (ou null). */
  traiter(wav: Buffer): { evenement: EvenementVad | null; rms: number; classe: string } {
    const a = comprendreAudioWav(wav);
    const rms = a.rms;
    const maintenantEnParole = rms >= this.config.seuilParole;
    if (maintenantEnParole) {
      this.dureeSilenceMs = 0;
      this.dureeParoleMs += this.config.segmentMs;
      if (!this.enParole && this.dureeParoleMs >= this.config.minParoleMs) {
        this.enParole = true;
        return { evenement: "parole.debut", rms, classe: a.classe };
      }
      return { evenement: this.enParole ? "parole.encours" : null, rms, classe: a.classe };
    }
    this.dureeParoleMs = 0;
    if (this.enParole) {
      this.dureeSilenceMs += this.config.segmentMs;
      if (this.dureeSilenceMs >= this.config.minSilenceMs) {
        this.enParole = false;
        this.dureeSilenceMs = 0;
        return { evenement: "parole.fin", rms, classe: a.classe };
      }
      return { evenement: "parole.encours", rms, classe: a.classe };
    }
    return { evenement: null, rms, classe: a.classe };
  }

  /** true si un tour de parole est en cours (dashboard). */
  actif(): boolean {
    return this.enParole;
  }

  reinitialiser(): void {
    this.enParole = false;
    this.dureeParoleMs = 0;
    this.dureeSilenceMs = 0;
  }
}

/** Génère un WAV PCM16 mono synthétique RÉEL (silence ou tonal) pour tests. */
export function wavSynthetique(ms: number, amplitude: number, sampleRate = 16_000): Buffer {
  const echantillons = Math.floor((ms / 1000) * sampleRate);
  const taille = 44 + echantillons * 2;
  const buf = Buffer.alloc(taille);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(taille - 8, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(echantillons * 2, 40);
  for (let i = 0; i < echantillons; i++) {
    // Sinusoïde 220 Hz (voisé) : amplitude 0 = silence numérique.
    const v = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 220 * i) / sampleRate));
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}
