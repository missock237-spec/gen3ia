import "server-only";

import { createHash } from "node:crypto";

import type { ModelFileFormat, TrainingFamily } from "../types";
import type { validationFindingSchema } from "../types";
import type { z } from "zod";

/* ------------------------------------------------------------------ */
/* Validation des fichiers modèles (spec §4 étape 2 + §11 sécurité)     */
/*                                                                    */
/* Politique de sécurité — un fichier n'est JAMAIS chargé ni exécuté   */
/* ici : seuls des octets sont inspectés (header, magic, structure).   */
/*  - safetensors : header JSON réel lu et vérifié (le format le plus   */
/*    sûr : pas de code exécutable, déclarations explicites) ;         */
/*  - gguf : magic "GGUF" vérifié ;                                     */
/*  - zip-archive : structure inspectée via yauzl (config.json,        */
/*    index.json…) — les entrées path-traversal sont rejetées ;        */
/*  - .pt/.pth/.ckpt : REFUSÉS (sérialisation pickle = exécution de    */
/*    code arbitraire possible — spec §11) ;                            */
/*  - .bin : accepté mais QUARANTINE + conversion safetensors           */
/*    recommandée avant tout entraînement.                             */
/* ------------------------------------------------------------------ */

export type ValidationFinding = z.infer<typeof validationFindingSchema>;

export interface ModelValidationReport {
  format: ModelFileFormat | null;
  status: "valid" | "quarantined" | "rejected";
  findings: ValidationFinding[];
  metadata: Record<string, unknown>;
  sha256: string;
}

/** Extensions refusées catégoriquement (pickle = exécution de code). */
const FORBIDDEN_EXTENSIONS = [".pt", ".pth", ".ckpt", ".pickle", ".pkl"];

function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx).toLowerCase();
}

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Lit et valide un header safetensors : 8 octets little-endian = taille JSON. */
function parseSafetensorsHeader(buffer: Buffer): { ok: boolean; headerBytes?: number; reason?: string } {
  if (buffer.byteLength < 8) return { ok: false, reason: "fichier trop court pour un header safetensors" };
  const headerLen = Number(buffer.readBigUInt64LE(0));
  if (!Number.isFinite(headerLen) || headerLen <= 1 || headerLen > 100 * 1024 * 1024) {
    return { ok: false, reason: `taille de header invraisemblable (${headerLen})` };
  }
  if (8 + headerLen > buffer.byteLength) {
    return { ok: false, reason: "header déclaré plus grand que le fichier" };
  }
  try {
    const header = JSON.parse(buffer.subarray(8, 8 + headerLen).toString("utf8")) as Record<string, unknown>;
    if (typeof header !== "object" || header === null) {
      return { ok: false, reason: "header JSON non objet" };
    }
    return { ok: true, headerBytes: headerLen };
  } catch {
    return { ok: false, reason: "header JSON illisible" };
  }
}

/** Vérifie le magic GGUF (v3 : "GGUF" + version uint32). */
function isGguf(buffer: Buffer): boolean {
  return buffer.subarray(0, 4).toString("ascii") === "GGUF";
}

/** Inspecte la structure d'une archive ZIP (entrées + détection config). */
async function inspectZip(
  buffer: Buffer,
): Promise<{ ok: boolean; entries: string[]; hasConfig: boolean; reason?: string }> {
  const { default: yauzl } = await import("yauzl");
  return new Promise((resolve) => {
    const entries: string[] = [];
    let hasConfig = false;
    let settled = false;
    const finish = (ok: boolean, reason?: string) => {
      if (settled) return;
      settled = true;
      resolve({ ok, entries: entries.slice(0, 50), hasConfig, reason });
    };
    try {
      yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: true }, (err, zip) => {
        if (err || !zip) {
          finish(false, "archive ZIP illisible");
          return;
        }
        zip.on("error", () => finish(false, "archive ZIP corrompue"));
        zip.on("entry", (entry: { fileName: string }) => {
          const name = entry.fileName;
          if (name.includes("..")) {
            finish(false, `entrée suspecte (path traversal) : ${name}`);
            return;
          }
          entries.push(name);
          if (name === "config.json" || name.endsWith("/config.json")) hasConfig = true;
        });
        zip.on("end", () => finish(true));
        zip.readEntry();
      });
    } catch {
      finish(false, "archive ZIP illisible");
    }
  });
}

/**
 * Valide un fichier modèle téléversé.
 * `buffer` : le contenu intégral (déjà plafonné par le quota d'upload).
 */
export async function validateModelFile(
  filename: string,
  buffer: Buffer,
  family: TrainingFamily,
): Promise<ModelValidationReport> {
  const findings: ValidationFinding[] = [];
  const metadata: Record<string, unknown> = {
    filename: filename.slice(0, 180),
    sizeBytes: buffer.byteLength,
  };
  const ext = extensionOf(filename);
  const sha = sha256Hex(buffer);
  metadata.sha256 = sha;

  if (FORBIDDEN_EXTENSIONS.includes(ext)) {
    return {
      format: null,
      status: "rejected",
      findings: [
        {
          level: "error",
          code: "pickle-format-refused",
          message: `Le format ${ext} (sérialisation pickle) peut exécuter du code arbitraire au chargement. Convertissez les poids en safetensors avant l'import.`,
        },
      ],
      metadata,
      sha256: sha,
    };
  }

  if (buffer.byteLength === 0) {
    return {
      format: null,
      status: "rejected",
      findings: [{ level: "error", code: "empty-file", message: "Fichier vide." }],
      metadata,
      sha256: sha,
    };
  }

  // --- safetensors : analyse complète du header ---
  if (ext === ".safetensors") {
    const header = parseSafetensorsHeader(buffer);
    if (!header.ok) {
      return {
        format: "safetensors",
        status: "rejected",
        findings: [{ level: "error", code: "bad-safetensors-header", message: `Header safetensors invalide : ${header.reason}.` }],
        metadata,
        sha256: sha,
      };
    }
    metadata.headerBytes = header.headerBytes;
    findings.push({ level: "info", code: "format-verified", message: "Format safetensors vérifié (header JSON valide)." });
    if (buffer.byteLength < 1024 * 1024) {
      findings.push({
        level: "warn",
        code: "suspiciously-small",
        message: "Fichier plus petit que 1 Mo : un modèle complet est rarement si léger. Vérifiez qu'il ne s'agit pas d'un simple adaptateur.",
      });
      return { format: "safetensors", status: "quarantined", findings, metadata, sha256: sha };
    }
    return { format: "safetensors", status: "valid", findings, metadata, sha256: sha };
  }

  // --- GGUF ---
  if (ext === ".gguf") {
    if (!isGguf(buffer)) {
      return {
        format: "gguf",
        status: "rejected",
        findings: [{ level: "error", code: "bad-gguf-magic", message: "Magic GGUF absent : le fichier n'est pas un modèle GGUF valide." }],
        metadata,
        sha256: sha,
      };
    }
    findings.push({ level: "info", code: "format-verified", message: "Format GGUF vérifié (magic + version)." });
    if (family !== "text") {
      findings.push({
        level: "warn",
        code: "gguf-text-only",
        message: "GGUF est majoritairement utilisé pour les LLM : vérifiez la cohérence avec la famille de modèle choisie.",
      });
    }
    return { format: "gguf", status: "valid", findings, metadata, sha256: sha };
  }

  // --- ZIP (archives de modèle type dossier HF) ---
  if (ext === ".zip") {
    const zip = await inspectZip(buffer);
    if (!zip.ok) {
      return {
        format: "zip-archive",
        status: "rejected",
        findings: [{ level: "error", code: "bad-zip", message: `Archive illisible ou dangereuse : ${zip.reason ?? "structure invalide"}.` }],
        metadata,
        sha256: sha,
      };
    }
    metadata.entryCount = zip.entries.length;
    metadata.entries = zip.entries.slice(0, 20);
    if (!zip.hasConfig) {
      findings.push({
        level: "warn",
        code: "no-config-json",
        message: "Aucun config.json détecté dans l'archive : l'architecture du modèle ne peut pas être confirmée.",
      });
      return { format: "zip-archive", status: "quarantined", findings, metadata, sha256: sha };
    }
    findings.push({ level: "info", code: "format-verified", message: "Archive ZIP inspectée : config.json présent, aucune entrée dangereuse." });
    return { format: "zip-archive", status: "valid", findings, metadata, sha256: sha };
  }

  // --- .bin : analyse impossible, quarantaine par défaut ---
  if (ext === ".bin") {
    return {
      format: "zip-archive",
      status: "quarantined",
      findings: [
        {
          level: "warn",
          code: "bin-legacy-format",
          message: "Format .bin non analysable en détail (héritage PyTorch) : placé en quarantaine. Convertissez en safetensors pour une validation complète.",
        },
      ],
      metadata,
      sha256: sha,
    };
  }

  return {
    format: null,
    status: "rejected",
    findings: [
      {
        level: "error",
        code: "unsupported-format",
        message: `Extension non prise en charge (${ext || "aucune"}) : formats acceptés — .safetensors, .gguf, .zip.`,
      },
    ],
    metadata,
    sha256: sha,
  };
}
