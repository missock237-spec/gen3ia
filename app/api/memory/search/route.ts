import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { adminDb } from "@/lib/firebase/admin";
import { searchAgentMemories } from "@/lib/memory/episodic";
import { listMemories } from "@/lib/memory/user-memory";
import { searchKeyValueEntries, mergeMemoryResults, MERGED_RESULTS_MAX } from "@/lib/memory/keyvalue-search";
import { createMemoryEmbedding } from "@/lib/memory/embeddings";
import { cosineSimilarity } from "@/lib/memory/similarity";
import { errorStatus } from "@/lib/security/http-errors";

/**
 * Recherche dans la mémoire de l'utilisateur :
 *  - souvenirs épisodiques / décisions / préférences (collection `memories`,
 *    similarité sémantique par embeddings) → source: "episodic" ;
 *  - souvenirs clé/valeur du panneau « Mémoire permanente » (collection
 *    `userMemories`, recherche sous-chaîne insensible à la casse sur clé et
 *    valeur, scoring exact > préfixe > sous-chaîne) → source: "keyvalue".
 * Les deux univers étaient historiquement déconnectés (les k/v n'étaient
 * jamais retrouvés) : ils sont désormais fusionnés, dédupliqués et plafonnés.
 * La recherche k/v est fail-soft : une panne Firestore k/v ne casse jamais la
 * recherche sémantique déjà disponible.
 */

const SearchSchema = z.object({
  query: z.string().trim().min(2).max(500),
  agentId: z.string().trim().min(1).max(128).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

export const runtime = "nodejs";

/** Recherche k/v fail-soft : renvoie [] si la lecture des souvenirs échoue. */
async function searchKeyValueFailSoft(userId: string, query: string, limit: number) {
  try {
    const entries = await listMemories(userId, 200);
    return searchKeyValueEntries(entries, query, limit);
  } catch {
    return [];
  }
}

async function runMemorySearch(userId: string, input: z.infer<typeof SearchSchema>) {
  const limit = input.limit ?? 8;

  if (input.agentId) {
    const [results, keyValue] = await Promise.all([
      searchAgentMemories(userId, input.agentId, input.query, limit),
      searchKeyValueFailSoft(userId, input.query, limit),
    ]);
    const merged = mergeMemoryResults(
      results.map(({ memory, score }) => ({
        id: memory.id,
        type: memory.type,
        content: memory.content,
        createdAt: memory.createdAt,
        agentId: memory.agentId,
        score: Number(score.toFixed(4)),
        source: "episodic" as const,
      })),
      keyValue,
      Math.min(limit, MERGED_RESULTS_MAX),
    );
    return { results: merged, scope: "agent" as const };
  }

  // Portée globale : tous les souvenirs à embedding de l'utilisateur.
  const [snapshot, queryEmbedding] = await Promise.all([
    adminDb.collection("memories").where("userId", "==", userId).limit(300).get(),
    createMemoryEmbedding(input.query),
  ]);

  const results = snapshot.docs
    .map((doc) => {
      const data = doc.data() as {
        type?: string;
        content?: string;
        createdAt?: string;
        agentId?: string;
        embedding?: number[] | null;
      };
      return {
        id: doc.id,
        type: String(data.type ?? "conversation"),
        content: String(data.content ?? ""),
        createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
        agentId: typeof data.agentId === "string" ? data.agentId : undefined,
        score: Array.isArray(data.embedding) && data.embedding.length > 0
          ? Number(cosineSimilarity(queryEmbedding, data.embedding).toFixed(4))
          : 0,
        source: "episodic" as const,
      };
    })
    .filter((item) => item.score >= 0.3 && item.content.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Les souvenirs clé/valeur du panneau « Mémoire permanente » complètent
  // les résultats épisodiques (fusion + déduplication + plafond commun).
  const keyValue = await searchKeyValueFailSoft(userId, input.query, limit);
  const merged = mergeMemoryResults(
    results,
    keyValue,
    Math.min(limit, MERGED_RESULTS_MAX),
  );

  return { results: merged, scope: "global" as const };
}

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request, { key: "memory-search", rateLimit: { limit: 60, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;

  try {
    const input = SearchSchema.parse(await request.json());
    const { results, scope } = await runMemorySearch(guard.context.userId, input);
    return NextResponse.json({ results, scope }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Recherche mémoire impossible" },
      { status: errorStatus(error, 400) },
    );
  }
}

/**
 * Alias GET propre de la recherche (audit 25-d : seul POST existait, ?q= → 405).
 * Même contrat que POST : ?q=<requête> (ou ?query=), ?agentId=, ?limit=1..20.
 */
export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, { key: "memory-search", rateLimit: { limit: 60, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;

  try {
    const params = request.nextUrl.searchParams;
    const rawLimit = params.get("limit");
    const input = SearchSchema.parse({
      query: params.get("q") ?? params.get("query") ?? "",
      agentId: params.get("agentId") ?? undefined,
      limit: rawLimit === null ? undefined : Number(rawLimit),
    });
    const { results, scope } = await runMemorySearch(guard.context.userId, input);
    return NextResponse.json({ results, scope }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Recherche mémoire impossible" },
      { status: errorStatus(error, 400) },
    );
  }
}
