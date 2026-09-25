import "server-only";

import { randomUUID } from "crypto";

import { adminDb } from "@/lib/firebase/admin";

/**
 * API personnelles Gen3ia — un utilisateur peut déclarer SES propres API
 * (URL de base + authentification) depuis le chat ou la page Intégrations.
 * Une fois activées, les agents et la conversation les appellent RÉELLEMENT
 * (fetch serveur) via les outils custom_api.call / custom_api.write.
 *
 * Stockage Firestore — collection `customApis` (accès serveur uniquement) :
 * les clés fournies par l'utilisateur sont nécessaires côté serveur pour
 * signer les appels réels ; elles ne sortent jamais vers le client.
 */

export type CustomApiAuthType = "none" | "bearer" | "header" | "query";

export interface CustomApiRecord {
  id: string;
  userId: string;
  /** Nom lisible utilisé par le planificateur pour cibler l'API. */
  name: string;
  baseUrl: string;
  description?: string;
  authType: CustomApiAuthType;
  /** Nom d'en-tête personnalisé (authType=header). Défaut : Authorization. */
  authHeader?: string;
  /** Valeur du secret (bearer/header). */
  authValue?: string;
  /** Nom du paramètre d'URL (authType=query). */
  queryKey?: string;
  enabled: boolean;
  /** Source de la création (chat ou formulaire). */
  source: "chat" | "form";
  lastCallAt?: string;
  lastCallStatus?: "success" | "failed";
  lastCallHttp?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCustomApiInput {
  userId: string;
  name: string;
  baseUrl: string;
  description?: string;
  authType?: CustomApiAuthType;
  authHeader?: string;
  authValue?: string;
  queryKey?: string;
  enabled?: boolean;
  source?: "chat" | "form";
}

const COLLECTION = "customApis";
export const MAX_CUSTOM_APIS = 25;

/** Nom canonique pour le ciblage par le planificateur (minuscule, espaces compactés). */
export function normalizeApiName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

function sanitize(value: string, max: number): string {
  return value.trim().slice(0, max);
}

export async function createCustomApi(input: CreateCustomApiInput): Promise<CustomApiRecord> {
  const now = new Date().toISOString();
  const existing = await listCustomApis(input.userId);
  if (existing.length >= MAX_CUSTOM_APIS) {
    throw new Error(`Vous avez atteint la limite de ${MAX_CUSTOM_APIS} API personnelles. Supprimez-en une pour en ajouter une nouvelle.`);
  }
  const record: CustomApiRecord = {
    id: randomUUID(),
    userId: input.userId,
    name: sanitize(input.name, 120),
    baseUrl: sanitize(input.baseUrl, 500).replace(/\/+$/, ""),
    ...(input.description?.trim() ? { description: sanitize(input.description, 600) } : {}),
    authType: input.authType ?? "none",
    ...(input.authType === "header" ? { authHeader: sanitize(input.authHeader ?? "Authorization", 80) } : {}),
    ...(input.authValue?.trim() ? { authValue: sanitize(input.authValue, 2000) } : {}),
    ...(input.authType === "query" ? { queryKey: sanitize(input.queryKey ?? "api_key", 80) } : {}),
    enabled: input.enabled ?? true,
    source: input.source ?? "form",
    createdAt: now,
    updatedAt: now,
  };
  await adminDb.collection(COLLECTION).doc(record.id).set(record);
  return record;
}

function toRecord(id: string, data: Record<string, unknown>): CustomApiRecord | null {
  if (!data || typeof data.userId !== "string" || typeof data.baseUrl !== "string") return null;
  return {
    id,
    userId: data.userId,
    name: typeof data.name === "string" ? data.name : "API",
    baseUrl: data.baseUrl,
    ...(typeof data.description === "string" ? { description: data.description } : {}),
    authType: (data.authType as CustomApiAuthType) ?? "none",
    ...(typeof data.authHeader === "string" ? { authHeader: data.authHeader } : {}),
    ...(typeof data.authValue === "string" ? { authValue: data.authValue } : {}),
    ...(typeof data.queryKey === "string" ? { queryKey: data.queryKey } : {}),
    enabled: data.enabled !== false,
    source: data.source === "chat" ? "chat" : "form",
    ...(typeof data.lastCallAt === "string" ? { lastCallAt: data.lastCallAt } : {}),
    ...(data.lastCallStatus === "success" || data.lastCallStatus === "failed" ? { lastCallStatus: data.lastCallStatus } : {}),
    ...(typeof data.lastCallHttp === "number" ? { lastCallHttp: data.lastCallHttp } : {}),
    ...(typeof data.createdAt === "string" ? { createdAt: data.createdAt } : { createdAt: new Date(0).toISOString() }),
    ...(typeof data.updatedAt === "string" ? { updatedAt: data.updatedAt } : { updatedAt: new Date(0).toISOString() }),
  };
}

export async function listCustomApis(userId: string): Promise<CustomApiRecord[]> {
  let docs: Array<{ id: string; data: () => Record<string, unknown> }>;
  try {
    const snapshot = await adminDb
      .collection(COLLECTION)
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(MAX_CUSTOM_APIS)
      .get();
    docs = snapshot.docs;
  } catch {
    // Repli sans index composé (orderBy) : tri applicatif ensuite.
    const snapshot = await adminDb.collection(COLLECTION).where("userId", "==", userId).limit(MAX_CUSTOM_APIS).get();
    docs = snapshot.docs;
  }
  const records = docs
    .map((doc) => toRecord(doc.id, doc.data() as Record<string, unknown>))
    .filter((r): r is CustomApiRecord => r !== null);
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listEnabledCustomApis(userId: string, limit = 12): Promise<CustomApiRecord[]> {
  const all = await listCustomApis(userId);
  return all.filter((api) => api.enabled).slice(0, limit);
}

export async function getCustomApi(userId: string, id: string): Promise<CustomApiRecord | null> {
  const doc = await adminDb.collection(COLLECTION).doc(id).get();
  if (!doc.exists) return null;
  const record = toRecord(doc.id, doc.data() as Record<string, unknown>);
  return record && record.userId === userId ? record : null;
}

/** Ciblage par nom (tolérant : égalité normalisée d'abord, inclusion ensuite). */
export async function findCustomApiByName(userId: string, name: string): Promise<CustomApiRecord | null> {
  const wanted = normalizeApiName(name);
  if (!wanted) return null;
  const all = await listCustomApis(userId);
  const exact = all.find((api) => normalizeApiName(api.name) === wanted);
  if (exact) return exact;
  return (
    all.find((api) => {
      const normalized = normalizeApiName(api.name);
      return normalized.includes(wanted) || wanted.includes(normalized);
    }) ?? null
  );
}

export interface UpdateCustomApiPatch {
  name?: string;
  baseUrl?: string;
  description?: string;
  authType?: CustomApiAuthType;
  authHeader?: string;
  authValue?: string;
  queryKey?: string;
  enabled?: boolean;
}

export async function updateCustomApi(userId: string, id: string, patch: UpdateCustomApiPatch): Promise<CustomApiRecord | null> {
  const current = await getCustomApi(userId, id);
  if (!current) return null;
  const next: CustomApiRecord = {
    ...current,
    ...(patch.name?.trim() ? { name: sanitize(patch.name, 120) } : {}),
    ...(patch.baseUrl?.trim() ? { baseUrl: sanitize(patch.baseUrl, 500).replace(/\/+$/, "") } : {}),
    ...(patch.description !== undefined ? { ...(sanitize(patch.description, 600) ? { description: sanitize(patch.description, 600) } : { description: undefined }) } : {}),
    ...(patch.authType ? { authType: patch.authType } : {}),
    ...(patch.authType === "header" || (!patch.authType && current.authType === "header")
      ? { authHeader: sanitize(patch.authHeader ?? current.authHeader ?? "Authorization", 80) }
      : {}),
    ...(patch.authType === "query" || (!patch.authType && current.authType === "query")
      ? { queryKey: sanitize(patch.queryKey ?? current.queryKey ?? "api_key", 80) }
      : {}),
    ...(patch.authValue !== undefined ? { ...(sanitize(patch.authValue, 2000) ? { authValue: sanitize(patch.authValue, 2000) } : { authValue: undefined }) } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    updatedAt: new Date().toISOString(),
  };
  await adminDb.collection(COLLECTION).doc(id).set(next);
  return next;
}

/** Trace best-effort du dernier appel réel (jamais bloquant). */
export async function touchCustomApiCall(id: string, status: "success" | "failed", httpStatus?: number): Promise<void> {
  try {
    await adminDb.collection(COLLECTION).doc(id).update({
      lastCallAt: new Date().toISOString(),
      lastCallStatus: status,
      ...(typeof httpStatus === "number" ? { lastCallHttp: httpStatus } : {}),
      updatedAt: new Date().toISOString(),
    });
  } catch {
    /* la trace ne doit jamais faire échouer l'appel réel */
  }
}

export async function deleteCustomApi(userId: string, id: string): Promise<boolean> {
  const current = await getCustomApi(userId, id);
  if (!current) return false;
  await adminDb.collection(COLLECTION).doc(id).delete();
  return true;
}
