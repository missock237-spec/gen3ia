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
 * Le miroir du modèle vit dans le repo public gen3ia-media-engine (Colab),
 * mais kokoro-js attend la mise en page à plat (model.onnx + voices.json à
 * la racine du repo) : on charge donc le repo de référence
 * onnx-community/Kokoro-82M-v1.0-ONNX (identique octet pour octet au miroir).
 *
 * Repli honnête : toute erreur propage — l'appelant retombe sur la synthèse
 * Web Speech (navigateur) puis sur le WAV neuronal serveur.
 */

export interface OptionsVoixHumaine {
  texte: string;
  /** Voix Kokoro (défaut ff_siwis — française féminine naturelle). */
  voix?: string;
  /** Vitesse de parole 0.7–1.4 (défaut 1.0). */
  vitesse?: number;
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
 * Synthèse vocale HUMAINE locale. Rejette les textes vides ; la limite
 * pratique navigateur est ~2000 caractères (mémoire WASM).
 */
export async function générerVoixHumaine(opts: OptionsVoixHumaine): Promise<RésultatVoixHumaine> {
  const début = Date.now();
  const texte = opts.texte.trim().slice(0, 2000);
  if (!texte) throw new Error("Texte vide — rien à vocaliser.");

  const { tts, moteur } = await chargerKokoro(opts.onProgress);
  opts.onProgress?.({ étape: "Votre GPU prononce la phrase…", pourcent: 50 });
  const voix = opts.voix ?? "ff_siwis";
  const vitesse = Math.min(Math.max(opts.vitesse ?? 1.0, 0.7), 1.4);
  const audio = await tts.generate(texte, { voice: voix, speed: vitesse });
  const blob = await audio.toBlob();
  opts.onProgress?.({ étape: "Voix prête.", pourcent: 100 });
  return {
    blob,
    duréeSecondes: audio.audio?.duration ?? 0,
    voix,
    moteur,
    duréeMs: Date.now() - début,
  };
}
