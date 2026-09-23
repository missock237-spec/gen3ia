import { NextRequest, NextResponse } from "next/server";

import { protectRoute } from "@/lib/security/route-guard";
import { isRedisConfigured, redisPing } from "@/lib/cache/redis";
import { countVectorPoints, isVectorStoreConfigured, VECTOR_COLLECTION_KNOWLEDGE, VECTOR_COLLECTION_MEMORIES } from "@/lib/memory/vector-store";
import { CONVERSATION_VECTOR_COLLECTION } from "@/lib/chat/vector-index";
import { isSandboxConfigured } from "@/lib/sandbox/simulation";
import { pingR2, type R2HealthStatus } from "@/lib/storage/r2";

export const runtime = "nodejs";

/**
 * Diagnostics d'infrastructure (utilisateur authentifié) — complète la
 * sonde publique /api/public/health qui reste volontairement sans
 * dépendance. Signale l'état réel des couches d'accélération :
 *  - Redis Upstash (rate limit distribué + cache catalogue) ;
 *  - Qdrant (recherche vectorielle mémoire/knowledge) ;
 *  - sandbox Docker (exécution réelle) vs simulation intégrée ;
 *  - stockage R2 (fichiers, pièces jointes, artefacts).
 * Chaque couche dégradée dégrade le service avec repli — jamais de panne.
 *
 * Le champ `storage` reflète la vérité du stockage R2 sans jamais faire
 * crasher la route (audit 25-d : la sonde renvoyait ok:true en ignorant
 * totalement R2, alors qu'une config manquante cassait TOUTES les pièces
 * jointes). Env absentes = { ok: false, reason: "not_configured" }.
 */
export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, { rateLimit: { limit: 30, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;

  const [redis, memoriesCount, knowledgeCount, conversationsCount, storage] = await Promise.all([
    redisPing(),
    isVectorStoreConfigured() ? countVectorPoints(VECTOR_COLLECTION_MEMORIES) : Promise.resolve(null),
    isVectorStoreConfigured() ? countVectorPoints(VECTOR_COLLECTION_KNOWLEDGE) : Promise.resolve(null),
    isVectorStoreConfigured() ? countVectorPoints(CONVERSATION_VECTOR_COLLECTION) : Promise.resolve(null),
    sondeStockageR2(),
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
          [CONVERSATION_VECTOR_COLLECTION]: conversationsCount,
        },
        role: "recherche vectorielle (mémoires, connaissances, historique des conversations — repli : Firestore cosine)",
      },
      sandbox: {
        deployed: isSandboxConfigured(),
        mode: isSandboxConfigured() ? "docker" : "simulation-integree",
        role: "exécution de code / terminal agent",
      },
    },
    // La route reste 200 : le champ reflète la vérité du stockage,
    // c'est lui que la supervision doit surveiller.
    storage,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Sonde R2 protégée : pingR2 ne lève jamais d'exception, mais on garde
 * une double ceinture — le healthcheck ne doit JAMAIS crasher si une
 * dépendance du stockage change de comportement.
 */
async function sondeStockageR2(): Promise<R2HealthStatus> {
  try {
    return await pingR2(3_000);
  } catch {
    return { ok: false, reason: "error" };
  }
}
