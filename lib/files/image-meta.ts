/**
 * Métadonnées d'images RÉELLES lues depuis les octets (aucune dépendance).
 *
 * Historique : les images importées tombaient en « metadata-only » muet
 * (aucune dimension lue) — la demande moteur documentaire exige que Gen3ia
 * ANALYSE ce qu'il reçoit : dimensions, format réel par signature (pas par
 * extension), ratio. PNG (IHDR), JPEG (marqueurs SOFn), WEBP (VP8/VP8L/
 * VP8X) et SVG (attributs width/height/viewBox) sont couverts.
 */

export interface MetadonneesImage {
  format: "png" | "jpeg" | "webp" | "svg";
  largeur: number;
  hauteur: number;
}

/** PNG : signature 8 octets puis IHDR (largeur/hauteur UInt32BE à 16/20). */
function lirePng(b: Buffer): MetadonneesImage | null {
  if (b.length < 24) return null;
  if (b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  const largeur = b.readUInt32BE(16);
  const hauteur = b.readUInt32BE(20);
  if (!largeur || !hauteur) return null;
  return { format: "png", largeur, hauteur };
}

/** JPEG : parcours des marqueurs jusqu'au premier SOF (C0/C1/C2/…/CF hors C4/C8/CC). */
function lireJpeg(b: Buffer): MetadonneesImage | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marqueur = b[i + 1];
    // SOS (DA) : données image compressées — inutile d'aller plus loin.
    if (marqueur === 0xd8 || marqueur === 0x01 || (marqueur >= 0xd0 && marqueur <= 0xd9)) {
      i += 2;
      continue;
    }
    const longueur = b.readUInt16BE(i + 2);
    const estSof =
      marqueur >= 0xc0 && marqueur <= 0xcf && marqueur !== 0xc4 && marqueur !== 0xc8 && marqueur !== 0xcc;
    if (estSof) {
      if (i + 9 > b.length) return null;
      const hauteur = b.readUInt16BE(i + 5);
      const largeur = b.readUInt16BE(i + 7);
      if (!largeur || !hauteur) return null;
      return { format: "jpeg", largeur, hauteur };
    }
    i += 2 + longueur;
  }
  return null;
}

/** WEBP : RIFF…WEBP puis chunk VP8 (lossy), VP8L (lossless) ou VP8X (étendu). */
function lireWebp(b: Buffer): MetadonneesImage | null {
  if (b.length < 30) return null;
  if (b.subarray(0, 4).toString("ascii") !== "RIFF" || b.subarray(8, 12).toString("ascii") !== "WEBP") return null;
  const chunk = b.subarray(12, 16).toString("ascii");
  if (chunk === "VP8 ") {
    // VP8 : après l'en-tête de frame (3+3), keyframe start code 9d 01 2a.
    if (b.subarray(23, 26).toString("hex") !== "9d012a") return null;
    const largeur = b.readUInt16LE(26) & 0x3fff;
    const hauteur = b.readUInt16LE(28) & 0x3fff;
    if (!largeur || !hauteur) return null;
    return { format: "webp", largeur, hauteur };
  }
  if (chunk === "VP8L") {
    // VP8L : octet signature 0x2f, puis 14 bits largeur-1, 14 bits hauteur-1.
    if (b[20] !== 0x2f || b.length < 25) return null;
    const bits = b.readUInt32LE(21);
    const largeur = (bits & 0x3fff) + 1;
    const hauteur = ((bits >> 14) & 0x3fff) + 1;
    if (!largeur || !hauteur) return null;
    return { format: "webp", largeur, hauteur };
  }
  if (chunk === "VP8X") {
    // VP8X : 24 bits largeur-1 à l'octet 24, 24 bits hauteur-1 à l'octet 27.
    const largeur = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const hauteur = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    if (!largeur || !hauteur) return null;
    return { format: "webp", largeur, hauteur };
  }
  return null;
}

/** SVG (texte XML) : width/height attributs ou viewBox. */
function lireSvg(b: Buffer): MetadonneesImage | null {
  const texte = b.subarray(0, 64 * 1024).toString("utf8");
  if (!/<svg[\s>]/i.test(texte)) return null;
  const nombre = (v: string | undefined): number | null => {
    if (!v) return null;
    const n = Number.parseFloat(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  };
  const balise = texte.slice(0, texte.indexOf(">") + 1 || texte.length);
  const attr = (nom: string): string | undefined =>
    new RegExp(`${nom}\\s*=\\s*["']([^"']+)["']`, "i").exec(balise)?.[1];
  let largeur = nombre(attr("width"));
  let hauteur = nombre(attr("height"));
  if ((!largeur || !hauteur)) {
    const vb = attr("viewBox");
    if (vb) {
      const parts = vb.split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)) {
        largeur = largeur ?? Math.round(parts[2]);
        hauteur = hauteur ?? Math.round(parts[3]);
      }
    }
  }
  if (!largeur || !hauteur) return null;
  return { format: "svg", largeur, hauteur };
}

const SIGNATURES: { octets: number; ascii?: string; hex?: string }[] = [
  { octets: 8, hex: "89504e470d0a1a0a" }, // PNG
  { octets: 2, hex: "ffd8" }, // JPEG
  { octets: 4, ascii: "RIFF" }, // WEBP (contrôle WEBP fait dans lireWebp)
];

/**
 * Lit les métadonnées réelles d'une image depuis son contenu. Le format est
 * déterminé par SIGNATURE (jamais par l'extension) — un .png renommé en .jpg
 * est identifié comme PNG. Renvoie null si aucun format reconnu.
 */
export function metadonneesImage(buffer: Buffer): MetadonneesImage | null {
  if (!buffer || buffer.length < 16) return null;
  const png = lirePng(buffer);
  if (png) return png;
  const webp = lireWebp(buffer);
  if (webp) return webp;
  const jpeg = lireJpeg(buffer);
  if (jpeg) return jpeg;
  const svg = lireSvg(buffer);
  if (svg) return svg;
  return null;
}

/** Détecte si les octets ressemblent à une image connue (signature uniquement). */
export function estImageConnue(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  for (const s of SIGNATURES) {
    const candidat = s.ascii
      ? buffer.subarray(0, s.octets).toString("ascii") === s.ascii
      : buffer.subarray(0, s.octets).toString("hex").startsWith(s.hex!);
    if (candidat) return true;
  }
  return buffer.subarray(0, 4).toString("utf8").includes("<svg");
}
