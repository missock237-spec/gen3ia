import { v5 as uuidV5 } from "uuid";

import {
  listJson,
  newUlid,
  userKey,
  writeJson,
} from "@/lib/storage/user-data-store";

import {
  MemoryRecord,
} from "./types";

import {
  VECTOR_COLLECTION_MEMORIES,
  upsertVectorPoints,
} from "./vector-store";

/**
 * Mémoire épisodique — Task 109 : la source de vérité passe de Firestore
 * (collection `memories`) à R2 via `lib/storage/user-data-store` (contrat
 * 109-a). Clé canonique : `users/{uid}/memory-items/{ulid}.json` avec le
 * document `{ v: 1, id, userId, ...champs épisodiques }` — l'identifiant est
 * un ULID (tri lexicographique des clés = ordre chronologique).
 *
 * Le miroir vectoriel Qdrant (best-effort) est CONSERVÉ tel quel : R2 est la
 * source de vérité, Qdrant n'est qu'un index de recherche. Toute erreur du
 * miroir est absorbée — l'écriture R2 ne doit JAMAIS échouer à cause de
 * l'index (les appelants retombent sur le parcours R2 + cosinus).
 *
 * Surface d'API inchangée : saveMemory, getMemory, listProjectMemories,
 * listAgentMemories.
 */

/** Segment R2 des items épisodiques sous le dossier utilisateur. */
const ITEMS_SEGMENT = "memory-items";

/** Plafond du scan de listage (cohérent avec le cap par défaut du contrat R2). */
const LIST_SCAN_MAX = 500;

/** Espace de noms UUID v5 Gen3ia : IDs de points Qdrant déterministes (même convention que lib/chat/vector-index). */
const GEN3IA_POINT_NAMESPACE = "6f1c2a34-9b7e-4d58-a1f0-2c9d4e7b8a11";

/** Document R2 d'un item épisodique : l'enregistrement + le tag de version. */
type MemoryDoc = MemoryRecord & { v: 1 };

/**
 * Préfixe R2 des items épisodiques d'un utilisateur : « users/{uid}/memory-items/ ».
 * Dérivé de userKey (contrat : userKey(uid, ...segments) =
 * « users/{uid}/{segments.join("/")}.json ») pour rester aligné sur la
 * composition canonique des clés et bénéficier de la validation du uid.
 */
function memoryItemsPrefix(userId: string): string {
  return userKey(userId, ITEMS_SEGMENT, "sonde").slice(0, -"sonde.json".length);
}

/** Retire le tag de version interne avant de rendre un MemoryRecord aux appelants. */
function toRecord(doc: MemoryDoc): MemoryRecord {
  const { v: _v, ...record } = doc;
  return record as MemoryRecord;
}

/**
 * Miroir vectoriel best-effort : R2 reste la source de vérité,
 * Qdrant accélère la recherche sémantique. Toute erreur est absorbée
 * (l'écriture R2 ne doit JAMAIS échouer à cause de l'index).
 */
async function mirrorMemoryToVectorStore(memory: MemoryRecord): Promise<void> {
  if (!memory.embedding || memory.embedding.length === 0) return;
  try {
    await upsertVectorPoints(VECTOR_COLLECTION_MEMORIES, [
      {
        // Qdrant n'accepte que des entiers ou des UUID : l'ULID est dérivé en
        // UUID v5 déterministe (réindexer un souvenir écrase son point au lieu
        // d'en créer un doublon). L'identifiant réel voyage dans le payload.
        id: uuidV5(memory.id, GEN3IA_POINT_NAMESPACE),
        vector: memory.embedding,
        payload: {
          userId: memory.userId,
          projectId: memory.projectId ?? null,
          agentId: memory.agentId ?? null,
          memoryId: memory.id,
          type: memory.type ?? null,
          // Aperçu court pour l'affichage des hits sans re-lire R2.
          preview: (memory.content ?? "").slice(0, 240),
        },
      },
    ]);
  } catch {
    // Fail-soft assumé : la recherche retombera sur le parcours R2 (listJson
    // + similarité cosinus en mémoire).
  }
}

export async function saveMemory(
  memory: MemoryRecord,
): Promise<void> {
  // Source de vérité R2 : l'identifiant d'un item épisodique est un ULID
  // fraîchement généré. Réassignation EN PLACE : writeMemory (service.ts)
  // retourne l'objet passé, l'appelant doit voir l'identifiant réellement
  // stocké — et la clé objet porte ce même ULID.
  memory.id = newUlid();

  const now = new Date().toISOString();
  const doc = {
    v: 1 as const,
    ...memory,
    embedding: memory.embedding ?? null,
    createdAt: memory.createdAt ?? now,
    updatedAt: now,
  };

  await writeJson(userKey(memory.userId, ITEMS_SEGMENT, memory.id), doc);

  // Miroir vectoriel (best-effort, après la persistance R2).
  await mirrorMemoryToVectorStore(memory);
}

/**
 * Historique Firestore : lecture directe par identifiant global.
 * R2 : la clé dépend du userId (« users/{uid}/memory-items/{ulid}.json ») —
 * un identifiant seul ne permet plus de résoudre l'objet sans scanner tous
 * les comptes (interdit multi-tenant). La fonction retourne donc null :
 * l'unique appelant (lib/memory/search.ts, chemin rapide Qdrant) dispose
 * déjà d'un repli par parcours utilisateur + cosinus, qui reste correct.
 */
export async function getMemory(
  _memoryId: string,
): Promise<MemoryRecord | null> {
  return null;
}

/**
 * Parcours filtré des items épisodiques d'un utilisateur : scan du préfixe
 * « memory-items/ » (cap 500), filtre en mémoire, tri createdAt desc,
 * plafond limit — mêmes filtres/limites que les requêtes Firestore.
 */
async function listFiltered(
  userId: string,
  predicate: (doc: MemoryDoc) => boolean,
  limit: number,
): Promise<MemoryRecord[]> {
  const docs = await listJson<MemoryDoc>(memoryItemsPrefix(userId), { limit: LIST_SCAN_MAX });
  return docs
    .filter(predicate)
    // Tri createdAt desc (ISO strings : ordre lexicographique = chronologique).
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, Math.max(0, limit))
    .map(toRecord);
}

export async function listProjectMemories(
  userId: string,
  projectId: string,
  limit = 100,
): Promise<MemoryRecord[]> {
  return listFiltered(userId, (doc) => doc.projectId === projectId, limit);
}

export async function listAgentMemories(
  userId: string,
  agentId: string,
  limit = 200,
): Promise<MemoryRecord[]> {
  return listFiltered(userId, (doc) => doc.agentId === agentId, limit);
}
