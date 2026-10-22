import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { assertWorkspaceOwner } from "@/lib/execution/workspace-registry";
import type { ToolDefinition } from "../types";

const inputSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  filename: z.string().min(1).max(1024),
  dataBase64: z.string().min(1).max(15_000_000),
  encoding: z.literal("base64").default("base64"),
});

function safeRelativePath(filename: string): string {
  const normalized = filename.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").some((part) => part === "..")) {
    throw new Error("Unsafe workspace path");
  }
  const clean = path.posix.normalize(normalized);
  if (clean === "." || clean.startsWith("../") || clean.includes("/../")) throw new Error("Unsafe workspace path");
  return clean;
}

export const createFileTool: ToolDefinition = {
  id: "file.create",
  name: "file.create",
  description: "Create a file inside the authenticated execution workspace with path traversal protection.",
  category: "files",
  risk: "medium",
  inputSchema,
  execute: async (input, context) => {
    const parsed = inputSchema.parse(input);
    const workspace = await assertWorkspaceOwner(parsed.workspaceId, context.userId);
    const relative = safeRelativePath(parsed.filename);
    const target = path.resolve(workspace.root, relative);
    const root = path.resolve(workspace.root) + path.sep;
    if (!target.startsWith(root)) throw new Error("Workspace escape detected");
    const data = Buffer.from(parsed.dataBase64, "base64");
    if (data.length > 10 * 1024 * 1024) throw new Error("file.create payload exceeds 10 MiB");
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, data, { mode: 0o600, flag: "wx" });

    // LIVRABILITÉ (audit multimodal) : le fichier reste sinon prisonnier du
    // workspace éphémère — aucune pièce jointe téléchargeable dans le chat
    // (l'output { workspaceId, filename } ne produisait JAMAIS d'artefact :
    // artifactFromToolOutput exigeait path/key/storageKey). Copie en
    // stockage PERMANENT du propriétaire → clé retournée → artefact
    // conversation réel + lien de téléchargement. Fail-soft : un incident
    // R2 ne doit PAS faire échouer la création du workspace (le fichier
    // existe, seule la copie permanente manque — signalé honnêtement).
    let storageKey: string | undefined;
    let copiePermanente = false;
    try {
      const { uploadToR2, isR2Configured } = await import("@/lib/storage/r2");
      if (isR2Configured()) {
        const key = `users/${context.userId}/permanent/workspaces/${workspace.id}/${relative}`;
        await uploadToR2(key, data, mimeDepuisExtension(relative));
        storageKey = key;
        copiePermanente = true;
      }
    } catch (erreur) {
      console.warn(
        "[file.create] copie permanente indisponible (le fichier workspace reste créé) :",
        erreur instanceof Error ? erreur.message : String(erreur),
      );
    }

    return {
      success: true,
      workspaceId: workspace.id,
      filename: relative,
      sizeBytes: data.length,
      ...(storageKey ? { storageKey } : {}),
      copiePermanente,
    };
  },
};

/** MIME prudent déduit de l'extension (livraison R2). */
function mimeDepuisExtension(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const table: Record<string, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    csv: "text/csv",
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    html: "text/html",
    htm: "text/html",
    xml: "application/xml",
    zip: "application/zip",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    webm: "video/webm",
  };
  return table[extension] ?? "application/octet-stream";
}
