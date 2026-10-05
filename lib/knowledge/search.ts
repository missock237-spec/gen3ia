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
  isVectorStoreConfigured,
  searchVectorPoints,
} from "@/lib/memory/vector-store";

/**
 * Plafond du repli Firestore quand Qdrant n'est PAS configuré (chemin
 * récurrent, pas un incident) : 100 fragments AU TOTAL, répartis entre les
 * portées (personnel + organisations). L'ancien plafond (500 par portée,
 * jusqu'à 1 000+ lectures par recherche) n'est conservé que pour le repli
 * sur ERREUR Qdrant transitoire — résilience maximale quand le chemin
 * rapide devait fonctionner.
 */
const FALLBACK_TOTAL_LIMIT = 100;
const FALLBACK_ERROR_LIMIT = 500;

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
 * Chemin de repli (Qdrant non configuré OU en erreur uniquement) : parcours
 * Firestore + cosinus en mémoire. Si Qdrant a répondu (même 0 hit), le
 * résultat est légitime — AUCUN repli (l'ancien comportement scannait la
 * base Firestore dès 0 hit, même avec Qdrant sain : quota brûlé pour rien).
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

  // Qdrant configuré ? Sinon pas d'appel vectoriel du tout (le client
  // répondrait null) — et surtout : null = « pas de réponse » (non
  // configuré OU erreur), [] = « réponse légitime sans hit ».
  const qdrantConfigured = isVectorStoreConfigured();
  const hits = qdrantConfigured
    ? await searchVectorPoints(
        VECTOR_COLLECTION_KNOWLEDGE,
        queryEmbedding,
        {
          limit,
          filter: { userId, projectId, orgIds },
        },
      )
    : null;

  if (hits) {
    // Qdrant a RÉPONDU : 0 hit est un résultat légitime (index vide pour ce
    // périmètre) — aucun repli Firestore, la réponse est retournée telle
    // quelle (économie de quota : le repli coûtait jusqu'à 1 000+ lectures).
    return hits.map((hit) => ({
      id: hit.id,
      documentId: String(hit.payload.documentId ?? ""),
      text: String(hit.payload.text ?? hit.payload.preview ?? ""),
      chunkIndex: Number(hit.payload.chunkIndex ?? 0),
      score: hit.score,
    }));
  }

  // Repli Firestore (Qdrant non configuré OU en erreur) : union personnel
  // + organisations (recommandation C).
  // Frontière de sécurité : orgIds est résolu SERVEUR depuis l'index
  // user→org de l'appelant ; les requêtes org filtrent par orgId (+ projet)
  // sans filtre userId — les fragments d'une org portent l'userId de leur
  // ingesteur, pas celui du membre qui cherche.
  const scopeOrgs = (orgIds ?? []).filter((orgId) => typeof orgId === "string" && orgId.length > 0);
  const orgChunks: string[][] = [];
  for (let i = 0; i < scopeOrgs.length; i += 30) orgChunks.push(scopeOrgs.slice(i, i + 30));

  // Plafond de lecture : réparti équitablement entre les portées (1
  // personnelle + N requêtes org) — Qdrant non configuré = 100 fragments
  // AU TOTAL ; erreur Qdrant transitoire = limites historiques (500 par
  // portée) pour la résilience maximale sur un incident.
  const snapshotCount = 1 + orgChunks.length;
  const perScopeLimit = qdrantConfigured
    ? FALLBACK_ERROR_LIMIT
    : Math.max(1, Math.floor(FALLBACK_TOTAL_LIMIT / snapshotCount));

  const snapshots = await Promise.all([
    adminDb
      .collection("knowledgeChunks")
      .where("userId", "==", userId)
      .where("projectId", "==", projectId)
      .limit(perScopeLimit)
      .get(),
    ...orgChunks.map((ids) =>
      adminDb
        .collection("knowledgeChunks")
        .where("orgId", "in", ids)
        .where("projectId", "==", projectId)
        .limit(perScopeLimit)
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
