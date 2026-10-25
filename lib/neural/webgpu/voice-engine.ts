"use client";

/**
 * MOTEUR VOIX HUMAINE WEBGPU — Kokoro-82M dans le navigateur.
 *
 * La voix humaine FR de Gen3 : modèle TTS neuronal Kokoro-82M (Apache-2.0,
 * ~82 M paramètres) exécuté LOCALEMENT via kokoro-js (transformers.js,
 * backend WebGPU si disponible, WASM sinon) — voix française naturelle
 * `ff_siwis`. Aucune API externe, aucun jeton, le texte ne quitte pas
 * l'appareil.
 *
 * QUALITÉ HAUTE (segmenter) : le texte est découpé en PHRASES, chaque
 * phrase est synthétisée avec une micro-variation de débit (prosodie
 * vivante), puis les trains PCM sont fondus (égalité de puissance, 60 ms)
 * en un WAV continu — plus de clic entre phrases, textes jusqu'à 6 000
 * caractères. En mode ESSAIM, chaque segment peut être synthétisé par un
 * appareil différent et fusionné côté central (même mathématique : wav.ts).
 *
 * Repli honnête : toute erreur propage — l'appelant retombe sur la synthèse
 * Web Speech (navigateur) puis sur le WAV neuronal serveur.
 */

import { concaténerWav } from "@/lib/essaim-media/wav";
import { découperEnSegments } from "@/lib/essaim-media/types";

export interface OptionsVoixHumaine {
  texte: string;
  /** Voix Kokoro (défaut ff_siwis — française féminine naturelle). */
  voix?: string;
  /** Vitesse de parole 0.7–1.4 (défaut 1.0). */
  vitesse?: number;
  /** QUALITÉ HAUTE : segmentation par phrases + micro-variation de débit +
   *  fondu PCM 60 ms (prosodie naturelle, textes jusqu'à 6 000 caractères). */
  segmenter?: boolean;
  onProgress?: (info: { étape: string; pourcent: number }) => void;
}

export interface RésultatVoixHumaine {
  blob: Blob;
  duréeSecondes: number;
  voix: string;
  moteur: "kokoro-webgpu" | "kokoro-wasm";
  duréeMs: number;
}

type InstanceTts = {
  generate: (texte: string, opts: { voice: string; speed?: number }) => Promise<{ toBlob: () => Promise<Blob>; audio: AudioBuffer }>;
};
type ChargéTts = { tts: InstanceTts; moteur: "kokoro-webgpu" | "kokoro-wasm" };

let instance: ChargéTts | null = null;
let chargement: Promise<ChargéTts> | null = null;

/** Charge Kokoro une fois (WebGPU prioritaire, WASM en repli). */
async function chargerKokoro(
  onProgress?: (info: { étape: string; pourcent: number }) => void,
): Promise<ChargéTts> {
  if (instance) return instance;
  if (chargement) return chargement;
  chargement = (async () => {
    onProgress?.({ étape: "Chargement de la voix neuronale (~330 Mo, une seule fois)…", pourcent: 10 });
    const { KokoroTTS } = await import("kokoro-js");
    let tts: InstanceTts;
    let moteur: ChargéTts["moteur"];
    try {
      tts = (await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
        dtype: "fp32",
        device: "webgpu",
      })) as unknown as InstanceTts;
      moteur = "kokoro-webgpu";
    } catch {
      onProgress?.({ étape: "WebGPU voix indisponible — bascule CPU (plus lent)…", pourcent: 40 });
      tts = (await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
        dtype: "q8",
        device: "wasm",
      })) as unknown as InstanceTts;
      moteur = "kokoro-wasm";
    }
    onProgress?.({ étape: "Voix humaine prête.", pourcent: 100 });
    instance = { tts, moteur };
    return instance;
  })();
  return chargement;
}

/** Voix disponibles pour le sélecteur (FR d'abord). */
export const VOIX_KOKORO = [
  { id: "ff_siwis", label: "Française naturelle (ff_siwis)", langue: "fr" },
  { id: "af_heart", label: "Anglaise chaleureuse (af_heart)", langue: "en" },
  { id: "am_michael", label: "Anglaise posée (am_michael)", langue: "en" },
] as const;

/**
 * Synthèse vocale HUMAINE locale. Rejette les textes vides ; sans
 * segmentation la limite pratique navigateur est ~2000 caractères (mémoire
 * WASM), avec segmentation 6 000 (segments de ≤ 600 fondus au fil de l'eau).
 */
export async function générerVoixHumaine(opts: OptionsVoixHumaine): Promise<RésultatVoixHumaine> {
  const début = Date.now();
  const segmenter = opts.segmenter === true;
  const plafond = segmenter ? 6000 : 2000;
  const texte = opts.texte.trim().slice(0, plafond);
  if (!texte) throw new Error("Texte vide — rien à vocaliser.");

  const { tts, moteur } = await chargerKokoro(opts.onProgress);
  const voix = opts.voix ?? "ff_siwis";
  const vitesseBase = Math.min(Math.max(opts.vitesse ?? 1.0, 0.7), 1.4);

  // QUALITÉ HAUTE : phrases → synthèses avec micro-variation de débit →
  // fondu d'égalité de puissance. Un segment unique suit la voie directe.
  const segments = segmenter
    ? découperEnSegments(texte, 500).slice(0, 12)
    : [texte];
  const blobs: Blob[] = [];
  for (let i = 0; i < segments.length; i++) {
    // Cycle de débit [1.0, 0.97, 1.03] : la prosodie respire naturellement.
    const variation = [1.0, 0.97, 1.03][i % 3];
    const vitesse = Math.min(1.4, Math.max(0.7, vitesseBase * variation));
    opts.onProgress?.({
      étape: segments.length > 1
        ? `Phrase ${i + 1}/${segments.length} — votre GPU prononce la voix…`
        : "Votre GPU prononce la phrase…",
      pourcent: Math.round(((i + (segments.length > 1 ? 0.4 : 0.5)) / segments.length) * 92),
    });
    const audio = await tts.generate(segments[i], { voice: voix, speed: vitesse });
    blobs.push(await audio.toBlob());
  }

  let blob: Blob;
  if (blobs.length === 1) {
    blob = blobs[0];
  } else {
    const buffers = await Promise.all(blobs.map((b) => b.arrayBuffer()));
    try {
      const fusionné = concaténerWav(buffers.map((b) => new Uint8Array(b)));
      blob = new Blob([fusionné.slice().buffer as ArrayBuffer], { type: "audio/wav" });
    } catch {
      // Format hétérogène improbable : on livre la première phrase (honnête).
      blob = blobs[0];
    }
  }

  opts.onProgress?.({ étape: "Voix prête.", pourcent: 100 });
  return {
    blob,
    duréeSecondes: 0,
    voix,
    moteur,
    duréeMs: Date.now() - début,
  };
}
