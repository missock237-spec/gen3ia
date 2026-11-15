import type { DocumentBlock } from "../types";

/**
 * EMBARQUEMENT D'IMAGES DANS LES LIVRABLES (audit multimodal, axe C).
 *
 * Le schéma `DocumentBlockSchema` accepte un bloc `image` avec `url` depuis
 * longtemps, mais AUCUN générateur ne le rendait — le bloc était avalisé
 * puis silencieusement perdu. Ce module fournit la chaîne commune :
 *
 *   url (data URI OU http(s)) → téléchargement borné → détection par
 *   magic bytes → PNG/JPEG directement embarquables, tout le reste
 *   converti en PNG via sharp (si disponible) → dimensions réelles.
 *
 * Zod `.url()` valide les data URIs (`new URL("data:…")` est une URL
 * WHATWG valide) : les clés R2 brutes ne passent PAS le schéma — seules
 * les sources data URI / http(s) sont donc traitées ici.
 *
 * Contrat fail-soft (doctrine « le document part TOUJOURS ») : toute
 * image indisponible (source inaccessible, format non convertible, sharp
 * absent) renvoie null — les générateurs dessinent alors un cadre
 * « image indisponible » au lieu de faire échouer tout le livrable.
 */

/** Plafond de téléchargement d'une image source. */
const MAX_OCTETS = 8_000_000;
/** Timeout de récupération http(s). */
const TIMEOUT_MS = 15_000;
/** Côté maximal conservé (au-delà : réduction via sharp si disponible). */
const COTE_MAX_PX = 1400;

export interface ImageEmbarquee {
  buffer: Buffer;
  mime: "image/png" | "image/jpeg";
  largeurPx: number;
  hauteurPx: number;
}

/** Décode un data URI image en buffer + mime. */
function decoderDataUri(url: string): { buffer: Buffer; mime: string } | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/s.exec(url);
  if (!match) return null;
  const buffer = Buffer.from(match[2] ?? "", "base64");
  if (buffer.length === 0 || buffer.length > MAX_OCTETS) return null;
  return { buffer, mime: match[1] ?? "image/png" };
}

/** Détecte le format par magic bytes (PNG / JPEG / autre convertible). */
function snifferFormat(buffer: Buffer): "png" | "jpeg" | "autre" {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  return "autre";
}

/** Lit les dimensions d'un PNG (IHDR : octets 16–24, gros-boutiste). */
export function dimensionsPng(buffer: Buffer): { largeur: number; hauteur: number } | null {
  if (buffer.length < 24 || buffer.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  const largeur = buffer.readUInt32BE(16);
  const hauteur = buffer.readUInt32BE(20);
  return largeur > 0 && hauteur > 0 ? { largeur, hauteur } : null;
}

/** Lit les dimensions d'un JPEG (marqueur SOF0–SOF15, hors DHT/JPG). */
export function dimensionsJpeg(buffer: Buffer): { largeur: number; hauteur: number } | null {
  let i = 2;
  while (i + 9 < buffer.length) {
    if (buffer[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marqueur = buffer[i + 1]!;
    // SOS : la scan ne contient plus de dimensions utiles — abandon.
    if (marqueur === 0xd8 || (marqueur >= 0xd0 && marqueur <= 0xd9) || marqueur === 0x01 || marqueur === 0xff) {
      i += 2;
      continue;
    }
    const longueur = buffer.readUInt16BE(i + 2);
    const estSof = marqueur >= 0xc0 && marqueur <= 0xcf && marqueur !== 0xc4 && marqueur !== 0xc8 && marqueur !== 0xcc;
    if (estSof) {
      const hauteur = buffer.readUInt16BE(i + 5);
      const largeur = buffer.readUInt16BE(i + 7);
      return largeur > 0 && hauteur > 0 ? { largeur, hauteur } : null;
    }
    i += 2 + longueur;
  }
  return null;
}

/** Télécharge une source http(s) (borné en temps et en taille). */
async function telecharger(url: string): Promise<{ buffer: Buffer; mime: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const mime = (response.headers.get("content-type") || "").split(";")[0].trim();
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error("image vide");
  if (buffer.length > MAX_OCTETS) throw new Error("image trop volumineuse");
  return { buffer, mime: snifferFormat(buffer) === "autre" ? mime : `image/${snifferFormat(buffer)}` };
}

/**
 * Charge et prépare UNE image de bloc pour embarquement. Retourne null en
 * cas de source inaccessible ou de format non convertible — JAMAIS d'erreur
 * bloquante pour le livrable.
 */
export async function chargerImageBloc(block: Pick<DocumentBlock, "url">): Promise<ImageEmbarquee | null> {
  const url = typeof block.url === "string" ? block.url.trim() : "";
  if (!url) return null;

  try {
    let buffer: Buffer;
    if (url.startsWith("data:")) {
      const decode = decoderDataUri(url);
      if (!decode) return null;
      buffer = decode.buffer;
    } else if (/^https?:\/\//i.test(url)) {
      buffer = (await telecharger(url)).buffer;
    } else {
      return null;
    }

    const format = snifferFormat(buffer);
    if (format === "png") {
      const dims = dimensionsPng(buffer);
      if (dims && dims.largeur <= COTE_MAX_PX && dims.hauteur <= COTE_MAX_PX) {
        return { buffer, mime: "image/png", largeurPx: dims.largeur, hauteurPx: dims.hauteur };
      }
    }
    if (format === "jpeg") {
      const dims = dimensionsJpeg(buffer);
      if (dims && dims.largeur <= COTE_MAX_PX && dims.hauteur <= COTE_MAX_PX) {
        return { buffer, mime: "image/jpeg", largeurPx: dims.largeur, hauteurPx: dims.hauteur };
      }
    }

    // Format non directement embarquable (WebP/GIF/AVIF/SVG) OU dimensions
    // au-delà du côté max : conversion/réduction via sharp (si disponible).
    const { default: sharp } = await import("sharp");
    const reduit = await sharp(buffer, { failOn: "none" })
      .resize({ width: COTE_MAX_PX, height: COTE_MAX_PX, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    const meta = await sharp(reduit, { failOn: "none" }).metadata();
    if (!meta.width || !meta.height) return null;
    return { buffer: reduit, mime: "image/png", largeurPx: meta.width, hauteurPx: meta.height };
  } catch {
    // sharp absent, réseau indisponible, format illisible → repli générateur.
    return null;
  }
}
