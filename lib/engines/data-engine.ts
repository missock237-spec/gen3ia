import "server-only";
import type { Query } from "firebase-admin/firestore";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { cacheGet, cacheSet } from "@/lib/cache/redis";
import { epochNow } from "./types";

/**
 * Moteur 6 — Data Engine.
 *
 * Stockage unifié des enregistrements métier des modules (factures, congés,
 * actifs de maintenance, demandes RGPD…). Chaque module passe une
 * `collection` logique (ex. `financeInvoices`) ; le moteur garantit :
 *  - l'isolation par propriétaire (`userId` obligatoire, vérifié au retour) ;
 *  - un nom de collection contraint (protection contre l'injection d'accès) ;
 *  - un cache Redis partagé sur les listes (TTL court, invalidé à l'écriture)
 *    — réutilise l'infrastructure Upstash mise en place en Task 14.
 *
 * Les données libres du module vivent sous le champ `data` (objet validé par
 * le schéma zod du module avant l'appel — le moteur ne seconde-guess pas).
 */

export const DATA_COLLECTION_RE = /^[a-z][a-zA-Z0-9_]{2,48}$/;

const CreateRecordSchema = z.object({
  userId: z.string().min(1).max(128),
  collection: z.string().regex(DATA_COLLECTION_RE, "Nom de collection métier invalide."),
  data: z.record(z.string(), z.unknown()),
});

export interface BusinessRecord {
  id: string;
  userId: string;
  collection: string;
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ListRecordsFilter {
  field: string;
  op: "eq" | "neq" | "in" | "gte" | "lte";
  value: unknown;
}

export interface ListRecordsOptions {
  userId: string;
  collection: string;
  filters?: ListRecordsFilter[];
  orderBy?: { field: string; direction: "asc" | "desc" };
  limit?: number;
  /** Bypass du cache Redis (lecture fraîche, ex. juste après une écriture). */
  fresh?: boolean;
}

const LIST_CACHE_TTL_SECONDS = 30;
const VERSION_TTL_SECONDS = 24 * 60 * 60;

/**
 * Invalidations : Redis DEL ne supporte pas les patterns, on utilise donc un
 * compteur de version par collection+utilisateur. Chaque écriture incrémente
 * la version — toutes les clés de liste antérieures deviennent inaccessibles
 * (et expirent seules). Si Redis est indisponible, le cache est simplement
 * court-circuité (dégradation gracieuse de lib/cache/redis).
 */
async function bumpCollectionVersion(userId: string, collection: string): Promise<void> {
  const key = `data:ver:${collection}:${userId}`;
  const current = await cacheGet<number>(key);
  const next = (typeof current === "number" ? current : 0) + 1;
  await cacheSet(key, next, VERSION_TTL_SECONDS).catch(() => false);
}

async function collectionVersion(userId: string, collection: string): Promise<number> {
  const current = await cacheGet<number>(`data:ver:${collection}:${userId}`);
  return typeof current === "number" ? current : 0;
}

function cacheKeyFor(userId: string, collection: string, version: number, options: ListRecordsOptions): string {
  // Le cache tient compte des filtres/ordre pour ne jamais servir une liste
  // qui ne correspondrait pas à la requête exacte.
  return `data:list:${collection}:${userId}:v${version}:${JSON.stringify({ filters: options.filters ?? [], orderBy: options.orderBy ?? null, limit: options.limit ?? null })}`;
}

function assertCollection(collection: string): void {
  if (!DATA_COLLECTION_RE.test(collection)) {
    throw new Error(`Collection métier interdite : ${collection}`);
  }
}

export async function createRecord(input: z.input<typeof CreateRecordSchema>): Promise<BusinessRecord> {
  const parsed = CreateRecordSchema.parse(input);
  assertCollection(parsed.collection);
  const now = epochNow();
  const ref = adminDb.collection(parsed.collection).doc();
  const record: BusinessRecord = {
    id: ref.id,
    userId: parsed.userId,
    collection: parsed.collection,
    data: parsed.data,
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(record);
  await bumpCollectionVersion(parsed.userId, parsed.collection);
  return record;
}

export async function getRecord(collection: string, userId: string, id: string): Promise<BusinessRecord | null> {
  assertCollection(collection);
  const snap = await adminDb.collection(collection).doc(id).get();
  if (!snap.exists) return null;
  const record = snap.data() as BusinessRecord;
  // Isolation stricte : un document d'un autre propriétaire est "introuvable".
  return record.userId === userId ? record : null;
}

export async function updateRecord(
  collection: string,
  userId: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<BusinessRecord> {
  assertCollection(collection);
  const existing = await getRecord(collection, userId, id);
  if (!existing) throw new Error("Enregistrement introuvable.");
  const nextData = { ...existing.data, ...patch };
  const now = epochNow();
  await adminDb
    .collection(collection)
    .doc(id)
    .update({ data: nextData, updatedAt: now });
  await bumpCollectionVersion(userId, collection);
  return { ...existing, data: nextData, updatedAt: now };
}

export async function deleteRecord(collection: string, userId: string, id: string): Promise<boolean> {
  assertCollection(collection);
  const existing = await getRecord(collection, userId, id);
  if (!existing) return false;
  await adminDb.collection(collection).doc(id).delete();
  await bumpCollectionVersion(userId, collection);
  return true;
}

export async function listRecords(options: ListRecordsOptions): Promise<BusinessRecord[]> {
  assertCollection(options.collection);
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 250);
  const version = await collectionVersion(options.userId, options.collection);
  const cacheKey = cacheKeyFor(options.userId, options.collection, version, { ...options, limit });

  if (!options.fresh) {
    const cached = await cacheGet<BusinessRecord[]>(cacheKey);
    if (cached && Array.isArray(cached)) return cached;
  }

  let query: Query = adminDb.collection(options.collection).where("userId", "==", options.userId);
  for (const filter of options.filters ?? []) {
    switch (filter.op) {
      case "eq":
        query = query.where(filter.field, "==", filter.value);
        break;
      case "neq":
        query = query.where(filter.field, "!=", filter.value);
        break;
      case "in":
        query = query.where(filter.field, "in", filter.value);
        break;
      case "gte":
        query = query.where(filter.field, ">=", filter.value);
        break;
      case "lte":
        query = query.where(filter.field, "<=", filter.value);
        break;
    }
  }
  if (options.orderBy) {
    query = query.orderBy(options.orderBy.field, options.orderBy.direction);
  }
  query = query.limit(limit);

  const snap = await query.get();
  const records = snap.docs.map((doc) => doc.data() as BusinessRecord);

  await cacheSet(cacheKey, records, LIST_CACHE_TTL_SECONDS).catch(() => false);
  return records;
}

/** Comptage léger côté serveur (KPI), sans charger les documents. */
export async function countRecords(collection: string, userId: string, field = "userId"): Promise<number> {
  assertCollection(collection);
  const snap = await adminDb
    .collection(collection)
    .where(field, "==", userId)
    .count()
    .get();
  return snap.data().count;
}

/**
 * Déplie un enregistrement pour l'UI : `{ id, ...data, createdAt, updatedAt }`.
 * Convention de toutes les routes /api/business/*.
 */
export function unfoldRecord(record: BusinessRecord): Record<string, unknown> {
  return { id: record.id, ...record.data, createdAt: record.createdAt, updatedAt: record.updatedAt };
}
