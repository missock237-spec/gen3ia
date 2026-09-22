/**
 * Vector store Qdrant — index vectoriel managé pour la mémoire des agents
 * et la base de connaissances.
 *
 * Architecture : Firestore reste la SOURCE DE VÉRITÉ (documents complets,
 * métadonnées, ACL par userId). Qdrant est un INDEX de recherche vectorielle
 * qui porte : le vecteur (embedding HuggingFace), l'identifiant Firestore du
 * document pointé, et un payload minimal de filtrage (userId, projectId,
 * agentId, documentId). Toute opération est « fail-soft » : si Qdrant est
 * absent ou en erreur, les appelants retombent sur le parcours Firestore +
 * similarité cosinus en mémoire (comportement historique conservé).
 *
 * Collections :
 *  - gen3ia_memories  : mémoires agent/projet (lib/memory)
 *  - gen3ia_knowledge : fragments de documents indexés (lib/knowledge)
 */

import { QdrantClient } from "@qdrant/js-client-rest";

export const VECTOR_COLLECTION_MEMORIES = "gen3ia_memories";
export const VECTOR_COLLECTION_KNOWLEDGE = "gen3ia_knowledge";

/** Dimension par défaut de l'embedding HuggingFace configuré (sentece-transformers MiniLM = 384). */
const DEFAULT_EMBEDDING_DIM = Number(process.env.GEN3IA_EMBEDDING_DIM ?? 384);

let qdrantClient: QdrantClient | null = null;
let clientInitialised = false;

function buildClient(): QdrantClient | null {
  const url = process.env.QDRANT_URL?.trim();
  const apiKey = process.env.QDRANT_API_KEY?.trim();
  if (!url || !apiKey) return null;
  try {
    return new QdrantClient({
      url,
      apiKey,
      // Les fonctions serverless vivent peu : timeout court + pas de check
      // de compatibilité au démarrage (lazy, au premier appel réel).
      timeout: 8_000,
      checkCompatibility: false,
    });
  } catch {
    return null;
  }
}

/** Client partagé, ou null si Qdrant n'est pas configuré. */
export function getQdrant(): QdrantClient | null {
  if (!clientInitialised) {
    qdrantClient = buildClient();
    clientInitialised = true;
  }
  return qdrantClient;
}

export function isVectorStoreConfigured(): boolean {
  return getQdrant() !== null;
}

/**
 * @internal Réservé aux tests : réinitialise le singleton client afin de
 * re-évaluer la configuration d'environnement entre les scénarios.
 */
export function resetVectorClientForTests(): void {
  qdrantClient = null;
  clientInitialised = false;
  ensuredCollections.clear();
}

const ensuredCollections = new Set<string>();

/**
 * Crée la collection si absente, avec la dimension détectée du premier
 * vecteur rencontré (les déploiements changent parfois de modèle
 * d'embedding : la dimension réelle fait foi, la constante n'est qu'une
 * estimation initiale). Idempotent et mémoïsé par processus.
 */
export async function ensureVectorCollection(
  collection: string,
  dimension = DEFAULT_EMBEDDING_DIM,
): Promise<boolean> {
  const client = getQdrant();
  if (!client) return false;
  if (ensuredCollections.has(`${collection}:${dimension}`)) return true;
  try {
    // Client v1.19 : collectionExists retourne { exists: boolean } selon
    // les versions — on normalise les deux formes (booléen ou objet).
    const result = await client.collectionExists(collection);
    const exists = typeof result === "boolean" ? result : Boolean((result as { exists?: boolean })?.exists);
    if (!exists) {
      await client.createCollection(collection, {
        vectors: { size: dimension, distance: "Cosine" },
      });
    }
    // Index de payload OBLIGATOIRES pour le filtrage multi-tenant : sans
    // index keyword, tout filtre match échoue en 400 (« Index required but
    // not found »). userId indexé en premier — c'est le filtre de sécurité
    // présent sur toutes les recherches. Exécuté même si la collection
    // existait déjà (auto-réparation d'une collection créée sans index).
    for (const field of ["userId", "projectId", "agentId", "documentId"]) {
      try {
        await client.createPayloadIndex(collection, {
          field_name: field,
          field_schema: "keyword",
          wait: true,
        });
      } catch {
        // Index déjà présent (création concurrente) : non bloquant.
      }
    }
    ensuredCollections.add(`${collection}:${dimension}`);
    return true;
  } catch {
    // Collision de dimension (collection existante avec un autre size) :
    // Qdrant renverra une erreur à l'upsert ; le caller fail-soft basculera
    // sur Firestore. On ne mémorise pas l'échec pour retenter plus tard.
    return false;
  }
}

export interface VectorPoint {
  /** Identifiant déterministe du point = identifiant du document Firestore. */
  id: string;

  vector: number[];

  payload: Record<string, unknown>;
}

/**
 * Upsert batché. Retourne true si les points sont indexés ; false si Qdrant
 * est absent, en erreur, ou si la dimension ne correspond pas à la
 * collection (repli Firestore assumé par l'appelant).
 */
export async function upsertVectorPoints(
  collection: string,
  points: VectorPoint[],
): Promise<boolean> {
  const client = getQdrant();
  if (!client || points.length === 0) return false;

  const dimension = points[0]?.vector?.length ?? DEFAULT_EMBEDDING_DIM;
  const ready = await ensureVectorCollection(collection, dimension);
  if (!ready) return false;

  try {
    await client.upsert(collection, {
      wait: true,
      points: points.map((point) => ({
        id: point.id,
        vector: point.vector,
        payload: point.payload,
      })),
    });
    return true;
  } catch {
    return false;
  }
}

export interface VectorSearchFilter {
  userId: string;

  projectId?: string;

  agentId?: string;

  documentId?: string;
}

export interface VectorSearchHit {
  id: string;

  score: number;

  payload: Record<string, unknown>;
}

/**
 * Recherche kNN filtrée par payload. Le filtre userId est OBLIGATOIRE :
 * aucune recherche ne peut traverser les données d'un autre utilisateur
 * (sécurité multi-tenant, même garantie que les requêtes Firestore).
 */
export async function searchVectorPoints(
  collection: string,
  vector: number[],
  options: { limit: number; filter: VectorSearchFilter },
): Promise<VectorSearchHit[] | null> {
  const client = getQdrant();
  if (!client) return null;

  const must: Array<Record<string, unknown>> = [
    { key: "userId", match: { value: options.filter.userId } },
  ];
  if (options.filter.projectId) {
    must.push({ key: "projectId", match: { value: options.filter.projectId } });
  }
  if (options.filter.agentId) {
    must.push({ key: "agentId", match: { value: options.filter.agentId } });
  }
  if (options.filter.documentId) {
    must.push({ key: "documentId", match: { value: options.filter.documentId } });
  }

  try {
    // API « query » (client v1.19+) : l'ancien client.search() a été retiré.
    // La recherche nearest-neighbor passe le vecteur via `query`.
    const response = await client.query(collection, {
      query: vector,
      limit: Math.max(1, Math.min(100, options.limit)),
      filter: { must },
      with_payload: true,
    });
    const points = response.points ?? [];
    return points.map((hit) => ({
      id: String(hit.id),
      score: hit.score ?? 0,
      payload: (hit.payload ?? {}) as Record<string, unknown>,
    }));
  } catch {
    return null;
  }
}

/** Supprime les points d'un document (retrait de mémoire / document). */
export async function deleteVectorPoints(
  collection: string,
  ids: string[],
): Promise<boolean> {
  const client = getQdrant();
  if (!client || ids.length === 0) return false;
  try {
    await client.delete(collection, { points: ids, wait: true });
    return true;
  } catch {
    return false;
  }
}

/** Diagnostic : compte les points d'une collection (health checks). */
export async function countVectorPoints(collection: string): Promise<number | null> {
  const client = getQdrant();
  if (!client) return null;
  try {
    const info = await client.getCollection(collection);
    return info.points_count ?? null;
  } catch {
    return null;
  }
}
