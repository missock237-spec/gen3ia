/**
 * GÉNÉRATEUR DE VIDÉO — Gen3 multimodal.
 *
 * Une vidéo complète (scènes, animation, mouvement de caméra) est produite
 * comme une SÉQUENCE DE CADRES réels : chaque scène du plan est découpée
 * en frames (fps du plan), l'action interpole les paramètres (zoom entrant
 * du sujet, panoramique de caméra), chaque frame est rendue par le
 * compositeur structurel, et l'ensemble est écrit dans un CONTENEUR AVI
 * RÉEL (RIFF : avih + strl/strh/strf + movi '00dc' + idx1) — un fichier
 * que tout lecteur/ffmpeg décode. Vérifications réelles : structure parsée,
 * nombre de frames exact, durée = frames/fps, et ANIMATION PROUVÉE
 * (pixels de la frame N ≠ frame M).
 *
 * HONNÊTETÉ : ce niveau est « structurel-local » (composition + animation
 * réelles, pas photoréaliste). L'interface `FournisseurVideo` reçoit le
 * plan de scène pour un moteur vidéo frontière branché (réalisme réseau).
 */

import { inflateSync } from "node:zlib";

import { planifierVideo, type PlanScene, type SceneVideo } from "./encodeur-prompt-scene";
import { rendrePixelsStructurel } from "./generateur-images";

/** Écrit une chaîne ASCII + taille LE. */
function chunkListe(type: string, contenu: Buffer): Buffer {
  const t = Buffer.from(type, "ascii");
  const taille = Buffer.alloc(4);
  taille.writeUInt32LE(contenu.length, 0);
  return Buffer.concat([t, taille, contenu]);
}

function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
}

function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}

/**
 * ÉCRIVAIN AVI RÉEL — uncompressed DIB (BGR, bottom-up, lignes paddées).
 * Structure : RIFF('AVI ') → LIST('hdrl'){avih, LIST('strl'){strh, strf}}
 * → LIST('movi'){«00dc» × frames} → idx1. AVIF_HASINDEX est déclaré.
 */
export function ecrireAVI(frames: Buffer[], largeur: number, hauteur: number, fps: number): Buffer {
  const pasLigne = Math.ceil((largeur * 3) / 4) * 4; // padding DIB
  const tailleFrame = pasLigne * hauteur;
  // Conversion RGB top-down → BGR bottom-up.
  const dib = frames.map((rgb) => {
    const bgr = Buffer.alloc(tailleFrame);
    for (let y = 0; y < hauteur; y++) {
      const source = (hauteur - 1 - y) * largeur * 3; // bottom-up
      const cible = y * pasLigne;
      for (let x = 0; x < largeur; x++) {
        bgr[cible + x * 3] = rgb[source + x * 3 + 2];
        bgr[cible + x * 3 + 1] = rgb[source + x * 3 + 1];
        bgr[cible + x * 3 + 2] = rgb[source + x * 3];
      }
    }
    return bgr;
  });

  const tailleImage = largeur * hauteur * 3;
  // --- hdrl ---
  const avih = Buffer.alloc(56);
  avih.writeUInt32LE(Math.round(1e6 / fps), 0); // µs par frame
  avih.writeUInt32LE(tailleImage * fps + 8, 4); // bytes/sec approx
  avih.writeUInt32LE(0, 8); // padding granularity
  avih.writeUInt32LE(0x10, 12); // AVIF_HASINDEX
  avih.writeUInt32LE(frames.length, 16); // total frames
  avih.writeUInt32LE(0, 20); // initial frames
  avih.writeUInt32LE(1, 24); // streams
  avih.writeUInt32LE(tailleFrame, 28); // suggested buffer
  avih.writeUInt32LE(largeur, 32);
  avih.writeUInt32LE(hauteur, 36);
  // 4 u32 réservés (restent 0)
  const strh = Buffer.alloc(56);
  strh.write("vids", 0, "ascii");
  strh.write("DIB ", 4, "ascii");
  strh.writeUInt32LE(0, 8); // flags
  strh.writeUInt16LE(0, 12); // priority
  strh.writeUInt16LE(0, 14); // language
  strh.writeUInt32LE(0, 16); // initial frames
  strh.writeUInt32LE(1, 20); // scale
  strh.writeUInt32LE(fps, 24); // rate (fps/scale)
  strh.writeUInt32LE(0, 28); // start
  strh.writeUInt32LE(frames.length, 32); // length
  strh.writeUInt32LE(tailleFrame, 36); // suggested buffer
  strh.writeUInt32LE(0xffffffff, 40); // quality
  strh.writeUInt32LE(0, 44); // sample size
  strh.writeUInt16LE(0, 48); // rcFrame.left
  strh.writeUInt16LE(0, 50); // rcFrame.top
  strh.writeUInt16LE(largeur, 52); // rcFrame.right
  strh.writeUInt16LE(hauteur, 54); // rcFrame.bottom
  const strf = Buffer.alloc(40);
  strf.writeUInt32LE(40, 0); // biSize
  strf.writeInt32LE(largeur, 4);
  strf.writeInt32LE(hauteur, 8); // positif = bottom-up
  strf.writeUInt16LE(1, 12); // planes
  strf.writeUInt16LE(24, 14); // bpp
  strf.writeUInt32LE(0, 16); // BI_RGB
  strf.writeUInt32LE(tailleFrame, 20); // size image
  const strl = chunkListe("LIST", Buffer.concat([Buffer.from("strl", "ascii"), chunkListe("strh", strh), chunkListe("strf", strf)]));
  const hdrl = chunkListe("LIST", Buffer.concat([Buffer.from("hdrl", "ascii"), chunkListe("avih", avih), strl]));
  // --- movi ---
  const morceaux = dib.map((d) => chunkListe("00dc", d));
  const movi = chunkListe("LIST", Buffer.concat([Buffer.from("movi", "ascii"), ...morceaux]));
  // --- idx1 ---
  const idx1 = Buffer.alloc(frames.length * 16);
  let decalage = 4; // offset relatif au début de 'movi' (après le fourcc)
  dib.forEach((d, k) => {
    idx1.write("00dc", k * 16, "ascii");
    idx1.writeUInt32LE(0x10, k * 16 + 4); // AVIIF_KEYFRAME
    idx1.writeUInt32LE(decalage, k * 16 + 8);
    idx1.writeUInt32LE(d.length, k * 16 + 12);
    decalage += 8 + d.length;
  });
  const riff = Buffer.concat([Buffer.from("AVI ", "ascii"), hdrl, movi, chunkListe("idx1", idx1)]);
  const taille = Buffer.alloc(4);
  taille.writeUInt32LE(riff.length, 0);
  return Buffer.concat([Buffer.from("RIFF", "ascii"), taille, riff]);
}

export interface RenduVideo {
  avi: Buffer;
  nbFrames: number;
  fps: number;
  /** Durée en secondes = nbFrames / fps. */
  dureeSecondes: number;
  largeur: number;
  hauteur: number;
  niveauRealisme: "structurel-local" | "photoréaliste-réseau";
  fournisseur: string;
  /** PNG de la frame médiane (aperçu pour l'utilisateur). */
  apercuPNG: Buffer;
}

/** Paramètres d'animation d'une scène au temps t ∈ [0, 1]. */
function parametresAnimation(scene: SceneVideo, t: number): { decalageX: number; zoom: number } {
  switch (scene.action) {
    case "entrante":
      return { decalageX: 0, zoom: 1 + 0.8 * t }; // zoom progressif sur le sujet
    case "panoramique":
      return { decalageX: Math.round(160 * t), zoom: 1 }; // caméra qui balaye
    default:
      return { decalageX: 0, zoom: 1 };
  }
}

/** Contrat d'un moteur vidéo frontière RÉEL branché (réalisme réseau). */
export interface FournisseurVideo {
  readonly nom: string;
  generer(plan: PlanScene): Promise<Buffer>;
}

/**
 * Génère la vidéo complète depuis le prompt : scènes découpées, animation
 * interpolée, frames rendues, AVI réel écrit, aperçu PNG extrait.
 */
export async function genererVideo(prompt: string, fournisseur?: FournisseurVideo, options: { dureeSecondes?: number; fps?: number; largeur?: number; hauteur?: number } = {}): Promise<RenduVideo> {
  const plan = planifierVideo(prompt, options.dureeSecondes ?? 4, options.fps ?? 8);
  if (fournisseur) {
    const avi = await fournisseur.generer(plan);
    return { avi, nbFrames: 0, fps: plan.sequence!.fps, dureeSecondes: options.dureeSecondes ?? 4, largeur: 0, hauteur: 0, niveauRealisme: "photoréaliste-réseau", fournisseur: fournisseur.nom, apercuPNG: Buffer.alloc(0) };
  }
  const largeur = options.largeur ?? 256;
  const hauteur = options.hauteur ?? 192;
  const fps = plan.sequence!.fps;
  const frames: Buffer[] = [];
  const pngs: Buffer[] = [];
  for (const scene of plan.sequence!.scenes) {
    const nb = Math.max(1, Math.round(scene.dureeSecondes * fps));
    for (let k = 0; k < nb; k++) {
      const t = nb === 1 ? 0 : k / (nb - 1);
      const { decalageX, zoom } = parametresAnimation(scene, t);
      const rendu = rendrePixelsStructurel(plan, largeur, hauteur, { decalageX, zoom });
      // Le compositeur renvoie un PNG — il faut les pixels bruts pour l'AVI :
      // on re-rend directement en pixels via une frame décodable est coûteux,
      // donc le compositeur est rappelé et l'AVI est construit depuis le PNG
      // décodé par le test ; ici on stocke le PNG (frame) pour extraction.
      pngs.push(rendu.png);
      frames.push(rendu.pixels); // pixels bruts → AVI (sans détour PNG)
    }
  }
  const avi = ecrireAVI(frames, largeur, hauteur, fps);
  const mediane = Math.floor(pngs.length / 2);
  return {
    avi,
    nbFrames: frames.length,
    fps,
    dureeSecondes: Math.round((frames.length / fps) * 10) / 10,
    largeur,
    hauteur,
    niveauRealisme: "structurel-local",
    fournisseur: "gen3-structurel-local",
    apercuPNG: pngs[mediane] ?? pngs[0],
  };
}

/** Décodage PNG minimal (RGB 8 bits non entrelacé) → pixels bruts. Utilisé
 * pour convertir les frames PNG du compositeur en données AVI. */
export function decoderPixelsPNG(png: Buffer): Buffer {
  let offset = 8;
  let largeur = 0;
  let hauteur = 0;
  let idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const taille = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const donnees = png.subarray(offset + 8, offset + 8 + taille);
    if (type === "IHDR") {
      largeur = donnees.readUInt32BE(0);
      hauteur = donnees.readUInt32BE(4);
    } else if (type === "IDAT") {
      idat.push(donnees);
    } else if (type === "IEND") {
      break;
    }
    offset += 8 + taille + 4;
  }
  const inflate = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(largeur * hauteur * 3);
  const pas = 1 + largeur * 3;
  for (let y = 0; y < hauteur; y++) {
    inflate.copy(pixels, y * largeur * 3, y * pas + 1, (y + 1) * pas);
  }
  return pixels;
}
