import { createHash } from "node:crypto";

import {
  listJson,
  listKeys,
  readJsonIfExists,
  removeKey,
  userKey,
  writeJson,
} from "@/lib/storage/user-data-store";

import { assertSafeMemoryValue } from "./keyvalue";

/**
 * Mémoire conservatoire clé/valeur de l'utilisateur — Task 109 : la source
 * de vérité passe de Firestore (collection `userMemories`) à R2, via la
 * couche fondation `lib/storage/user-data-store` (contrat 109-a).
 *
 * Clé canonique : `users/{uid}/memories/{encodeURIComponent(key)}.json`
 * avec le document `{ v: 1, userId, key, value, source, createdAt, updatedAt }`.
 * `encodeURIComponent` rend la clé sûre comme segment d'objet R2 (les
 * caractères hors `[A-Za-z0-9._-]` — dont `:` autorisé par la validation —
 * sont encodés en `%XX`).
 *
 * Surface d'API STRICTEMENT identique à l'ère Firestore : remember, recall,
 * getMemoryEntry, listMemories, forget. Sémantiques préservées :
 *  - validation de la clé `/^[\p{L}\p{N}._:-]{1,160}$/u` et des valeurs via
 *    assertSafeMemoryValue (lib/memory/keyvalue, inchangé) ;
 *  - MAX_ENTRIES 200 : le comptage Firestore `count()` devient un scan du
 *    préfixe `memories/` plafonné à 250 clés (dès 200 vues, la limite est
 *    atteinte — inutile d'aller plus loin) ;
 *  - écriture « merge » : `createdAt` du premier enregistrement préservé,
 *    les autres champs (value, source, updatedAt) sont réécrits — comme le
 *    `{ merge: true }` historique ;
 *  - recall retourne null si la clé est absente ; getMemoryEntry sert au
 *    contrat anti-écrasement de POST /api/memory ; listMemories trie par
 *    updatedAt desc avec plafond 200.
 */

const MEMORY_SEGMENT = "memories";
const MAX_ENTRIES = 200;
/** Plafond du scan de comptage : au-delà, la limite MAX_ENTRIES est de toute façon atteinte. */
const COUNT_SCAN_CAP = 250;
/** Plafond du scan de listage (cohérent avec le cap par défaut du contrat R2). */
const LIST_SCAN_MAX = 500;

/** Document R2 d'un souvenir clé/valeur. */
interface MemoryDoc {
  v: 1;
  userId: string;
  key: string;
  value: string;
  source: "user" | "agent";
  createdAt: string;
  updatedAt: string;
}

/**
 * Préfixe R2 des souvenirs d'un utilisateur : « users/{uid}/memories/ ».
 * Dérivé de userKey (contrat : userKey(uid, ...segments) =
 * « users/{uid}/{segments.join("/")}.json ») pour rester aligné sur la
 * composition canonique des clés et bénéficier de la validation du uid :
 * userKey(uid, "memories", "sonde") → « users/{uid}/memories/sonde.json ».
 */
function memoriesPrefix(userId: string): string {
  return userKey(userId, MEMORY_SEGMENT, "sonde").slice(0, -"sonde.json".length);
}

/**
 * Clé objet R2 d'un souvenir : le libellé est encodé URL (segment sûr).
 * Un libellé multi-octets long s'encode jusqu'à ~9× sa taille (R2 limite
 * une clé objet à 1024 octets) : au-delà de 200 caractères encodés, le
 * segment devient un SHA-256 hexadécimal préfixé « h- » (déterministe,
 * borné à 66 caractères, la lisibilité restant préservée pour l'usage
 * courant). La clé métier d'origine voyage toujours DANS le document.
 */
function memoryObjectKey(userId: string, key: string): string {
  const encoded = encodeURIComponent(key);
  const segment =
    encoded.length <= 200 ? encoded : `h-${createHash("sha256").update(key, "utf8").digest("hex")}`;
  return userKey(userId, MEMORY_SEGMENT, segment);
}

export async function remember(params: { userId: string; key: string; value: unknown; source?: "user" | "agent"; }): Promise<void> {
  if (!params.userId?.trim()) throw new Error("Memory requires userId.");
  if (!/^[\p{L}\p{N}._:-]{1,160}$/u.test(params.key)) throw new Error("Invalid memory key.");
  const value = assertSafeMemoryValue(params.value);

  const existing = await readJsonIfExists<MemoryDoc>(memoryObjectKey(params.userId, params.key));
  if (!existing) {
    // Contrôle de limite uniquement à la CRÉATION (mettre à jour un souvenir
    // existant reste possible même à 200 — sémantique Firestore conservée).
    const listed = await listKeys(memoriesPrefix(params.userId), { maxObjects: COUNT_SCAN_CAP });
    if (listed.length >= MAX_ENTRIES) {
      throw new Error(`Limite de ${MAX_ENTRIES} souvenirs atteinte. Supprimez-en pour libérer de la place.`);
    }
  }

  const now = new Date().toISOString();
  await writeJson(memoryObjectKey(params.userId, params.key), {
    v: 1,
    userId: params.userId,
    key: params.key,
    value,
    source: params.source ?? "user",
    // Fusion sémantique identique au `{ merge: true }` historique : la date
    // de création d'origine est préservée, updatedAt est rafraîchi.
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  } satisfies MemoryDoc);
}

export async function recall(params: { userId: string; key: string; }): Promise<string | null> {
  const doc = await readJsonIfExists<MemoryDoc>(memoryObjectKey(params.userId, params.key));
  if (!doc) return null;
  return String(doc.value ?? "");
}

/**
 * Lecture unitaire d'un souvenir clé/valeur (sert au contrat anti-écrasement
 * de POST /api/memory : comparer la valeur entrante à l'existante avant
 * d'autoriser l'écriture). Retourne null si la clé est inconnue.
 */
export async function getMemoryEntry(userId: string, key: string): Promise<{ key: string; value: string; source: string; updatedAt?: string } | null> {
  const doc = await readJsonIfExists<MemoryDoc>(memoryObjectKey(userId, key));
  if (!doc) return null;
  return {
    key: String(doc.key ?? key),
    value: String(doc.value ?? ""),
    source: String(doc.source ?? "user"),
    updatedAt: typeof doc.updatedAt === "string" && doc.updatedAt ? doc.updatedAt : undefined,
  };
}

export async function listMemories(userId: string, limit = 100) {
  const plafond = Math.min(Math.max(limit, 1), 200);
  const docs = await listJson<MemoryDoc>(memoriesPrefix(userId), { limit: LIST_SCAN_MAX });
  return docs
    .map((doc) => ({
      key: String(doc.key ?? ""),
      value: String(doc.value ?? ""),
      source: String(doc.source ?? "user"),
      updatedAt: typeof doc.updatedAt === "string" && doc.updatedAt ? doc.updatedAt : undefined,
    }))
    // Tri updatedAt desc (ISO strings : l'ordre lexicographique est l'ordre
    // chronologique). Les docs sans horodatage (improbable) finissent derniers.
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, plafond);
}

export async function forget(userId: string, key: string): Promise<void> {
  // removeKey tolère l'absence (404) : supprimer deux fois reste idempotent.
  await removeKey(memoryObjectKey(userId, key));
}
