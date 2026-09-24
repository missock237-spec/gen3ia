import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { assertWorkspaceOwner } from "@/lib/execution/workspace-registry";
import type { ToolDefinition } from "../types";

/**
 * file.delete — suppression RÉELLE d'un fichier de l'espace d'exécution
 * authentifié (workspace), avec protection anti-traversée de chemin.
 *
 * Outil SENSIBLE (risk "destructive") : il ne s'exécute QUE contre une
 * approbation humaine (requiresApproval — voir finaliserPlan et
 * NEVER_AUTO_APPROVE_TOOLS). L'exécuteur sécurisé vérifie l'approbation
 * avant d'appeler ce handler.
 */

const inputSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  filename: z.string().min(1).max(1024),
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

export const deleteFileTool: ToolDefinition = {
  id: "file.delete",
  name: "file.delete",
  description: "Delete a file inside the authenticated execution workspace (destructive — requires human approval) with path traversal protection.",
  category: "files",
  risk: "high",
  inputSchema,
  execute: async (input, context) => {
    const parsed = inputSchema.parse(input);
    const workspace = assertWorkspaceOwner(parsed.workspaceId, context.userId);
    const relative = safeRelativePath(parsed.filename);
    const target = path.resolve(workspace.root, relative);
    const root = path.resolve(workspace.root) + path.sep;
    if (!target.startsWith(root)) throw new Error("Workspace escape detected");
    await fs.unlink(target);
    return { success: true, workspaceId: workspace.id, filename: relative, deleted: true };
  },
};
