import "server-only";

import { downloadFromR2, isR2Configured } from "@/lib/storage/r2";

/**
 * Résolution des sources d'images éditables (étape 8 du plan 20).
 *
 * L'API Agnes image-to-image accepte des URLs publiques ou des Data URI
 * Base64 — mais une URL signée R2 expirée, une URL Agnes éphémère ou une
 * page protégée ne sont PAS fiables. Voie robuste unique : TOUTE source est
 * téléchargée côté serveur puis convertie en Data URI Base64, contrat que
 * la doc Agnes garantit (« If the image cannot be made public, use Data
 * URI Base64 input »).
 *
 * Sources acceptées (attachments du message) :
 *  - Data URI (`data:image/...;base64,...`) — utilisée telle quelle ;
 *  - URL http(s) — récupérée serveur (20 s, plafond taille) ;
 *  - clé R2 permanente (`users/<uid>/permanent/...`) — téléchargée via
 *    downloadFromR2 (authentifiée côté serveur, jamais exposée).
 */

/** Plafond par image source (octets) — 8 Mo couvre toute image utile. */
const MAX_SOURCE_BYTES = 8_000_000;
/** Durée max de récupération d'une source distante. */
const FETCH_TIMEOUT_MS = 20_000;
/** Nombre maximum d'images sources par édition (multi-composition Agnes). */
export const MAX_EDIT_SOURCES = 4;

const DATA_URI_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

export function isDataUriImage(value: string): boolean {
  return DATA_URI_RE.test(value) && value.length < 12_000_000;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Clé de stockage permanent Gen3ia (jamais une URL, toujours un chemin). */
export function isPermanentPath(value: string): boolean {
  return value.startsWith("users/") && !isHttpUrl(value) && !value.includes("..");
}

function dataUriFromBuffer(buffer: Buffer, contentType: string): string {
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

async function fetchAsDataUri(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  if (!response.ok) throw new Error(`Récupération de l'image source impossible (HTTP ${response.status}).`);
  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim();
  if (!contentType.startsWith("image/")) throw new Error("La source désignée n'est pas une image.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error("L'image source est vide.");
  if (buffer.length > MAX_SOURCE_BYTES) throw new Error(`Image source trop volumineuse (max ${Math.round(MAX_SOURCE_BYTES / 1_000_000)} Mo).`);
  return dataUriFromBuffer(buffer, contentType);
}

async function readPermanentAsDataUri(key: string): Promise<string> {
  if (!isR2Configured()) throw new Error("Stockage permanent non configuré pour lire l'image source.");
  const buffer = await downloadFromR2(key, MAX_SOURCE_BYTES);
  if (buffer.length === 0) throw new Error("L'image source est vide.");
  // Le content-type réel n'est pas stocké par clé : détection par magic bytes
  // (PNG/JPEG/GIF/WEBP) avec repli PNG — Agnes accepte les principaux formats.
  const contentType = sniffImageContentType(buffer);
  return dataUriFromBuffer(buffer, contentType);
}

export function sniffImageContentType(buffer: Buffer): string {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString("latin1") === "GIF87a" || buffer.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "image/png";
}

export interface EditableImageSource {
  /** Entrée brute d'origine (traçabilité). */
  raw: string;
  /** Data URI Base64 exploitable par l'API d'édition. */
  dataUri: string;
}

/**
 * Résout UNE source en Data URI. Lève une Error lisible — l'appelant décide
 * de l'UX (message honnête dans le fil, jamais de faux succès).
 */
export async function resolveImageSource(raw: string): Promise<EditableImageSource> {
  const value = raw.trim();
  if (!value) throw new Error("Source d'image vide.");
  if (value.startsWith("data:")) {
    if (!isDataUriImage(value)) throw new Error("Image inline invalide ou trop volumineuse.");
    return { raw: value.slice(0, 64), dataUri: value };
  }
  if (isPermanentPath(value)) {
    return { raw: value, dataUri: await readPermanentAsDataUri(value) };
  }
  if (isHttpUrl(value)) {
    return { raw: value.slice(0, 64), dataUri: await fetchAsDataUri(value) };
  }
  throw new Error("Source d'image non reconnue (data URI, URL https ou fichier permanent attendus).");
}

/** Candidate d'attachment : path R2 prioritaire, sinon url. */
export function attachmentImageCandidates(attachment: { path?: string; url?: string; contentType?: string; filename?: string }): string[] {
  const looksImage = (attachment.contentType?.startsWith("image/") ?? false)
    || /\.(png|jpe?g|gif|webp)$/i.test(attachment.filename ?? "");
  if (!looksImage) return [];
  const candidates: string[] = [];
  if (attachment.path && isPermanentPath(attachment.path)) candidates.push(attachment.path);
  if (attachment.url && (isHttpUrl(attachment.url) || attachment.url.startsWith("data:"))) candidates.push(attachment.url);
  return candidates;
}

/**
 * Résout jusqu'à MAX_EDIT_SOURCES sources, en sautant les sources
 * individuellement indisponibles (résilience) mais en échouant si AUCUNE
 * source n'est résoluble — jamais d'édition sans image réelle.
 */
export async function resolveEditableImageSources(raws: readonly string[]): Promise<EditableImageSource[]> {
  const resolved: EditableImageSource[] = [];
  const errors: string[] = [];
  for (const raw of raws.slice(0, MAX_EDIT_SOURCES)) {
    try {
      resolved.push(await resolveImageSource(raw));
      if (resolved.length >= MAX_EDIT_SOURCES) break;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (resolved.length === 0 && errors.length > 0) {
    throw new Error(`Aucune image source exploitable : ${errors[0]}`);
  }
  return resolved;
}
