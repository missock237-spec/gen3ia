import { NextRequest, NextResponse } from "next/server";

import { errorStatus } from "@/lib/security/http-errors";
import { timingSafeStringEqual } from "@/lib/security/timing-safe";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;

  const authorization = request.headers.get("authorization") ?? "";
  // Comparaison à temps constant (pas de court-circuit exploitable).
  return timingSafeStringEqual(authorization, `Bearer ${secret}`);
}

/**
 * CRON Knowledge Ingest — consommation du corpus de scraping (auto-apprentissage).
 *
 * ARCHITECTURE DÉCOUPLÉE (pipeline/README.md) : le daemon PM2
 * `gen3ia-pipeline` (process de fond) scrape le web en continu et écrit
 * des documents JSONL en append-only dans var/pipeline/output.jsonl.
 * CE process (le serveur d'inférence) reste 100 % disponible pour les
 * utilisateurs : il ne fait qu'ingérer, par lots plafonnés (60 docs /
 * 240 s), le fichier partagé — Firestore + indexation vectorielle
 * Qdrant, sous le périmètre global `gen3ia-corpus` fusionné par
 * searchKnowledge.
 *
 * DEUX DÉCLENCHEURS équivalents (le mutex interne de runPipelineIngest
 * rend les passages concurrents impossibles) :
 *   · le daemon lui-même (worker d'apprentissage) : dès que 1 000
 *     nouveaux documents s'accumulent OU toutes les heures, il POSTe ici
 *     (Queue & Batching, cf. pipeline/src/trainer.ts) ;
 *   · le planificateur cron externe (même mécanisme que training-sweep) :
 *     filet de sécurité horaire.
 *
 * Best-effort total : le résultat porte les statistiques réelles
 * (ingérés, dédoublonnés, écartés, échecs) — un échec documentaire ne
 * fait jamais échouer le passage.
 */
export async function POST(request: NextRequest) {
  return handler(request);
}

/** Compatibilité cron GET (même mécanisme que training-sweep). */
export async function GET(request: NextRequest) {
  return handler(request);
}

async function handler(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Import DYNAMIQUE (la route doit rester légère au démarrage —
    // même règle que training-sweep).
    const { runPipelineIngest } = await import("@/lib/pipeline/ingest");
    const result = await runPipelineIngest();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Pipeline knowledge ingest failed", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Ingest failed" },
      { status: errorStatus(error, 500) },
    );
  }
}
