import { NextRequest, NextResponse } from "next/server";

import { protectRoute } from "@/lib/security/route-guard";
import { isRedisConfigured, redisPing } from "@/lib/cache/redis";
import { countVectorPoints, isVectorStoreConfigured, VECTOR_COLLECTION_KNOWLEDGE, VECTOR_COLLECTION_MEMORIES } from "@/lib/memory/vector-store";
import { CONVERSATION_VECTOR_COLLECTION } from "@/lib/chat/vector-index";
import { isSandboxConfigured } from "@/lib/sandbox/simulation";
import { pingR2, type R2HealthStatus } from "@/lib/storage/r2";
import { summarizeEnv } from "@/lib/env/config-report";
import { getQuotaGuardStats } from "@/lib/db/quota-guard";
import { checkFfmpegAvailable, type FfmpegAvailability } from "@/lib/video/ffmpeg";
import { qstashConfig } from "@/lib/queue/qstash";

export const runtime = "nodejs";

/**
 * Diagnostics d'infrastructure (utilisateur authentifié) — complète la
 * sonde publique /api/public/health qui reste volontairement sans
 * dépendance. Signale l'état réel des couches d'accélération :
 *  - cache process-local (rate limit + micro-caches — Task 108 : le service
 *    externe Redis a été supprimé, la couche est toujours disponible) ;
 *  - Qdrant (recherche vectorielle mémoire/knowledge) ;
 *  - sandbox Docker (exécution réelle) vs simulation intégrée ;
 *  - stockage R2 (fichiers, pièces jointes, artefacts).
 * Chaque couche dégradée dégrade le service avec repli — jamais de panne.
 *
 * Le champ `storage` reflète la vérité du stockage R2 sans jamais faire
 * crasher la route (audit 25-d : la sonde renvoyait ok:true en ignorant
 * totalement R2, alors qu'une config manquante cassait TOUTES les pièces
 * jointes). Env absentes = { ok: false, reason: "not_configured" }.
 *
 * Section `config` (Task 39) : présence par GROUPE de variables (noms
 * manquants uniquement, jamais de valeur) — la supervision voit QUOI est
 * câblé (LLM, téléphonie, voix, ads, facturation, e-mail, stockage) sans
 * exposer le moindre secret. Seul firebase-admin est vital : tout le
 * reste dégrade avec repli assumé.
 */
export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, { rateLimit: { limit: 30, windowMs: 60_000 } });
  if (!guard.ok) return guard.response;

  const [redis, memoriesCount, knowledgeCount, conversationsCount, storage, ffmpeg] = await Promise.all([
    redisPing(),
    isVectorStoreConfigured() ? countVectorPoints(VECTOR_COLLECTION_MEMORIES) : Promise.resolve(null),
    isVectorStoreConfigured() ? countVectorPoints(VECTOR_COLLECTION_KNOWLEDGE) : Promise.resolve(null),
    isVectorStoreConfigured() ? countVectorPoints(CONVERSATION_VECTOR_COLLECTION) : Promise.resolve(null),
    sondeStockageR2(),
    sondeFfmpeg(),
  ]);

  return NextResponse.json({
    ok: true,
    layers: {
      cache: {
        configured: isRedisConfigured(),
        ping: redis,
        role: "cache process-local (rate limit + micro-caches + quotas Gen) — Task 108 : en mémoire, toujours disponible",
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
      // Pipeline vidéo (Task 1-a, additif) : binaire FFmpeg réellement
      // exécutable + mode de continuation des files de rendu/production.
      video: {
        ffmpeg: {
          available: ffmpeg.ffmpeg,
          ffprobe: ffmpeg.ffprobe,
          ...(ffmpeg.version ? { version: ffmpeg.version } : {}),
          ...(ffmpeg.ffmpegSource ? { source: ffmpeg.ffmpegSource } : {}),
          ...(ffmpeg.diagnostic ? { diagnostic: ffmpeg.diagnostic } : {}),
        },
        queueMode: qstashConfig() ? ("qstash" as const) : ("poll" as const),
        role: "rendu vidéo réel (FFmpeg sandboxé) + files rendu/production (QStash ou sondage)",
      },
    },
    // La route reste 200 : le champ reflète la vérité du stockage,
    // c'est lui que la supervision doit surveiller.
    storage,
    // Présence par groupe de capacités (booléens + noms manquants, JAMAIS
    // de valeur) : supervision des fournisseurs sans exposition de secret.
    config: summarizeEnv(),
    // Task 95-b/108 : état du disjoncteur quota Firestore (ouvert = les
    // appels sont court-circuités en erreur quota-classifiée jusqu'à la fin
    // du cooldown ; les files vidéo appliquent leur backoff). Aucune valeur
    // sensible.
    firestoreQuotaGuard: {
      breaker: getQuotaGuardStats(),
    },
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

/**
 * Sonde FFmpeg protégée (Task 1-a, additif) : le healthcheck ne crash pas
 * si la résolution de binaire change — unavailable est un état honnête.
 */
async function sondeFfmpeg(): Promise<FfmpegAvailability> {
  try {
    return await checkFfmpegAvailable();
  } catch {
    return { ffmpeg: false, ffprobe: false };
  }
}
