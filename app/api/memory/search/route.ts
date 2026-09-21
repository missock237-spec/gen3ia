import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { adminDb } from "@/lib/firebase/admin";
import { searchAgentMemories } from "@/lib/memory/episodic";
import { createMemoryEmbedding } from "@/lib/memory/embeddings";
import { cosineSimilarity } from "@/lib/memory/similarity";

/**
 * Recherche sémantique dans la mémoire (souvenirs épisodiques, décisions,
 * préférences) — scopée à un agent (agentId) ou globale à tous les souvenirs
 * de l'utilisateur (agentId absent).
 */

const SearchSchema = z.object({
  query: z.string().trim().min(2).max(500),
  agentId: z.string().trim().min(1).max(128).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request, { key: "memory-search", rateLimit: { limit: 60, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;

  try {
    const input = SearchSchema.parse(await request.json());
    const limit = input.limit ?? 8;

    if (input.agentId) {
      const results = await searchAgentMemories(guard.context.userId, input.agentId, input.query, limit);
      return NextResponse.json({
        results: results.map(({ memory, score }) => ({
          id: memory.id,
          type: memory.type,
          content: memory.content,
          createdAt: memory.createdAt,
          agentId: memory.agentId,
          score: Number(score.toFixed(4)),
        })),
        scope: "agent",
      }, { headers: { "cache-control": "no-store" } });
    }

    // Portée globale : tous les souvenirs à embedding de l'utilisateur.
    const [snapshot, queryEmbedding] = await Promise.all([
      adminDb.collection("memories").where("userId", "==", guard.context.userId).limit(300).get(),
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
        };
      })
      .filter((item) => item.score >= 0.3 && item.content.length > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return NextResponse.json({ results, scope: "global" }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Recherche mémoire impossible" },
      { status: 400 },
    );
  }
}
