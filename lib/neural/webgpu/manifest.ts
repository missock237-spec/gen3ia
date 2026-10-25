"use client";

/**
 * MANIFESTE DES MODÈLES MÉDIA — lit le MANIFEST.json du repo Hugging Face
 * public `gen3ia-media-engine` (publié par le notebook Colab GPU) et résout
 * les URLs réelles des poids (SD photoréalisme, Kokoro voix). Les fichiers
 * sont téléchargés UNE FOIS par le navigateur puis servis depuis le cache
 * HTTP (HF envoie des en-têtes de cache longues) — la latence des
 * générations suivantes est purement GPU.
 */

export const REPO_MEDIA_GEN3IA = "Kings237/gen3ia-media-engine";
export const BASE_HF = `https://huggingface.co/${REPO_MEDIA_GEN3IA}/resolve/main`;

export interface ManifesteMédia {
  name?: string;
  version?: number;
  browser_inference?: {
    sd?: { dir?: string; steps?: number; dtype?: string };
    kokoro?: { dir?: string; voice_fr?: string; dtype?: string };
  };
  [k: string]: unknown;
}

let manifeste: ManifesteMédia | null = null;
let enCours: Promise<ManifesteMédia> | null = null;

/** Charge le manifeste (une fois, promesse partagée). */
export async function chargerManifeste(): Promise<ManifesteMédia> {
  if (manifeste) return manifeste;
  if (enCours) return enCours;
  enCours = (async () => {
    const r = await fetch(`${BASE_HF}/MANIFEST.json`, { cache: "force-cache" });
    if (!r.ok) throw new Error(`Manifeste indisponible (${r.status}) — repo ${REPO_MEDIA_GEN3IA}`);
    manifeste = (await r.json()) as ManifesteMédia;
    return manifeste;
  })();
  return enCours;
}

/** URL réelle d'un fichier du repo (path relatif). */
export function urlModèle(chemin: string): string {
  return `${BASE_HF}/${chemin.replace(/^\//, "")}`;
}

/** Répertoire SD effectif (défaut : sd-photoreal). */
export async function dirSd(): Promise<string> {
  try {
    const m = await chargerManifeste();
    return m.browser_inference?.sd?.dir ?? "sd-photoreal";
  } catch {
    return "sd-photoreal";
  }
}

/** Répertoire Kokoro effectif (défaut : kokoro). */
export async function dirKokoro(): Promise<string> {
  try {
    const m = await chargerManifeste();
    return m.browser_inference?.kokoro?.dir ?? "kokoro";
  } catch {
    return "kokoro";
  }
}
