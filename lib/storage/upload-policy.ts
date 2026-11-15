/**
 * Politique de televersement du stockage permanent « Memoire permanente ».
 *
 * Module pur (aucune dependance serveur) partage entre les routes API et les
 * tests. Toutes les limites sont surchargables via des variables
 * d'environnement afin d'ajuster la production sans redéploiement de code.
 */

/**
 * Lit une limite numerique d'environnement. Une variable vide ou invalide
 * (ex. GEN3IA_MAX_PERMANENT_FILE_BYTES = "" sur Vercel) retombe sur la
 * valeur par defaut au lieu de produire 0 — ce qui bloquait tout
 * televersement en production.
 */
function envLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 50 Mo max par fichier (politique unifiée des pièces jointes Gen3ia). */
export const MAX_FILE_BYTES = envLimit("GEN3IA_MAX_PERMANENT_FILE_BYTES", 50 * 1024 * 1024);

/** 10 fichiers max par lot de televersement. */
export const MAX_FILES_PER_BATCH = envLimit("GEN3IA_MAX_PERMANENT_BATCH_FILES", 10);

/**
 * Quota du plan gratuit — 1 Go offert à chaque compte (Task 150).
 * Remplacé à l'exécution par le quota du plan souscrit (5 Go / 10 Go) via
 * lib/storage/plans.ts ; cette constante reste le socle du plan free et la
 * limite utilisée quand aucun plan n'est encore enregistré.
 */
export const MAX_USER_QUOTA_BYTES = envLimit("GEN3IA_MAX_PERMANENT_QUOTA_BYTES", 1024 ** 3);

/**
 * Taille d'une partie multipart : 8 Mo. Contrainte double :
 * - >= 5 MiB minimum impose par le multipart S3/R2 (hors derniere partie) ;
 * - l'URL presignee permet au navigateur d'envoyer la partie DIRECTEMENT a
 *   R2, donc aucune contrainte de corps serverless n'est traversée.
 */
export const PART_SIZE_BYTES = envLimit("GEN3IA_PERMANENT_PART_BYTES", 8 * 1024 * 1024);

/** Duree de vie d'une session de televersement interrompue. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const ALLOWED_EXTENSIONS = new Set([
  // Documents
  "pdf", "doc", "docx", "rtf", "odt", "txt", "md", "csv", "tsv", "json", "xml",
  "yaml", "yml", "xls", "xlsx", "ppt", "pptx", "odp", "ods", "epub",
  // Images
  "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "svg", "bmp", "tiff", "tif",
  // Audio
  "mp3", "wav", "m4a", "ogg", "flac", "aac",
  // Video
  "mp4", "mov", "webm", "avi", "mkv",
  // Archives
  "zip", "tar", "gz",
  // Code & textes techniques
  "py", "js", "ts", "tsx", "jsx", "html", "css", "ipynb", "log", "sql",
]);

const BLOCKED_EXTENSIONS = new Set([
  "exe", "dll", "bat", "cmd", "sh", "ps1", "msi", "apk", "bin", "com", "scr",
  "vbs", "jar", "app", "deb", "rpm", "dmg", "iso",
]);

/**
 * Valeur canonique de l'attribut `accept` des <input type="file"> : dérivée
 * AUTOMATIQUEMENT de ALLOWED_EXTENSIONS pour que le sélecteur de fichiers du
 * navigateur propose EXACTEMENT ce que le serveur accepte (divergence
 * historique : le chat limitait à image/pdf/zip pendant que la politique
 * serveur autorisait ~50 formats — les utilisateurs voyaient leurs fichiers
 * « refusés » sans raison). Étendre la liste serveur ci-dessus étend
 * automatiquement le sélecteur.
 */
export const ACCEPT_ATTRIBUTE: string = [
  // Génériques multimédias (couvrent tous les sous-types du navigateur)
  "image/*",
  "audio/*",
  "video/*",
  // Documents bureautiques et texte (ext. explicites pour compat. maximale)
  ...[...ALLOWED_EXTENSIONS]
    .filter((ext) => !["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "svg", "bmp", "tiff", "tif", "mp3", "wav", "m4a", "ogg", "flac", "aac", "mp4", "mov", "webm", "avi", "mkv"].includes(ext))
    .map((ext) => `.${ext}`),
].join(",");

export type UploadIntent = {
  filename: string;
  contentType: string;
  sizeBytes: number;
};

export type ValidatedUploadIntent = {
  filename: string;
  safeFilename: string;
  contentType: string;
  sizeBytes: number;
  extension: string;
};

export type PolicyRejection = { index: number; filename: string; reason: string };

export type BatchValidation =
  | { ok: true; intents: ValidatedUploadIntent[]; totalBytes: number }
  | { ok: false; rejections: PolicyRejection[] };

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

/** Assainit un nom de fichier (meme logique que permanent-user-storage). */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .normalize("NFKC")
    .replace(/[\\/\0]/g, "_")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "";
  return cleaned.slice(0, 180);
}

export function isExtensionAllowed(filename: string): boolean {
  const ext = extensionOf(filename);
  if (BLOCKED_EXTENSIONS.has(ext)) return false;
  return ALLOWED_EXTENSIONS.has(ext);
}

/** Valide un lot de fichiers avant tout stockage (client comme serveur). */
export function validateUploadBatch(
  intents: Array<UploadIntent | ValidatedUploadIntent>,
  options: { alreadyUsedBytes?: number; quotaBytes?: number } = {},
): BatchValidation {
  const rejections: PolicyRejection[] = [];

  if (intents.length === 0) {
    return { ok: false, rejections: [{ index: 0, filename: "", reason: "Aucun fichier fourni." }] };
  }
  if (intents.length > MAX_FILES_PER_BATCH) {
    return {
      ok: false,
      rejections: [{
        index: 0,
        filename: "",
        reason: `Maximum ${MAX_FILES_PER_BATCH} fichiers par lot (recu : ${intents.length}).`,
      }],
    };
  }

  const validated: ValidatedUploadIntent[] = [];
  let totalBytes = 0;

  intents.forEach((intent, index) => {
    const safeFilename = sanitizeFilename(intent.filename);
    if (!safeFilename) {
      rejections.push({ index, filename: intent.filename, reason: "Nom de fichier invalide." });
      return;
    }
    if (!Number.isFinite(intent.sizeBytes) || intent.sizeBytes <= 0) {
      rejections.push({ index, filename: safeFilename, reason: "Fichier vide." });
      return;
    }
    if (intent.sizeBytes > MAX_FILE_BYTES) {
      rejections.push({
        index,
        filename: safeFilename,
        reason: `Fichier trop volumineux (max ${formatBytes(MAX_FILE_BYTES)}).`,
      });
      return;
    }
    if (!isExtensionAllowed(safeFilename)) {
      rejections.push({ index, filename: safeFilename, reason: "Type de fichier non autorise." });
      return;
    }
    totalBytes += intent.sizeBytes;
    validated.push({
      filename: intent.filename,
      safeFilename,
      contentType: intent.contentType || "application/octet-stream",
      sizeBytes: intent.sizeBytes,
      extension: extensionOf(safeFilename),
    });
  });

  if (rejections.length > 0) return { ok: false, rejections };

  const alreadyUsed = Math.max(0, options.alreadyUsedBytes ?? 0);
  const quotaBytes = Math.max(1, options.quotaBytes ?? MAX_USER_QUOTA_BYTES);
  if (alreadyUsed + totalBytes > quotaBytes) {
    return {
      ok: false,
      rejections: [{
        index: 0,
        filename: "",
        reason: `Quota depasse : ${formatBytes(alreadyUsed)} utilises, ${formatBytes(totalBytes)} demandes, quota ${formatBytes(quotaBytes)}.`,
      }],
    };
  }

  return { ok: true, intents: validated, totalBytes };
}

/** Valide un fichier isolément (permet de rejeter un fichier sans annuler le lot). */
export function validateSingleUpload(intent: UploadIntent): { ok: true; intent: ValidatedUploadIntent } | { ok: false; reason: string } {
  const safeFilename = sanitizeFilename(intent.filename);
  if (!safeFilename) return { ok: false, reason: "Nom de fichier invalide." };
  if (!Number.isFinite(intent.sizeBytes) || intent.sizeBytes <= 0) return { ok: false, reason: "Fichier vide." };
  if (intent.sizeBytes > MAX_FILE_BYTES) {
    return { ok: false, reason: `Fichier trop volumineux (max ${formatBytes(MAX_FILE_BYTES)}).` };
  }
  if (!isExtensionAllowed(safeFilename)) return { ok: false, reason: "Type de fichier non autorise." };
  return {
    ok: true,
    intent: {
      filename: intent.filename,
      safeFilename,
      contentType: intent.contentType || "application/octet-stream",
      sizeBytes: intent.sizeBytes,
      extension: extensionOf(safeFilename),
    },
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 o";
  const units = ["o", "Ko", "Mo", "Go"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[exponent]}`;
}

export function chunkCountFor(sizeBytes: number): number {
  if (sizeBytes <= 0) return 0;
  return Math.ceil(sizeBytes / PART_SIZE_BYTES);
}

export const partCountFor = chunkCountFor;
