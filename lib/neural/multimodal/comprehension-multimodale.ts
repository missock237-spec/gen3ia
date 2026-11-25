/**
 * COMPRÉHENSION MULTIMODALE LOCALE (LOT 6 — mission « GEN3IA BRAIN
 * COMPLETION ») : le cerveau savait GÉNÉRER des médias localement
 * (WAV, SVG, vidéo SMIL — effecteurs existants) et CONDITIONNER des
 * requêtes en ondes (conditionneur). Il lui MANQUAIT de COMPRENDRE les
 * médias reçus : analyser une image, un son, une vidéo-native et en
 * extraire une description structurée — sans AUCUNE API d'IA externe.
 *
 * Trois analyseurs 100 % locaux :
 *  · IMAGE — sharp (dépendance locale EXISTANTE du dépôt, traitement
 *    d'image, pas une IA) : pixels → luminance, contraste, histogramme
 *    colorimétrique grossier (4×4×4), densité de bords (gradient Sobel
 *    échantillonné) → interprétation bornée du cerveau ;
 *  · AUDIO — WAV PCM 16 bits mono (le format RÉEL de l'effecteur) :
 *    durée, RMS (loudness), taux de passage à zéro, centre de gravité
 *    spectral (DFT bornée ≤ 8 192 échantillons) → classe honnête
 *    (silence / tonal / bruit / potentiellement-voisé) ;
 *  · VIDÉO — le format natif du cerveau (animation SVG SMIL) : durée,
 *    animations, éléments ; les conteneurs exogènes (mp4…) sont REFUSÉS
 *    honnêtement (pas de décodeur local — jamais de fausse analyse).
 *
 * Chaque description porte ses MESURES brutes : le cerveau « comprend »
 * ce qu'il peut mesurer et le déclare — il ne fabrique jamais de contenu
 * imaginé à propos d'un média.
 */

import type { Sharp } from "sharp";

/** Description d'une image comprise (mesures réelles). */
export interface ImageComprise {
  comprise: true;
  format: string;
  largeur: number;
  hauteur: number;
  /** Luminance moyenne [0..255] (Rec. 601). */
  luminanceMoyenne: number;
  /** Contraste (écart-type de la luminance) [0..255]. */
  contraste: number;
  /** Couleur dominante (bin 4×4×4 de l'histogramme RVB). */
  couleurDominante: { rouge: number; vert: number; bleu: number };
  /** Densité de bords [0..1] (gradient échantillonné). */
  densiteBords: number;
  /** Interprétation bornée du cerveau (à partir des mesures, rien d'autre). */
  interpretation: string;
}

/** Description d'un son compris (mesures réelles). */
export interface AudioCompris {
  comprise: true;
  format: "wav-pcm16-mono";
  dureeSecondes: number;
  sampleRate: number;
  /** RMS [0..1] — loudness réelle. */
  rms: number;
  /** Taux de passage à zéro [0..1]. */
  tauxPassageZero: number;
  /** Centre de gravité spectral (Hz) — DFT bornée. */
  centreSpectralHz: number;
  classe: "silence" | "tonal" | "bruit" | "potentiellement-voise";
}

/** Description d'une vidéo native comprise (SMIL du cerveau). */
export interface VideoComprise {
  comprise: true;
  format: "svg-smil";
  dureeSecondes: number;
  nbAnimations: number;
  nbElements: number;
  fps: number | null;
}

/** Analyse IMAGE : sharp local → mesures → interprétation bornée. */
export async function comprendreImage(buffer: Buffer): Promise<ImageComprise> {
  const mod = await import("sharp");
  const sharp = mod.default;
  const img = sharp(buffer);
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error("image illisible (métadonnées absentes)");
  const maxCote = 128;
  const brut = await img
    .clone()
    .resize({ width: Math.min(maxCote, meta.width), height: Math.min(maxCote, meta.height), fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = brut;
  const width = info.width;
  const height = info.height;
  const channels = info.channels;
  const pixel = (x: number, y: number, c: number): number => data[(y * width + x) * channels + c] ?? 0;

  // Luminance + histogramme 4×4×4 + variance.
  const histogramme = new Map<string, { n: number; r: number; g: number; b: number }>();
  let sommeLum = 0;
  let sommeCarree = 0;
  let nb = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const r = pixel(x, y, 0);
      const g = pixel(x, y, 1);
      const b = pixel(x, y, 2);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      sommeLum += lum;
      sommeCarree += lum * lum;
      nb += 1;
      const cle = `${r >> 6},${g >> 6},${b >> 6}`;
      const bin = histogramme.get(cle) ?? { n: 0, r: 0, g: 0, b: 0 };
      bin.n += 1;
      bin.r += r;
      bin.g += g;
      bin.b += b;
      histogramme.set(cle, bin);
    }
  }
  const luminanceMoyenne = nb > 0 ? sommeLum / nb : 0;
  const contraste = nb > 0 ? Math.sqrt(Math.max(0, sommeCarree / nb - luminanceMoyenne * luminanceMoyenne)) : 0;

  // Couleur dominante : centre du bin le plus peuplé.
  let dominant = { n: 0, r: 0, g: 0, b: 0 };
  for (const bin of histogramme.values()) if (bin.n > dominant.n) dominant = bin;
  const couleurDominante = dominant.n > 0
    ? { rouge: Math.round(dominant.r / dominant.n), vert: Math.round(dominant.g / dominant.n), bleu: Math.round(dominant.b / dominant.n) }
    : { rouge: 0, vert: 0, bleu: 0 };

  // Densité de bords : gradient horizontal/vertical (Sobel simplifié,
  // échantillonnage pas 2 — coût borné).
  let bords = 0;
  let echantillons = 0;
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const gx = Math.abs(pixel(x + 1, y, 0) - pixel(x - 1, y, 0));
      const gy = Math.abs(pixel(x, y + 1, 0) - pixel(x, y - 1, 0));
      if (gx + gy > 60) bords += 1;
      echantillons += 1;
    }
  }
  const densiteBords = echantillons > 0 ? Math.round((bords / echantillons) * 1000) / 1000 : 0;

  const interpretation = [
    luminanceMoyenne < 60 ? "image sombre" : luminanceMoyenne > 190 ? "image claire" : "image d'éclairage moyen",
    contraste > 70 ? "contraste fort" : contraste < 25 ? "faible contraste" : "contraste modéré",
    densiteBords > 0.4 ? "structure détaillée (bords denses)" : densiteBords < 0.12 ? "zones lisses" : "bords modérés",
    `dominante RVB(${couleurDominante.rouge},${couleurDominante.vert},${couleurDominante.bleu})`,
  ].join(", ");

  return {
    comprise: true,
    format: meta.format ?? "inconnu",
    largeur: meta.width,
    hauteur: meta.height,
    luminanceMoyenne: Math.round(luminanceMoyenne * 10) / 10,
    contraste: Math.round(contraste * 10) / 10,
    couleurDominante,
    densiteBords,
    interpretation,
  };
}

/** Analyse AUDIO : WAV PCM 16 bits mono (format réel de l'effecteur). */
export function comprendreAudioWav(buffer: Buffer): AudioCompris {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("pas un fichier WAV (refus honnête — jamais de fausse analyse)");
  }
  // En-tête fmt (PCM 16 bits attendu).
  const sampleRate = buffer.readUInt32LE(24);
  const bitsParEchantillon = buffer.readUInt16LE(34);
  if (bitsParEchantillon !== 16) throw new Error(`WAV ${bitsParEchantillon} bits non pris en charge (16 bits mono du cerveau)`);
  // Données : chercher le chunk "data".
  let offset = 12;
  while (offset + 8 <= buffer.length && buffer.toString("ascii", offset, offset + 4) !== "data") {
    offset += 8 + buffer.readUInt32LE(offset + 4);
  }
  if (offset + 8 > buffer.length) throw new Error("chunk data absent du WAV");
  const tailleData = Math.min(buffer.readUInt32LE(offset + 4), buffer.length - offset - 8);
  const echantillons = new Int16Array(buffer.buffer, buffer.byteOffset + offset + 8, Math.floor(tailleData / 2));

  const n = Math.min(echantillons.length, 1 << 16);
  let sommeCarrees = 0;
  let passagesZero = 0;
  for (let i = 0; i < n; i++) {
    const v = echantillons[i] / 32_768;
    sommeCarrees += v * v;
    if (i > 0 && (echantillons[i] >= 0) !== (echantillons[i - 1] >= 0)) passagesZero += 1;
  }
  const rms = n > 0 ? Math.sqrt(sommeCarrees / n) : 0;
  const tauxPassageZero = n > 1 ? passagesZero / (n - 1) : 0;

  // Centre de gravité spectral : DFT pleine résolution BORNÉE
  // (≤ 2 048 échantillons, 1 024 bins — coût contrôlé, pas de
  // sous-échantillonnage : il biaise le spectre).
  const N = Math.min(n, 2_048);
  const bins = 1_024;
  const centre = N > 0 ? graviteSpectrale(echantillons, N, bins, sampleRate) : 0;
  const dureeSecondes = sampleRate > 0 ? Math.round((echantillons.length / sampleRate) * 100) / 100 : 0;

  const classe: AudioCompris["classe"] =
    rms < 0.01 ? "silence" : tauxPassageZero < 0.15 ? "tonal" : tauxPassageZero > 0.45 ? "bruit" : "potentiellement-voise";
  return {
    comprise: true,
    format: "wav-pcm16-mono",
    dureeSecondes,
    sampleRate,
    rms: Math.round(rms * 1000) / 1000,
    tauxPassageZero: Math.round(tauxPassageZero * 1000) / 1000,
    centreSpectralHz: Math.round(centre),
    classe,
  };
}

/** Centre de gravité spectral (DFT pleine résolution bornée — le bin k
 * correspond exactement à freq = k·sampleRate/M, sans aliasing). */
function graviteSpectrale(ech: Int16Array, N: number, bins: number, sampleRate: number): number {
  if (sampleRate <= 0 || N < 16) return 0;
  const M = Math.min(N, 2_048);
  const nbBins = Math.min(bins, Math.floor(M / 2));
  let sommePonderee = 0;
  let sommePoids = 0;
  for (let k = 1; k < nbBins; k++) {
    const freq = (k * sampleRate) / M;
    let re = 0;
    let im = 0;
    for (let t = 0; t < M; t++) {
      const v = ech[t] / 32_768;
      const angle = (-2 * Math.PI * k * t) / M;
      re += v * Math.cos(angle);
      im += v * Math.sin(angle);
    }
    const puissance = re * re + im * im;
    sommePonderee += freq * puissance;
    sommePoids += puissance;
  }
  return sommePoids > 0 ? sommePonderee / sommePoids : 0;
}

/** Analyse VIDÉO : format NATIF du cerveau (SVG SMIL) — refus honnête sinon. */
export function comprendreVideoSmil(svg: string | Buffer): VideoComprise {
  const texte = (typeof svg === "string" ? svg : svg.toString("utf8")).slice(0, 2_000_000);
  if (!/<svg[\s>]/i.test(texte)) {
    throw new Error("pas une animation SVG SMIL du cerveau (mp4/conteneurs : décodeur local indisponible — refus honnête)");
  }
  const dureeMatch = /dur=["']([\d.]+)s?["']/i.exec(texte);
  const duree = dureeMatch ? parseFloat(dureeMatch[1]) : 0;
  const nbAnimations = (texte.match(/<animate|<animateTransform|<animateMotion/gi) ?? []).length;
  const nbElements = (texte.match(/<(rect|circle|ellipse|line|path|polygon|text)\b/gi) ?? []).length;
  const fpsMatch = /fps["']?\s*[:=]\s*["']?(\d+)/i.exec(texte);
  return {
    comprise: true,
    format: "svg-smil",
    dureeSecondes: duree,
    nbAnimations,
    nbElements,
    fps: fpsMatch ? parseInt(fpsMatch[1], 10) : null,
  };
}

/** Métrique de surface (laboratoire LOT 7). */
export function surfaceMultimodal(): { analyseurs: number; formatsNatifs: string[] } {
  return { analyseurs: 3, formatsNatifs: ["image (sharp local)", "wav-pcm16-mono", "svg-smil"] };
}

/** Type utilitaire pour les usages internes (sharp). */
export type { Sharp };
