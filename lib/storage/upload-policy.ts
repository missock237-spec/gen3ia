/**
 * Politique de televersement du stockage permanent « Memoire permanente ».
 *
 * Module pur (aucune dependance serveur) partage entre les routes API et les
 * tests. Toutes les limites sont surchargables via des variables
 * d'environnement afin d'ajuster la production sans redéploiement de code.
 */

/** 100 Mo max par fichier. */
export const MAX_FILE_BYTES = Number(
  process.env.GEN3IA_MAX_PERMANENT_FILE_BYTES ?? 100 * 1024 * 1024,
);

/** 10 fichiers max par lot de televersement. */
export const MAX_FILES_PER_BATCH = Number(
  process.env.GEN3IA_MAX_PERMANENT_BATCH_FILES ?? 10,
);

/** Quota total par utilisateur (defaut : 2 Go). */
export const MAX_USER_QUOTA_BYTES = Number(
  process.env.GEN3IA_MAX_PERMANENT_QUOTA_BYTES ?? 2 * 1024 * 1024 * 1024,
);

/**
 * Taille d'un chunk : 3 Mo, sous la limite de corps de requete serverless
 * Vercel (~4,5 Mo) pour garantir le passage meme avec les en-tetes.
 */
export const CHUNK_SIZE_BYTES = Number(
  process.env.GEN3IA_PERMANENT_CHUNK_BYTES ?? 3 * 1024 * 1024,
);

/** Limite de composants par appel GCS compose (max reel : 32). */
export const COMPOSE_BATCH_SIZE = 30;

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
  options: { alreadyUsedBytes?: number } = {},
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
  if (alreadyUsed + totalBytes > MAX_USER_QUOTA_BYTES) {
    return {
      ok: false,
      rejections: [{
        index: 0,
        filename: "",
        reason: `Quota depasse : ${formatBytes(alreadyUsed)} utilises, ${formatBytes(totalBytes)} demandes, quota ${formatBytes(MAX_USER_QUOTA_BYTES)}.`,
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
  return Math.ceil(sizeBytes / CHUNK_SIZE_BYTES);
}
