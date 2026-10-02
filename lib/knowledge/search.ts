import {
  adminDb,
} from "@/lib/firebase/admin";

import {
  createMemoryEmbedding,
} from "@/lib/memory/embeddings";

import {
  cosineSimilarity,
} from "@/lib/memory/similarity";

import {
  VECTOR_COLLECTION_KNOWLEDGE,
  searchVectorPoints,
} from "@/lib/memory/vector-store";

export interface KnowledgeSearchResult {
  id: string;

  documentId: string;

  text: string;

  chunkIndex: number;

  score: number;
}

/**
 * Recherche dans la base de connaissances.
 *
 * Chemin rapide (Qdrant configuré) : kNN filtré userId + projectId, texte
 * du fragment repris du payload (identique au Firestore : écrit ensemble).
 *
 * Chemin de repli : parcours Firestore (≤ 500 fragments) + cosinus en
 * mémoire — comportement historique, conservé pour la résilience.
 */
/**
 * Périmètre de recherche d'un utilisateur : ses organisations membres
 * (index user→org, résolu SERVEUR). Les appelants (outil agent, moteur de
 * conversation, builder de contexte) le passent tel quel à searchKnowledge
 * — aucun identifiant d'org n'est jamais accepté depuis l'entrée de l'agent.
 */
export async function resolveKnowledgeScope(
  userId: string,
): Promise<string[]> {
  const { listUserOrgIds } = await import("@/lib/tenants/resource-access");
  return listUserOrgIds(userId);
}

export async function searchKnowledge(
  userId: string,
  projectId: string,
  query: string,
  limit = 8,
  orgIds: string[] = [],
): Promise<KnowledgeSearchResult[]> {
  const queryEmbedding =
    await createMemoryEmbedding(
      query,
    );

  const hits =
    await searchVectorPoints(
      VECTOR_COLLECTION_KNOWLEDGE,
      queryEmbedding,
      {
        limit,
        filter: { userId, projectId, orgIds },
      },
    );

  if (hits && hits.length > 0) {
    return hits.map((hit) => ({
      id: hit.id,
      documentId: String(hit.payload.documentId ?? ""),
      text: String(hit.payload.text ?? hit.payload.preview ?? ""),
      chunkIndex: Number(hit.payload.chunkIndex ?? 0),
      score: hit.score,
    }));
  }

  // Repli Firestore : union personnel + organisations (recommandation C),
  // plafonnée comme le chemin historique (500 fragments par portée).
  // Frontière de sécurité : orgIds est résolu SERVEUR depuis l'index
  // user→org de l'appelant ; les requêtes org filtrent par orgId (+ projet)
  // sans filtre userId — les fragments d'une org portent l'userId de leur
  // ingesteur, pas celui du membre qui cherche.
  const scopeOrgs = (orgIds ?? []).filter((orgId) => typeof orgId === "string" && orgId.length > 0);
  const orgChunks: string[][] = [];
  for (let i = 0; i < scopeOrgs.length; i += 30) orgChunks.push(scopeOrgs.slice(i, i + 30));

  const snapshots = await Promise.all([
    adminDb
      .collection("knowledgeChunks")
      .where("userId", "==", userId)
      .where("projectId", "==", projectId)
      .limit(500)
      .get(),
    ...orgChunks.map((ids) =>
      adminDb
        .collection("knowledgeChunks")
        .where("orgId", "in", ids)
        .where("projectId", "==", projectId)
        .limit(500)
        .get(),
    ),
  ]);

  const byId = new Map<string, KnowledgeSearchResult>();
  for (const snapshot of snapshots) {
    for (const doc of snapshot.docs) {
      if (byId.has(doc.id)) continue;
      const data = doc.data();
      byId.set(doc.id, {
        id: doc.id,
        documentId: data.documentId,
        text: data.text,
        chunkIndex: data.chunkIndex,
        score: cosineSimilarity(queryEmbedding, data.embedding ?? []),
      });
    }
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
