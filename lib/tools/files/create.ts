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
    return { success: true, workspaceId: workspace.id, filename: relative, sizeBytes: data.length };
  },
};
