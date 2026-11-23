import "server-only";

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createArtifact, getArtifact, addArtifactVersion } from "@/lib/domain/artifacts/repository";
import { downloadFromR2, uploadToR2 } from "@/lib/storage/r2";
import { checkFfmpegAvailable, cleanupTmpDir, probeMedia, runFfmpeg } from "@/lib/video/ffmpeg";

/**
 * ÉDITION D'ARTEFACTS PAR PROMPT — la demande utilisateur : gen3 doit
 * modifier une image, un audio ou une vidéo CRÉÉ selon la volonté de
 * l'utilisateur (bouton « Modifier » → prompt → transformation RÉELLE).
 *
 * Principe d'honnêteté : chaque opération demandée est appliquée par du
 * CODE RÉEL (sharp pour l'image, PCM/WAV pour l'audio, ffmpeg pour la
 * vidéo) — jamais un « résultat » fabriqué. Le prompt est interprété par un
 * parseur FR explicite (rotation, filtres, volume, découpe, vitesse…) ;
 * si AUCUNE opération connue n'est reconnue, gen3 REFUSE en listant ce
 * qu'il sait faire — il ne prétend jamais avoir modifié sans avoir modifié.
 *
 * Chaque édition produit une NOUVELLE VERSION de l'artefact
 * (`addArtifactVersion` — l'historique reste consultable, jusqu'à 50
 * versions) : l'original n'est jamais écrasé.
 */

export type TypeMédia = "image" | "audio" | "video";

/* ───────────── 1. Interprétation du prompt (pure, testée) ───────────── */

export interface OperationEdition {
  /** Nom d'opération normalisé (ex. « rotation-droite », « volume:+50 »). */
  nom: string;
  /** Valeur numérique quand l'opération en porte une (%, ×, secondes, px). */
  valeur?: number;
  /** Libellé humain pour le rapport d'édition. */
  libelle: string;
}

export interface DemandeEdition {
  operations: OperationEdition[];
  /** Segments du prompt qu'aucune opération connue n'a reconnus (honnêteté). */
  nonComprises: string[];
}

const NOMBRE = /(-?\d+(?:[.,]\d+)?)/;

function premierNombre(texte: string, defaut: number): number {
  const m = NOMBRE.exec(texte);
  return m ? Number(m[1].replace(",", ".")) : defaut;
}

/** Interprète le prompt FR en opérations réelles par type de média.
 *  Pure et testée — le cœur « gen3 comprend la volonté de l'utilisateur ». */
export function interpreterDemandeEdition(type: TypeMédia, prompt: string): DemandeEdition {
  const operations: OperationEdition[] = [];
  const nonComprises: string[] = [];
  // Découpe par séparateurs naturels : virgules, « puis », « et », points.
  const segments = prompt
    .toLowerCase()
    .split(/[,;.]+|\bpuis\b|\bet ensuite\b/)
    .map((s) => s.trim())
    .filter(Boolean);

  const ajouter = (nom: string, libelle: string, valeur?: number) => {
    operations.push({ nom, libelle, valeur });
  };

  for (const segment of segments) {
    let reconnu = false;

    if (type === "image") {
      if (/rotat|tourne|pivot/.test(segment)) {
        if (/gauche|anti|contre/.test(segment)) ajouter("rotation-gauche", "Rotation 90° vers la gauche");
        else ajouter("rotation-droite", "Rotation 90° vers la droite");
        reconnu = true;
      }
      if (/retourn[eé]|inverti.*vert|renvers/.test(segment) && !/miroir/.test(segment)) {
        ajouter("retourner", "Retournement vertical (tete-bêche)");
        reconnu = true;
      }
      if (/miroir|invers[eé].*horiz|sym[eé]tr/.test(segment)) {
        ajouter("miroir", "Effet miroir horizontal");
        reconnu = true;
      }
      if (/noir et blanc|n&b|gris|monochrome/.test(segment)) {
        ajouter("gris", "Passage en noir et blanc");
        reconnu = true;
      }
      if (/s[eé]pia|vieux|vintage/.test(segment)) {
        ajouter("sepia", "Tonalité sépia (vintage)");
        reconnu = true;
      }
      if (/flou/.test(segment)) {
        ajouter("flou", "Flou gaussien", premierNombre(segment, 6));
        reconnu = true;
      }
      if (/nettet|pr[eé]cis|contrast[eé]e sans flou|accentu/.test(segment) && /nettet|accentu/.test(segment)) {
        ajouter("nettete", "Renforcement de la netteté");
        reconnu = true;
      }
      if (/contraste/.test(segment) && !/nettete/.test(segment)) {
        ajouter("contraste", `Contraste ajusté à +${premierNombre(segment, 30)} %`, premierNombre(segment, 30));
        reconnu = true;
      }
      if (/luminos|plus clair|moins sombre|eclairc/.test(segment)) {
        ajouter("luminosite", `Luminosité ajustée à +${premierNombre(segment, 20)} %`, premierNombre(segment, 20));
        reconnu = true;
      } else if (/plus sombre|assombri/.test(segment)) {
        ajouter("luminosite", `Luminosité ajustée à −${Math.abs(premierNombre(segment, 20))} %`, -Math.abs(premierNombre(segment, 20)));
        reconnu = true;
      }
      if (/saturat|vif|color[eé]s? fort/.test(segment) || /d[eé]satur/.test(segment)) {
        const valeur = /d[eé]satur/.test(segment) ? -Math.abs(premierNombre(segment, 40)) : premierNombre(segment, 30);
        ajouter("saturation", `Saturation ajustée (${valeur >= 0 ? "+" : ""}${valeur} %)`, valeur);
        reconnu = true;
      }
      if (/carr[eé]|recadr/.test(segment)) {
        ajouter("carre", "Recadrage carré (centré)");
        reconnu = true;
      }
      const dimensions = /(\d{2,5})\s*(?:x|×|par)\s*(\d{2,5})/.exec(segment);
      if (dimensions) {
        ajouter("redimensionner", `Redimensionnement ${dimensions[1]}×${dimensions[2]} px`, Number(dimensions[1]));
        operations[operations.length - 1].libelle = `Redimensionnement ${dimensions[1]}×${dimensions[2]} px`;
        // hauteur mémorisée via libellé ; la valeur numérique porte la largeur.
        reconnu = true;
      }
    }

    if (type === "audio") {
      if (/volume|fort|faible|silencieux|baiss|augment/.test(segment)) {
        // Signe EXPLICITE du nombre respecté (-30 % reste -30) ; les mots
        // d'intention inversent seulement une valeur positive (« plus faible »).
        let valeur = premierNombre(segment, 50);
        const signeExplicite = /^-|\s-\d|- ?\d+ ?%/.test(segment) || valeur < 0;
        if (/faible|baiss|diminu|moins|rédui|r[eé]dui/.test(segment) && !signeExplicite) valeur = -Math.abs(valeur);
        else if (valeur < 0) valeur = valeur; // signe déjà négatif : conservé
        else if (!signeExplicite) valeur = Math.abs(valeur);
        ajouter(`volume:${valeur}`, `Volume ajusté (${valeur >= 0 ? "+" : ""}${valeur} %)`, valeur);
        reconnu = true;
      }
      if (/vitesse|acc[eé]l[eé]r|ralent|tempo|rapide|lent/.test(segment)) {
        let valeur = premierNombre(segment, 1.5);
        if (/ralent|lent/.test(segment) && valeur > 1) valeur = 1 / valeur;
        ajouter(`vitesse:${valeur}`, `Vitesse ×${valeur}`, valeur);
        reconnu = true;
      }
      if (/(coupe|supprime|retire|enl[eè]ve).*(d[eé]but|commenc|premi)/.test(segment)) {
        ajouter("couper-debut", `Premières ${premierNombre(segment, 3)} seconde(s) coupées`, premierNombre(segment, 3));
        reconnu = true;
      }
      if (/(coupe|supprime|retire|enl[eè]ve).*(fin|derni)/.test(segment) || /(garde|conserve|limite).*(secondes?|minutes?)/.test(segment)) {
        const valeur = premierNombre(segment, 10);
        ajouter("garder-duree", `Durée limitée à ${valeur} seconde(s)`, valeur);
        reconnu = true;
      }
      if (/fondu|fade/.test(segment)) {
        ajouter("fondu", `Fondu de ${premierNombre(segment, 2)} seconde(s)`, premierNombre(segment, 2));
        reconnu = true;
      }
      if (/normalis|uniform/.test(segment)) {
        ajouter("normaliser", "Normalisation du niveau sonore");
        reconnu = true;
      }
      if (/mu|sans son|enleve le son|retire le son/.test(segment)) {
        ajouter("muet", "Piste muette (silence total)");
        reconnu = true;
      }
    }

    if (type === "video") {
      if (/(coupe|supprime|retire|enl[eè]ve).*(d[eé]but|commenc|premi)/.test(segment)) {
        ajouter("couper-debut", `Premières ${premierNombre(segment, 3)} seconde(s) coupées`, premierNombre(segment, 3));
        reconnu = true;
      }
      if (/(coupe|supprime|retire|enl[eè]ve).*(fin|derni)/.test(segment) || /(garde|conserve|limite).*(secondes?|minutes?)/.test(segment)) {
        const valeur = premierNombre(segment, 10);
        ajouter("garder-duree", `Durée limitée à ${valeur} seconde(s)`, valeur);
        reconnu = true;
      }
      if (/vitesse|acc[eé]l[eé]r|ralent|rapide|lent/.test(segment)) {
        let valeur = premierNombre(segment, 1.5);
        if (/ralent|lent/.test(segment) && valeur > 1) valeur = 1 / valeur;
        ajouter(`vitesse:${valeur}`, `Vitesse ×${valeur}`, valeur);
        reconnu = true;
      }
      if (/mu|sans son|enleve le son|retire le son/.test(segment)) {
        ajouter("muet", "Vidéo sans son");
        reconnu = true;
      }
      if (/480/.test(segment)) {
        ajouter("echelle:480", "Échelle 480p", 480);
        reconnu = true;
      } else if (/720|hd/.test(segment)) {
        ajouter("echelle:720", "Échelle 720p", 720);
        reconnu = true;
      } else if (/1080|full hd/.test(segment)) {
        ajouter("echelle:1080", "Échelle 1080p", 1080);
        reconnu = true;
      }
    }

    if (!reconnu) nonComprises.push(segment);
  }
  return { operations, nonComprises };
}

/** Liste humaine des opérations supportées (message de refus honnête). */
export function operationsSupportees(type: TypeMédia): string {
  if (type === "image") {
    return "rotation gauche/droite, retournement, miroir, noir et blanc, sépia, flou, netteté, contraste ±N %, luminosité ±N %, saturation ±N %, recadrage carré, redimensionnement LxH";
  }
  if (type === "audio") {
    return "volume ±N %, vitesse ×N, couper le début N s, garder N s, fondu N s, normaliser, muet";
  }
  return "couper le début N s, garder N s, vitesse ×N, muet, échelle 480p/720p/1080p";
}

/* ───────────── 2. IMAGE — transformations sharp réelles ───────────── */

export async function appliquerEditionImage(buffer: Buffer, ops: OperationEdition[]): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  let image = sharp(buffer);
  for (const op of ops) {
    switch (op.nom) {
      case "rotation-gauche":
        image = image.rotate(-90);
        break;
      case "rotation-droite":
        image = image.rotate(90);
        break;
      case "retourner":
        image = image.flip();
        break;
      case "miroir":
        image = image.flop();
        break;
      case "gris":
        image = image.greyscale();
        break;
      case "sepia":
        image = image.greyscale().tint({ r: 200, g: 160, b: 110 });
        break;
      case "flou":
        image = image.blur(Math.max(0.3, Math.min(50, op.valeur ?? 6)));
        break;
      case "nettete":
        image = image.sharpen();
        break;
      case "contraste":
        image = image.linear(1 + (op.valeur ?? 30) / 100, 0);
        break;
      case "luminosite": {
        const b = 1 + (op.valeur ?? 20) / 100;
        image = image.modulate({ brightness: Math.max(0.1, Math.min(3, b)) });
        break;
      }
      case "saturation": {
        const s = 1 + (op.valeur ?? 30) / 100;
        image = image.modulate({ saturation: Math.max(0, Math.min(3, s)) });
        break;
      }
      case "carre":
        image = image.resize(1024, 1024, { fit: "cover", position: "centre" });
        break;
      case "redimensionner": {
        const m = /(\d{2,5})\s*(?:x|×|par)\s*(\d{2,5})/.exec(op.libelle);
        if (m) image = image.resize(Number(m[1]), Number(m[2]), { fit: "inside", withoutEnlargement: false });
        break;
      }
      default:
        break;
    }
  }
  return image.png({ compressionLevel: 6 }).toBuffer();
}

/* ───────────── 3. AUDIO — PCM/WAV réel (RIFF PCM16) ───────────── */

export interface InfoWav {
  canaux: number;
  echantillonParSeconde: number;
  bitsParEchantillon: number;
  /** Échantillons INTERLEAVÉS Int16 (canaux inclus). */
  echantillons: Int16Array;
}

/** Parse un RIFF/WAV PCM16 (les audios gen3 et la plupart des WAV). */
export function lireWavPcm16(buffer: Buffer): InfoWav {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Audio illisible : conteneur RIFF/WAVE attendu.");
  }
  let position = 12;
  let canaux = 0;
  let frequence = 0;
  let bits = 0;
  let data: Buffer | null = null;
  while (position + 8 <= buffer.length) {
    const id = buffer.toString("ascii", position, position + 4);
    const taille = buffer.readUInt32LE(position + 4);
    const corps = buffer.subarray(position + 8, position + 8 + taille);
    if (id === "fmt ") {
      canaux = corps.readUInt16LE(2);
      frequence = corps.readUInt32LE(4);
      bits = corps.readUInt16LE(14);
    } else if (id === "data") {
      data = Buffer.from(corps);
    }
    position += 8 + taille + (taille % 2);
  }
  if (!data || canaux < 1 || bits !== 16) {
    throw new Error("Audio non pris en charge par l'édition : WAV PCM 16 bits attendu (convertir d'abord).");
  }
  const echantillons = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2));
  return { canaux, echantillonParSeconde: frequence, bitsParEchantillon: bits, echantillons };
}

/** Reconstruit un RIFF/WAVE PCM16 valide depuis des échantillons Int16. */
export function ecrireWavPcm16(info: { canaux: number; echantillonParSeconde: number; echantillons: Int16Array }): Buffer {
  const octetsDonnees = info.echantillons.length * 2;
  const tampon = Buffer.alloc(44 + octetsDonnees);
  tampon.write("RIFF", 0, "ascii");
  tampon.writeUInt32LE(36 + octetsDonnees, 4);
  tampon.write("WAVE", 8, "ascii");
  tampon.write("fmt ", 12, "ascii");
  tampon.writeUInt32LE(16, 16);
  tampon.writeUInt16LE(1, 20); // PCM
  tampon.writeUInt16LE(info.canaux, 22);
  tampon.writeUInt32LE(info.echantillonParSeconde, 24);
  tampon.writeUInt32LE(info.echantillonParSeconde * info.canaux * 2, 28); // byteRate
  tampon.writeUInt16LE(info.canaux * 2, 32); // blockAlign
  tampon.writeUInt16LE(16, 34);
  tampon.write("data", 36, "ascii");
  tampon.writeUInt32LE(octetsDonnees, 40);
  for (let i = 0; i < info.echantillons.length; i += 1) tampon.writeInt16LE(info.echantillons[i], 44 + i * 2);
  return tampon;
}

/** Applique les opérations audio RÉELLEMENT sur les échantillons PCM. */
export function appliquerOperationsWav(
  wav: InfoWav,
  ops: OperationEdition[],
): { wav: InfoWav; appliquees: OperationEdition[] } {
  let echantillons = Int16Array.from(wav.echantillons);
  const frequence = wav.echantillonParSeconde;
  const parImage = wav.canaux;
  const appliquees: OperationEdition[] = [];

  for (const op of ops) {
    if (op.nom === "muet") {
      echantillons = new Int16Array(echantillons.length); // silence réel
      appliquees.push(op);
      continue;
    }
    if (op.nom.startsWith("volume")) {
      const facteur = Math.max(0, 1 + (op.valeur ?? 0) / 100);
      const resultat = new Int16Array(echantillons.length);
      for (let i = 0; i < echantillons.length; i += 1) {
        const v = echantillons[i] * facteur;
        resultat[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
      }
      echantillons = resultat;
      appliquees.push(op);
      continue;
    }
    if (op.nom.startsWith("vitesse")) {
      const ratio = Math.max(0.25, Math.min(4, op.valeur ?? 1));
      const nouvelle = Math.max(parImage, Math.floor(echantillons.length / ratio));
      const resultat = new Int16Array(nouvelle - (nouvelle % parImage));
      for (let i = 0; i < resultat.length; i += parImage) {
        const source = Math.floor((i / resultat.length) * (echantillons.length / parImage)) * parImage;
        for (let c = 0; c < parImage; c += 1) resultat[i + c] = echantillons[Math.min(echantillons.length - 1, source + c)];
      }
      echantillons = resultat;
      appliquees.push(op);
      continue;
    }
    if (op.nom === "couper-debut") {
      const coupe = Math.min(echantillons.length - parImage, Math.round((op.valeur ?? 0) * frequence) * parImage);
      echantillons = echantillons.slice(coupe);
      appliquees.push(op);
      continue;
    }
    if (op.nom === "garder-duree") {
      const garde = Math.min(echantillons.length, Math.round((op.valeur ?? 0) * frequence) * parImage);
      echantillons = echantillons.slice(0, garde);
      appliquees.push(op);
      continue;
    }
    if (op.nom === "fondu") {
      const taille = Math.min(Math.floor(echantillons.length / 2), Math.round((op.valeur ?? 2) * frequence) * parImage);
      for (let i = 0; i < taille; i += 1) {
        const facteur = i / taille;
        echantillons[i] = Math.round(echantillons[i] * facteur);
        echantillons[echantillons.length - 1 - i] = Math.round(echantillons[echantillons.length - 1 - i] * facteur);
      }
      appliquees.push(op);
      continue;
    }
    if (op.nom === "normaliser") {
      let crête = 1;
      for (let i = 0; i < echantillons.length; i += 1) crête = Math.max(crête, Math.abs(echantillons[i]));
      const facteur = crête > 0 ? 32767 * 0.95 / crête : 1;
      for (let i = 0; i < echantillons.length; i += 1) echantillons[i] = Math.round(echantillons[i] * facteur);
      appliquees.push(op);
      continue;
    }
  }
  return { wav: { canaux: wav.canaux, echantillonParSeconde: frequence, bitsParEchantillon: wav.bitsParEchantillon, echantillons }, appliquees };
}

export async function appliquerEditionAudio(buffer: Buffer, ops: OperationEdition[]): Promise<Buffer> {
  const wav = lireWavPcm16(buffer);
  const { wav: edite } = appliquerOperationsWav(wav, ops);
  return ecrireWavPcm16({ canaux: edite.canaux, echantillonParSeconde: edite.echantillonParSeconde, echantillons: edite.echantillons });
}

/* ───────────── 4. VIDÉO — ffmpeg réel (découpe, vitesse, muet, échelle) ───────────── */

export async function appliquerEditionVideo(
  buffer: Buffer,
  ops: OperationEdition[],
  extension: string,
): Promise<Buffer> {
  const dispo = await checkFfmpegAvailable();
  if (!dispo.ffmpeg || !dispo.ffprobe) {
    throw new Error(`Édition vidéo indisponible : ffmpeg/ffprobe absents de ce déploiement${dispo.diagnostic ? ` (${dispo.diagnostic})` : ""}.`);
  }
  const bac = await mkdtemp(join(tmpdir(), "gen3ia-edition-"));
  try {
    const entree = join(bac, `source.${extension || "mp4"}`);
    const sortie = join(bac, "edite.mp4");
    await writeFile(entree, buffer);
    const probe = await probeMedia(entree, bac);
    // MediaProbe expose la durée en secondes directement (nombre).
    const duree = Number(probe.durationSec ?? 0) || 0;

    // Filtres SÉPARÉS : -vf ne tolère que des filtres VIDÉO (scale, setpts) ;
    // atempo (audio) passe par -af — le mélanger ferait échouer ffmpeg.
    const filtresVisuels: string[] = [];
    const filtresAudio: string[] = [];
    let debut = 0;
    let dureeFinale = duree;
    let vitesse = 1;
    let muet = false;
    for (const op of ops) {
      if (op.nom === "couper-debut") debut = Math.max(0, Math.min(duree - 0.2, op.valeur ?? 0));
      if (op.nom === "garder-duree") dureeFinale = Math.min(duree - debut, op.valeur ?? duree);
      if (op.nom.startsWith("vitesse")) vitesse = Math.max(0.25, Math.min(4, op.valeur ?? 1));
      if (op.nom === "muet") muet = true;
      if (op.nom === "echelle:480") filtresVisuels.push("scale=-2:480");
      if (op.nom === "echelle:720") filtresVisuels.push("scale=-2:720");
      if (op.nom === "echelle:1080") filtresVisuels.push("scale=-2:1080");
    }
    if (vitesse !== 1) {
      filtresVisuels.push(`setpts=PTS/${vitesse}`);
      // atempo borné [0.5, 2] par filtre — chaîne pour les ratios extrêmes.
      let restant = vitesse;
      while (restant > 2) {
        filtresAudio.push("atempo=2.0");
        restant /= 2;
      }
      while (restant < 0.5) {
        filtresAudio.push("atempo=0.5");
        restant *= 2;
      }
      filtresAudio.push(`atempo=${restant.toFixed(4)}`);
    }
    dureeFinale = dureeFinale / vitesse;

    const args: string[] = [];
    if (debut > 0) args.push("-ss", debut.toFixed(3));
    args.push("-i", entree);
    if (filtresVisuels.length > 0) args.push("-vf", filtresVisuels.join(","));
    if (!muet && filtresAudio.length > 0) args.push("-af", filtresAudio.join(","));
    if (muet) args.push("-an");
    args.push("-t", dureeFinale.toFixed(3));
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23");
    if (!muet) args.push("-c:a", "aac");
    args.push("-movflags", "+faststart", sortie);

    await runFfmpeg({ args, cwd: bac, outputDurationSec: Math.max(1, dureeFinale), outputPaths: [sortie] });
    const resultat = await readFile(sortie);
    if (resultat.length === 0) throw new Error("Édition vidéo : ffmpeg n'a produit aucun fichier.");
    return resultat;
  } finally {
    await rm(bac, { recursive: true, force: true });
    void cleanupTmpDir; // référence conservée : le cleanup standard existe côté analyse
  }
}

/* ───────────── 5. ORCHESTRATION : artefact → édition → nouvelle version ───────────── */

export interface RapportEditionArtefact {
  artefactId: string;
  type: TypeMédia;
  version: number;
  operations: OperationEdition[];
  nonComprises: string[];
  storagePath: string;
  note: string;
  /** URL présignée courte pour l'affichage immédiat (expire, 600 s). */
  apercu?: string;
}

const MIME_PAR_TYPE: Record<TypeMédia, string> = {
  image: "image/png",
  audio: "audio/wav",
  video: "video/mp4",
};

/** Charge le média d'un artefact (R2 → buffer, ou URL https → fetch). */
async function chargerMediaArtefact(params: {
  storagePath?: string;
  url?: string;
  content?: string;
  maxOctets: number;
}): Promise<{ buffer: Buffer; extension: string }> {
  if (params.storagePath) {
    const buffer = await downloadFromR2(params.storagePath, params.maxOctets);
    const m = /\.([a-z0-9]{2,5})$/i.exec(params.storagePath);
    return { buffer, extension: (m?.[1] ?? "bin").toLowerCase() };
  }
  if (params.url && /^https:\/\//i.test(params.url)) {
    const reponse = await fetch(params.url);
    if (!reponse.ok) throw new Error(`Média inaccessible (HTTP ${reponse.status}).`);
    const tampon = Buffer.from(await reponse.arrayBuffer());
    const chemin = new URL(params.url).pathname;
    const m = /\.([a-z0-9]{2,5})$/i.exec(chemin);
    return { buffer: tampon, extension: (m?.[1] ?? "bin").toLowerCase() };
  }
  if (params.content) {
    return { buffer: Buffer.from(params.content, "base64"), extension: "bin" };
  }
  throw new Error("Aucun média éditable sur cet artefact (ni fichier stocké, ni URL, ni contenu).");
}

const MAX_OCTETS_EDITION = 80 * 1024 * 1024;

/**
 * Édite un artefact EXISTANT selon le prompt : média chargé → opérations
 * réelles appliquées → NOUVELLE VERSION enregistrée (l'original reste
 * dans l'historique). Propriété stricte : getArtifact(userId, id) refuse
 * déjà les artefacts d'autrui.
 */
export async function editerArtefact(params: {
  userId: string;
  artefactId: string;
  prompt: string;
  conversationId?: string;
}): Promise<RapportEditionArtefact> {
  const artefact = await getArtifact(params.userId, params.artefactId);
  if (!artefact) throw new Error("Artefact introuvable pour ce compte (propriété stricte).");
  const typeBrut = artefact.type;
  if (typeBrut !== "image" && typeBrut !== "audio" && typeBrut !== "video") {
    throw new Error(`L'édition par prompt couvre image/audio/vidéo — cet artefact est de type « ${typeBrut} ».`);
  }
  if (typeBrut === "video" && !artefact.storagePath && artefact.videoProjectId) {
    throw new Error(
      "Cet artefact vidéo référence une production en cours : sa révision passe par l'outil video.revise (studio vidéo), pas par l'édition de fichier.",
    );
  }
  const type: TypeMédia = typeBrut;
  const demande = interpreterDemandeEdition(type, params.prompt);
  if (demande.operations.length === 0) {
    throw new Error(
      `Aucune opération d'édition reconnue dans « ${params.prompt} ». Opérations supportées (${type}) : ${operationsSupportees(type)}.`,
    );
  }

  const { buffer, extension } = await chargerMediaArtefact({
    storagePath: artefact.storagePath,
    url: artefact.url,
    content: artefact.content,
    maxOctets: MAX_OCTETS_EDITION,
  });
  if (buffer.length === 0) throw new Error("Le média de cet artefact est vide ou inaccessible.");

  let edite: Buffer;
  if (type === "image") edite = await appliquerEditionImage(buffer, demande.operations);
  else if (type === "audio") edite = await appliquerEditionAudio(buffer, demande.operations);
  else edite = await appliquerEditionVideo(buffer, demande.operations, extension);

  const cle = `users/${params.userId}/permanent/artefacts-edites/${Date.now()}-${randomUUID()}.${type === "image" ? "png" : type === "audio" ? "wav" : "mp4"}`;
  await uploadToR2(cle, edite, MIME_PAR_TYPE[type]);

  const operationsLibelle = demande.operations.map((o) => o.libelle).join(" · ");
  const note = `Édition gen3 (« ${params.prompt.slice(0, 160)} ») : ${operationsLibelle}.`;
  const misAJour = await addArtifactVersion(params.userId, params.artefactId, {
    storagePath: cle,
    note,
  });

  return {
    artefactId: params.artefactId,
    type,
    version: misAJour.versions[0]?.version ?? 1,
    operations: demande.operations,
    nonComprises: demande.nonComprises,
    storagePath: cle,
    note,
  };
}

/**
 * Édite un média fourni par URL (bouton « Modifier » sur un média du fil
 * sans artefact existant) : le résultat devient un NOUVEL artefact versionné
 * et propriété de l'utilisateur.
 */
export async function editerMediaParUrl(params: {
  userId: string;
  type: TypeMédia;
  url: string;
  prompt: string;
  titre?: string;
}): Promise<RapportEditionArtefact & { artefactCree: string }> {
  if (!/^https:\/\//i.test(params.url)) {
    throw new Error("URL du média invalide (https attendu).");
  }
  const demande = interpreterDemandeEdition(params.type, params.prompt);
  if (demande.operations.length === 0) {
    throw new Error(
      `Aucune opération d'édition reconnue dans « ${params.prompt} ». Opérations supportées (${params.type}) : ${operationsSupportees(params.type)}.`,
    );
  }
  const { buffer, extension } = await chargerMediaArtefact({ url: params.url, maxOctets: MAX_OCTETS_EDITION });
  let edite: Buffer;
  if (params.type === "image") edite = await appliquerEditionImage(buffer, demande.operations);
  else if (params.type === "audio") edite = await appliquerEditionAudio(buffer, demande.operations);
  else edite = await appliquerEditionVideo(buffer, demande.operations, extension);

  const cle = `users/${params.userId}/permanent/artefacts-edites/${Date.now()}-${randomUUID()}.${params.type === "image" ? "png" : params.type === "audio" ? "wav" : "mp4"}`;
  await uploadToR2(cle, edite, MIME_PAR_TYPE[params.type]);
  const operationsLibelle = demande.operations.map((o) => o.libelle).join(" · ");
  const note = `Édition gen3 (« ${params.prompt.slice(0, 160)} ») : ${operationsLibelle}.`;
  const artefact = await createArtifact({
    userId: params.userId,
    type: params.type,
    title: (params.titre || `Média édité par gen3 (${params.type})`).slice(0, 200),
    filename: `edite.${params.type === "image" ? "png" : params.type === "audio" ? "wav" : "mp4"}`,
    storagePath: cle,
    note,
  });
  return {
    artefactId: artefact.id,
    artefactCree: artefact.id,
    type: params.type,
    version: 1,
    operations: demande.operations,
    nonComprises: demande.nonComprises,
    storagePath: cle,
    note,
  };
}
