import { NextRequest, NextResponse } from "next/server";

import { protectRoute } from "@/lib/security/route-guard";
import { isRedisConfigured, redisPing } from "@/lib/cache/redis";
import { countVectorPoints, isVectorStoreConfigured, VECTOR_COLLECTION_KNOWLEDGE, VECTOR_COLLECTION_MEMORIES } from "@/lib/memory/vector-store";
import { isSandboxConfigured } from "@/lib/sandbox/simulation";

export const runtime = "nodejs";

/**
 * Diagnostics d'infrastructure (utilisateur authentifié) — complète la
 * sonde publique /api/public/health qui reste volontairement sans
 * dépendance. Signale l'état réel des couches d'accélération :
 *  - Redis Upstash (rate limit distribué + cache catalogue) ;
 *  - Qdrant (recherche vectorielle mémoire/knowledge) ;
 *  - sandbox Docker (exécution réelle) vs simulation intégrée.
 * Chaque couche dégradée dégrade le service avec repli — jamais de panne.
 */
export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, { rateLimit: { limit: 30, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;

  const [redis, memoriesCount, knowledgeCount] = await Promise.all([
    redisPing(),
    isVectorStoreConfigured() ? countVectorPoints(VECTOR_COLLECTION_MEMORIES) : Promise.resolve(null),
    isVectorStoreConfigured() ? countVectorPoints(VECTOR_COLLECTION_KNOWLEDGE) : Promise.resolve(null),
  ]);

  return NextResponse.json({
    ok: true,
    layers: {
      redis: {
        configured: isRedisConfigured(),
        ping: redis,
        role: "rate limit distribué + cache catalogue + quotas Gen",
      },
      qdrant: {
        configured: isVectorStoreConfigured(),
        collections: {
          [VECTOR_COLLECTION_MEMORIES]: memoriesCount,
          [VECTOR_COLLECTION_KNOWLEDGE]: knowledgeCount,
        },
        role: "recherche vectorielle (repli : Firestore cosine)",
      },
      sandbox: {
        deployed: isSandboxConfigured(),
        mode: isSandboxConfigured() ? "docker" : "simulation-integree",
        role: "exécution de code / terminal agent",
      },
    },
    timestamp: new Date().toISOString(),
  });
}
