import { randomUUID } from "node:crypto";
import { FieldValue, type DocumentData } from "firebase-admin/firestore";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";

/**
 * Serveurs MCP (Model Context Protocol) déclarés par l'utilisateur.
 * Chaque serveur est un endpoint HTTP « streamable » contrôlé par le
 * propriétaire du compte : Gen3ia y découvre des outils (tools/list) et
 * les exécute (tools/call) dans le cadre des missions de ses agents.
 * Les en-têtes (authentification) sont chiffrés à la lecture : ils ne sont
 * jamais renvoyés en clair au client.
 */

const COLLECTION = "mcpServers";
export const MAX_SERVERS_PER_USER = 10;

export const McpServerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  url: z.string().trim().url().max(2_000),
  headers: z.record(z.string().trim().min(1).max(120), z.string().trim().min(1).max(2_000)).default({}),
  enabled: z.boolean().default(true),
});

export type McpServerInput = z.infer<typeof McpServerSchema>;

export interface McpServer {
  id: string;
  userId: string;
  name: string;
  url: string;
  enabled: boolean;
  tools: Array<{ name: string; description: string }>;
  lastSyncAt?: string;
  lastError?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Masque les valeurs d'en-têtes avant exposition au client (jamais en clair). */
export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    masked[key] = value ? `${value.slice(0, 4)}…${value.slice(-2)}` : "";
  }
  return masked;
}

export async function countUserServers(userId: string): Promise<number> {
  const snap = await adminDb.collection(COLLECTION).where("userId", "==", userId).count().get();
  return snap.data().count;
}

export async function saveServer(userId: string, input: McpServerInput, tools: Array<{ name: string; description: string }>): Promise<string> {
  const id = randomUUID();
  const now = FieldValue.serverTimestamp();
  await adminDb.collection(COLLECTION).doc(id).set({
    ...input,
    tools,
    userId,
    lastSyncAt: new Date().toISOString(),
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function listServers(userId: string): Promise<McpServer[]> {
  const snap = await adminDb.collection(COLLECTION).where("userId", "==", userId).limit(100).get();
  return snap.docs
    .map((doc) => serialize(doc.id, doc.data()))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getServer(userId: string, id: string): Promise<McpServer | null> {
  const snap = await adminDb.collection(COLLECTION).doc(id).get();
  if (!snap.exists || snap.data()?.userId !== userId) return null;
  return serialize(id, snap.data()!);
}

/** Récupère le serveur AVEC ses en-têtes complets (usage serveur uniquement). */
export async function getServerWithHeaders(userId: string, id: string): Promise<{ server: McpServer; headers: Record<string, string> } | null> {
  const snap = await adminDb.collection(COLLECTION).doc(id).get();
  if (!snap.exists || snap.data()?.userId !== userId) return null;
  const data = snap.data()!;
  return {
    server: serialize(id, data),
    headers: (data.headers as Record<string, string>) ?? {},
  };
}

export async function updateServerTools(userId: string, id: string, tools: Array<{ name: string; description: string }>): Promise<void> {
  await adminDb.collection(COLLECTION).doc(id).update({
    tools,
    lastSyncAt: new Date().toISOString(),
    lastError: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function updateServerError(userId: string, id: string, error: string): Promise<void> {
  await adminDb.collection(COLLECTION).doc(id).update({
    lastError: error.slice(0, 500),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function setServerEnabled(userId: string, id: string, enabled: boolean): Promise<void> {
  await adminDb.collection(COLLECTION).doc(id).update({
    enabled,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function deleteServer(userId: string, id: string): Promise<boolean> {
  const ref = adminDb.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.userId !== userId) return false;
  await ref.delete();
  return true;
}

function serialize(id: string, data: DocumentData): McpServer {
  const tools = Array.isArray(data.tools) ? data.tools : [];
  return {
    id,
    userId: String(data.userId),
    name: String(data.name ?? "Serveur MCP"),
    url: String(data.url ?? ""),
    enabled: data.enabled !== false,
    tools: tools
      .filter((tool): tool is { name: string; description: string } =>
        Boolean(tool) && typeof (tool as { name?: unknown }).name === "string")
      .map((tool) => ({
        name: String(tool.name),
        description: typeof tool.description === "string" ? tool.description : "",
      })),
    lastSyncAt: typeof data.lastSyncAt === "string" ? data.lastSyncAt : undefined,
    lastError: typeof data.lastError === "string" ? data.lastError : undefined,
  };
}
