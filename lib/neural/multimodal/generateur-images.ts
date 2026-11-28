/**
 * GÉNÉRATEUR D'IMAGES — Gen3 multimodal.
 *
 * Deux niveaux de réalisme, assumés honnêtement :
 *  · STRUCTUREL LOCAL : compositeur déterministe écrit en TypeScript pur —
 *    ciel dégradé par éclairage, disque lumineux, horizon, silhouettes du
 *    sujet — et un ÉCRIVAIN PNG RÉEL (zlib + CRC32, octets conformes au
 *    format : tout décodeur PNG lit ces fichiers). Ce niveau prouve la
 *    chaîne de production image de bout en bout ; il N'EST PAS
 *    photoréaliste et ne le prétend pas.
 *  · PHOTORÉALISTE RÉSEAU : interface `FournisseurImages` — un moteur de
 *    diffusion réel (branches) reçoit le même plan de scène et renvoie le
 *    PNG ; la livraison est alors étiquetée « photoréaliste-réseau ».
 */

import { deflateSync } from "node:zlib";

import type { PlanScene } from "./encodeur-prompt-scene";

/** Table CRC32 (norme PNG). */
const TABLE_CRC: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(donnees: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < donnees.length; i++) c = TABLE_CRC[(c ^ donnees[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Un chunk PNG complet (longueur + type + données + CRC). */
function chunkPNG(type: string, donnees: Buffer): Buffer {
  const taille = Buffer.alloc(4);
  taille.writeUInt32BE(donnees.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, donnees])), 0);
  return Buffer.concat([taille, typeBuf, donnees, crc]);
}

/**
 * ÉCRIVAIN PNG RÉEL — signature + IHDR (RGB 8 bits) + IDAT (zlib des
 * scanlines filtrées 0) + IEND. Vérifié par décodage dans les tests.
 */
export function ecrirePNG(largeur: number, hauteur: number, pixels: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largeur, 0);
  ihdr.writeUInt32BE(hauteur, 4);
  ihdr[8] = 8; // profondeur
  ihdr[9] = 2; // couleur RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filtre (méthode)
  ihdr[12] = 0; // entrelacement
  const brutes = Buffer.alloc(hauteur * (1 + largeur * 3));
  for (let y = 0; y < hauteur; y++) {
    const ligne = y * (1 + largeur * 3);
    brutes[ligne] = 0; // filtre « aucun »
    pixels.copy(brutes, ligne + 1, y * largeur * 3, (y + 1) * largeur * 3);
  }
  return Buffer.concat([signature, chunkPNG("IHDR", ihdr), chunkPNG("IDAT", deflateSync(brutes, { level: 6 })), chunkPNG("IEND", Buffer.alloc(0))]);
}

/** Couleur interpolée dans un dégradé vertical. */
function melanger(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

/** Options d'animation d'un cadre vidéo : décalage caméra (panoramique)
 * et zoom sujet (entrante) — t ∈ [0, 1] dans la scène. */
export interface OptionsCadre {
  decalageX?: number;
  zoom?: number;
}

export interface RenduImage {
  png: Buffer;
  largeur: number;
  hauteur: number;
  /** Étiquette honnête du niveau de réalisme effectif. */
  niveauRealisme: "structurel-local" | "photoréaliste-réseau";
  fournisseur: string;
}

/**
 * COMPOSITEUR STRUCTUREL LOCAL : dégradé de ciel par éclairage, disque
 * lumineux (soleil/lune), horizon, silhouettes du sujet et des éléments
 * (proportions par cadrage), néons si éclairage néon. Déterministe :
 * même plan → octets PNG identiques.
 */
export function rendreStructurel(plan: PlanScene, largeur = 512, hauteur = 384): RenduImage {
  return { ...rendrePixelsStructurel(plan, largeur, hauteur), niveauRealisme: "structurel-local", fournisseur: "gen3-structurel-local" };
}

/** Compose UN cadre (image ou frame vidéo) — déterministe pour (plan, options). */
export function rendrePixelsStructurel(plan: PlanScene, largeur = 512, hauteur = 384, options: OptionsCadre = {}): { png: Buffer; pixels: Buffer; largeur: number; hauteur: number } {
  const decalageX = Math.round(options.decalageX ?? 0);
  const zoom = options.zoom ?? 1;
  const pixels = Buffer.alloc(largeur * hauteur * 3);
  const { palette, eclairage, cadrage } = plan;
  const horizon = Math.floor(hauteur * (cadrage === "plan-large" ? 0.62 : 0.7));
  // 1) Ciel en dégradé vertical (haut → bas).
  for (let y = 0; y < hauteur; y++) {
    const t = Math.min(1, y / Math.max(1, horizon));
    const couleur = y < horizon ? melanger(palette.cielHaut, palette.cielBas, t) : palette.sol;
    for (let x = 0; x < largeur; x++) {
      const i = (y * largeur + x) * 3;
      pixels[i] = couleur[0];
      pixels[i + 1] = couleur[1];
      pixels[i + 2] = couleur[2];
    }
  }
  // 2) Disque lumineux (soleil doré/plein jour, lune pâle la nuit, halo néon).
  const cx = Math.max(0, Math.min(largeur - 1, Math.floor(largeur * 0.68) - decalageX)); // panoramique : le soleil glisse
  const cy = Math.floor(horizon * 0.42);
  const rayon = Math.floor(largeur * (eclairage === "nuit" ? 0.05 : 0.09));
  for (let y = Math.max(0, cy - rayon * 2); y < Math.min(horizon, cy + rayon * 2); y++) {
    for (let x = Math.max(0, cx - rayon * 2); x < Math.min(largeur, cx + rayon * 2); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < rayon) {
        const i = (y * largeur + x) * 3;
        pixels[i] = palette.lumiere[0];
        pixels[i + 1] = palette.lumiere[1];
        pixels[i + 2] = palette.lumiere[2];
      } else if (d < rayon * 2) {
        // Halo doux : mélange vers la lumière.
        const i = (y * largeur + x) * 3;
        const alpha = 1 - (d - rayon) / rayon;
        pixels[i] = Math.round(pixels[i] * (1 - alpha) + palette.lumiere[0] * alpha);
        pixels[i + 1] = Math.round(pixels[i + 1] * (1 - alpha) + palette.lumiere[1] * alpha);
        pixels[i + 2] = Math.round(pixels[i + 2] * (1 - alpha) + palette.lumiere[2] * alpha);
      }
    }
  }
  // 3) Silhouettes : sujet (gauche-centre) + éléments, ancrées à l'horizon —
  //    hauteur selon cadrage (gros plan = sujet proche, plus grand).
  const hauteurSujet = Math.floor(hauteur * (cadrage === "gros-plan" ? 0.5 : cadrage === "plan-moyen" ? 0.34 : 0.2) * zoom);
  const largeurSujet = Math.floor(largeur * (cadrage === "gros-plan" ? 0.16 : 0.1) * zoom);
  const baseSujetY = horizon + Math.floor(hauteur * 0.06);
  const tracerSilhouette = (x0: number, h: number, w: number, couleur: [number, number, number]) => {
    for (let y = baseSujetY - h; y < baseSujetY; y++) {
      const rel = (baseSujetY - y) / h; // 0 en bas, 1 en haut
      const demi = Math.round(w / 2 * (1 - rel * 0.6)); // se rétrécit vers le haut
      for (let x = x0 - demi; x <= x0 + demi; x++) {
        if (x < 0 || x >= largeur || y < 0 || y >= hauteur) continue;
        const i = (y * largeur + x) * 3;
        pixels[i] = couleur[0];
        pixels[i + 1] = couleur[1];
        pixels[i + 2] = couleur[2];
      }
    }
  };
  const sombre: [number, number, number] = eclairage === "nuit" ? [4, 5, 12] : [22, 18, 20];
  tracerSilhouette(Math.max(-1, Math.floor(largeur * 0.3) - decalageX), hauteurSujet, largeurSujet, sombre); // panoramique : les sujets défilent
  plan.elements.slice(0, 2).forEach((_, k) => {
    tracerSilhouette(Math.max(-1, Math.floor(largeur * (0.55 + k * 0.22)) - decalageX), Math.floor(hauteurSujet * 0.55), Math.floor(largeurSujet * 0.6), sombre);
  });
  // 4) Néons : lignes verticales lumineuses si éclairage néon.
  if (eclairage === "neon") {
    for (let k = 0; k < 5; k++) {
      const x = Math.floor(largeur * (0.08 + k * 0.18));
      for (let y = 0; y < horizon; y++) {
        const i = (y * largeur + x) * 3;
        pixels[i] = palette.lumiere[0];
        pixels[i + 1] = palette.lumiere[1];
        pixels[i + 2] = palette.lumiere[2];
      }
    }
  }
  return { png: ecrirePNG(largeur, hauteur, pixels), pixels, largeur, hauteur };
}

/** Contrat d'un moteur de diffusion RÉEL branché (photoréalisme réseau). */
export interface FournisseurImages {
  readonly nom: string;
  generer(plan: PlanScene): Promise<Buffer>;
}

/**
 * Livraison image : fournisseurs branchés d'abord (photoréaliste-réseau),
 * rendu structurel local en repli — l'étiquette est TOUJOURS honnête.
 */
export async function genererImage(plan: PlanScene, fournisseur?: FournisseurImages, largeur = 512, hauteur = 384): Promise<RenduImage> {
  if (fournisseur) {
    const png = await fournisseur.generer(plan);
    return { png, largeur: 0, hauteur: 0, niveauRealisme: "photoréaliste-réseau", fournisseur: fournisseur.nom };
  }
  return rendreStructurel(plan, largeur, hauteur);
}
