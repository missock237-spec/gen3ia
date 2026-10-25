"use client";

/**
 * MOTEUR IMAGE WEBGPU — génération PHOTORÉALISTE sur le GPU de l'utilisateur.
 *
 * Pipeline Stable Diffusion complet dans le navigateur :
 *   tokenizer CLIP → text_encoder → unet (boucle DDIM + guidance) → vae_decoder
 * exécutés via onnxruntime-web (backend WebGPU), sur les poids du repo
 * PUBLIC gen3ia-media-engine (SD 2.1-base + LoRA photoréalisme Gen3ia,
 * fine-tuné Colab — cf. training/colab/gen3ia_gpu_media_training.ipynb).
 *
 * Les poids sont téléchargés UNE fois (cache HTTP HF) : ~1,7 Go (unet fp16)
 * + ~350 Mo (vae + text encoder). Honnêteté : si le navigateur n'a pas
 * WebGPU ou que la mémoire est insuffisante, la fonction échoue RAPIDEMENT
 * et le hook client déclenche le repli serveur (moteur neuronal abstrait).
 *
 * Dépendances : onnxruntime-web + @huggingface/transformers (tokenizer CLIP)
 * — importées DYNAMIQUEMENT pour ne pas alourdir le bundle principal.
 */

import { BASE_HF, REPO_MEDIA_GEN3IA, dirSd } from "./manifest";

/** Dimensions par ratio (grille SD 512, multiples de 8 — VAE safe). */
const DIMENSIONS: Record<string, { w: number; h: number }> = {
  "1:1": { w: 512, h: 512 },
  "3:4": { w: 448, h: 576 },
  "4:3": { w: 576, h: 448 },
  "16:9": { w: 576, h: 320 },
  "9:16": { w: 320, h: 576 },
  "2:3": { w: 416, h: 608 },
  "3:2": { w: 608, h: 416 },
  "21:9": { w: 640, h: 288 },
};

export interface OptionsImageWebGpu {
  prompt: string;
  ratio?: string;
  /** Pas DDIM (défaut 20 — équilibre qualité/GPU navigateur). */
  steps?: number;
  /** Guidance CFG (défaut 4.5 — photoréalisme sans sur-cuisson). */
  guidance?: number;
  seed?: number;
  onProgress?: (info: { étape: string; pourcent: number }) => void;
}

export interface RésultatImageWebGpu {
  blob: Blob;
  largeur: number;
  hauteur: number;
  pas: number;
  seed: number;
  adaptateur: string;
  duréeMs: number;
}

/* ------------------------------------------------- conversions fp16 ---- */
/** float32 → float16 (bits, arrondi au plus proche — IEEE 754 half). */
function f32versF16(val: number): number {
  const f32 = new Float32Array(1);
  const i32 = new Int32Array(f32.buffer);
  f32[0] = val;
  const x = i32[0];
  let bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;
  if (e < 103) return bits; // sous-flux → zéro
  if (e > 142) {
    bits |= 0x7c00; // infini (NaN → infini, suffisant pour des latents bornés)
    return bits;
  }
  if (e < 113) {
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;
  return bits;
}

/** float16 (bits) → float32. */
function f16versF32(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -1 : 1) * Infinity;
  return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
}

function pack16(f32: Float32Array): Uint16Array {
  const out = new Uint16Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = f32versF16(f32[i]);
  return out;
}

function unpack16(u16: Uint16Array): Float32Array {
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) out[i] = f16versF32(u16[i]);
  return out;
}

/* ---------------------------------------------------------- scheduler --- */
/** Alphas cumulés (schedule linéaire bêta SD 2.1 — identique au Colab). */
function alphasCumulés(nbPasTotal: number): Float64Array {
  const betaDébut = 0.00085;
  const betaFin = 0.012;
  const alphas = new Float64Array(nbPasTotal);
  let cumulé = 1;
  for (let i = 0; i < nbPasTotal; i++) {
    const b = betaDébut + ((betaFin - betaDébut) * i) / (nbPasTotal - 1);
    cumulé *= 1 - b;
    alphas[i] = cumulé;
  }
  return alphas;
}

/** RNG déterministe (mulberry32) — la même graine → la même image. */
function rng(graine: number): () => number {
  let a = graine >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Latents gaussiens N(0,1) (Box-Muller). */
function latentsAléatoires(c: number, h: number, w: number, graine: number): Float32Array {
  const rnd = rng(graine);
  const out = new Float32Array(c * h * w);
  for (let i = 0; i < out.length; i += 2) {
    const u1 = Math.max(rnd(), 1e-7);
    const u2 = rnd();
    const r = Math.sqrt(-2 * Math.log(u1));
    out[i] = r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < out.length) out[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  return out;
}

/* ------------------------------------------------------------- moteur --- */

type SessionOrt = import("onnxruntime-web").InferenceSession;

interface Sessions {
  ort: typeof import("onnxruntime-web");
  textEncoder: SessionOrt;
  unet: SessionOrt;
  vae: SessionOrt;
  tokenizer: import("@huggingface/transformers").PreTrainedTokenizer;
  adaptateur: string;
}

let sessions: Sessions | null = null;
let chargement: Promise<Sessions> | null = null;

/** Charge les sessions (une fois, promesse partagée). */
async function chargerSessions(
  onProgress?: (info: { étape: string; pourcent: number }) => void,
): Promise<Sessions> {
  if (sessions) return sessions;
  if (chargement) return chargement;
  chargement = (async () => {
    onProgress?.({ étape: "Chargement des bibliothèques GPU…", pourcent: 2 });
    const ort = await import("onnxruntime-web");
    const { AutoTokenizer } = await import("@huggingface/transformers");

    const dir = await dirSd();
    const urlSd = `${BASE_HF}/${dir}`;
    // WebGPU exclusivement — le repli WASM serait ~50× trop lent pour un UNet.
    const opts: import("onnxruntime-web").InferenceSession.SessionOptions = {
      executionProviders: ["webgpu"],
      graphOptimizationLevel: "all",
    };

    onProgress?.({ étape: "Téléchargement du tokenizer CLIP…", pourcent: 4 });
    const tokenizer = await AutoTokenizer.from_pretrained(`${REPO_MEDIA_GEN3IA}/${dir}`);

    onProgress?.({ étape: "Téléchargement de l'encodeur de texte (~350 Mo)…", pourcent: 8 });
    const textEncoder = await ort.InferenceSession.create(`${urlSd}/text_encoder.onnx`, opts);

    onProgress?.({
      étape: "Téléchargement de l'UNet (~1,7 Go) — une seule fois, ensuite en cache…",
      pourcent: 15,
    });
    const unet = await ort.InferenceSession.create(`${urlSd}/unet.onnx`, opts);

    onProgress?.({ étape: "Téléchargement du décodeur VAE (~160 Mo)…", pourcent: 80 });
    const vae = await ort.InferenceSession.create(`${urlSd}/vae_decoder.onnx`, opts);

    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    const ad = gpu ? await gpu.requestAdapter() : null;
    const info = ad ? (ad as GPUAdapter & { info?: GPUAdapterInfo }).info : undefined;

    onProgress?.({ étape: "Moteur photoréaliste prêt (GPU local).", pourcent: 100 });
    sessions = {
      ort,
      textEncoder,
      unet,
      vae,
      tokenizer,
      adaptateur: info?.vendor && info?.architecture ? `${info.vendor} ${info.architecture}` : "WebGPU",
    };
    return sessions;
  })();
  return chargement;
}

/** Encode prompt + invite vide (CFG) → deux tensors [1,77,1024] fp16. */
async function encoderTexte(
  s: Sessions,
  prompt: string,
): Promise<{ cond: import("onnxruntime-web").Tensor; uncond: import("onnxruntime-web").Tensor }> {
  const entrée = await s.tokenizer([prompt, ""], {
    padding: "max_length",
    max_length: 77,
    truncation: true,
    return_tensor: false,
  });
  const ids = entrée.input_ids as number[][];
  const plat = new Int32Array(ids.flat());
  const tensor = new s.ort.Tensor("int32", plat, [ids.length, ids[0].length]);
  const sortie = await s.textEncoder.run({ input_ids: tensor });
  const hidden = sortie.last_hidden_state as import("onnxruntime-web").Tensor;
  const u16 = hidden.data as Uint16Array;
  const parPhrase = u16.length / 2;
  const dimsPhrase = [1, ...hidden.dims.slice(1)];
  const cond = new s.ort.Tensor("float16", u16.slice(0, parPhrase), dimsPhrase);
  const uncond = new s.ort.Tensor("float16", u16.slice(parPhrase), dimsPhrase);
  return { cond, uncond };
}

/**
 * Génération photoréaliste complète sur le GPU de l'utilisateur.
 * Toute erreur propage — le hook déclenchera le repli serveur honnête.
 */
export async function générerImageWebGpu(opts: OptionsImageWebGpu): Promise<RésultatImageWebGpu> {
  const début = Date.now();
  const s = await chargerSessions(opts.onProgress);
  const dims = DIMENSIONS[opts.ratio ?? "1:1"] ?? DIMENSIONS["1:1"];
  const W = dims.w;
  const H = dims.h;
  const pas = Math.min(Math.max(opts.steps ?? 20, 4), 30);
  const guidance = Math.min(Math.max(opts.guidance ?? 4.5, 1), 12);
  const graine = (opts.seed ?? Date.now()) % 2 ** 31;

  opts.onProgress?.({ étape: "Encodage du brief visuel…", pourcent: 5 });
  const { cond, uncond } = await encoderTexte(s, opts.prompt);

  // Latents initiaux (4 × H/8 × W/8).
  const lh = H / 8;
  const lw = W / 8;
  let latents = new s.ort.Tensor(
    "float16",
    pack16(latentsAléatoires(4, lh, lw, graine)),
    [1, 4, lh, lw],
  );

  // Timesteps DDIM espacés de 999 → 0.
  const NB_TOTAL = 1000;
  const alphas = alphasCumulés(NB_TOTAL);
  const timesteps: number[] = [];
  for (let i = 0; i < pas; i++) {
    timesteps.push(Math.round(((NB_TOTAL - 1) * (pas - 1 - i)) / (pas - 1)));
  }
  if (timesteps[timesteps.length - 1] > 0) timesteps.push(0);

  const déballer = (t: import("onnxruntime-web").Tensor): Float32Array =>
    unpack16(t.data as Uint16Array);

  for (let i = 0; i < timesteps.length; i++) {
    const t = timesteps[i];
    const ts = new s.ort.Tensor("float16", pack16(new Float32Array([t])), [1]);

    // Prédiction conditionnelle (brief) et inconditionnelle (invite vide).
    const resCond = await s.unet.run({ sample: latents, timestep: ts, encoder_hidden_states: cond });
    const resUncond = await s.unet.run({
      sample: latents,
      timestep: ts,
      encoder_hidden_states: uncond,
    });
    const epsC = déballer(resCond.out_sample as import("onnxruntime-web").Tensor);
    const epsU = déballer(resUncond.out_sample as import("onnxruntime-web").Tensor);

    // Guidance classique : eps = uncond + g·(cond − uncond).
    const eps = new Float32Array(epsC.length);
    for (let j = 0; j < eps.length; j++) eps[j] = epsU[j] + guidance * (epsC[j] - epsU[j]);

    // Pas DDIM déterministe (eta = 0).
    const aT = alphas[t];
    const aPréc = alphas[timesteps[i + 1] ?? 0];
    const xT = déballer(latents);
    const suivant = new Float32Array(xT.length);
    for (let j = 0; j < xT.length; j++) {
      const x0 = (xT[j] - Math.sqrt(1 - aT) * eps[j]) / Math.sqrt(aT);
      suivant[j] = Math.sqrt(aPréc) * x0 + Math.sqrt(Math.max(0, 1 - aPréc)) * eps[j];
    }
    latents = new s.ort.Tensor("float16", pack16(suivant), [1, 4, lh, lw]);

    opts.onProgress?.({
      étape: `Diffusion ${i + 1}/${timesteps.length} — votre GPU calcule les pixels…`,
      pourcent: 10 + Math.round(((i + 1) / timesteps.length) * 78),
    });
  }

  // VAE decode → image [-1,1] → PNG (canvas).
  opts.onProgress?.({ étape: "Révélation de l'image…", pourcent: 92 });
  const resVae = await s.vae.run({ latent: latents });
  const image = resVae.image as import("onnxruntime-web").Tensor;
  const data = unpack16(image.data as Uint16Array);
  const nbPixels = image.dims[image.dims.length - 1] * image.dims[image.dims.length - 2];
  const canaux = image.dims[1]; // 3 (RGB) ou 1
  const rgba = new Uint8ClampedArray(nbPixels * 4);
  for (let i = 0; i < nbPixels; i++) {
    const r = data[i * canaux];
    const g = canaux >= 3 ? data[i * canaux + 1] : r;
    const b = canaux >= 3 ? data[i * canaux + 2] : r;
    rgba[i * 4] = Math.min(255, Math.max(0, Math.round(((r + 1) / 2) * 255)));
    rgba[i * 4 + 1] = Math.min(255, Math.max(0, Math.round(((g + 1) / 2) * 255)));
    rgba[i * 4 + 2] = Math.min(255, Math.max(0, Math.round(((b + 1) / 2) * 255)));
    rgba[i * 4 + 3] = 255;
  }

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D indisponible");
  ctx.putImageData(new ImageData(rgba, W, H), 0, 0);

  const blob = await new Promise<Blob>((accept, refus) =>
    canvas.toBlob((b) => (b ? accept(b) : refus(new Error("toBlob échoué"))), "image/png"),
  );

  opts.onProgress?.({ étape: "Image photoréaliste prête (100 % locale).", pourcent: 100 });
  return {
    blob,
    largeur: W,
    hauteur: H,
    pas,
    seed: graine,
    adaptateur: s.adaptateur,
    duréeMs: Date.now() - début,
  };
}
