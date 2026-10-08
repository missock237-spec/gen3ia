/**
 * GEN3IA VIDEO AGENT — worker standalone (Task 79, corrigé Task 106-c).
 *
 * Pour un hôte avec FFmpeg installé (auto-hébergé / conteneur worker) :
 *
 *   FIREBASE_PROJECT_ID=… FIREBASE_CLIENT_EMAIL=… FIREBASE_PRIVATE_KEY=… \
 *     NODE_OPTIONS=--conditions=react-server npx tsx scripts/video-worker.mts
 *
 * (`--conditions=react-server` neutralise le garde `server-only` des modules
 * serveur — même convention que les scripts backfill du dépôt.)
 *
 * Boucle (Task 106-c) : chaque cycle traite D'ABORD la file de PRODUCTION
 * (claim transactionnel + bail, advanceProductionJob) PUIS la file de RENDU
 * (claimNextQueuedJob + advanceJob) — les deux files partagent la MÊME
 * machine de ticks que le receiver QStash : checkpoints, reprise,
 * annulation identiques. QStash absent ? Le worker local est le chemin de
 * secours des deux files.
 *
 * CLI :
 *   --once            un seul cycle (production puis rendu) puis sortie ;
 *   --loop            boucle continue (défaut, comportement historique) ;
 *   --interval <sec>  pause entre cycles en mode boucle (défaut 5 s).
 */

import { parseArgs } from "node:util";
import {
  claimNextQueuedJob,
  getJob,
  advanceJob,
} from "@/lib/video/render-queue";
import { cleanupPassFiles } from "@/lib/video/long-video-service";
import {
  claimNextQueuedProductionJob,
  advanceProductionJob,
  type ProductionTickResult,
} from "@/lib/video/production-queue";

// ────────────────────────────────────────────────────────────────────────────
// CLI : --once | --loop | --interval <secondes>
// ────────────────────────────────────────────────────────────────────────────

const args = parseArgs({
  options: {
    once: { type: "boolean", default: false },
    loop: { type: "boolean", default: false },
    interval: { type: "string", default: "5" },
  },
  strict: false,
});

const RUN_ONCE = args.values.once === true;
/** Défaut : boucle continue (comportement historique du worker). */
const RUN_LOOP = !RUN_ONCE;
const parsedInterval = Number(args.values.interval);
const POLL_INTERVAL_MS =
  Number.isFinite(parsedInterval) && parsedInterval > 0
    ? Math.floor(parsedInterval * 1000)
    : 5_000;

/** Arrêt propre : SIGINT/SIGTERM termine le cycle courant puis sort. */
let stopping = false;

function onSignal(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`[video-worker] signal ${signal} reçu — arrêt propre après le cycle courant…`);
}

process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ────────────────────────────────────────────────────────────────────────────
// File de PRODUCTION (Task 106-c)
// ────────────────────────────────────────────────────────────────────────────

async function productionTick(): Promise<boolean> {
  const claimed = await claimNextQueuedProductionJob().catch((error: unknown) => {
    console.error("[video-worker] incident claim production :", error instanceof Error ? error.message : error);
    return null;
  });
  if (!claimed) return false;
  console.log(`[video-worker] production ${claimed.id.slice(0, 8)} (projet ${claimed.projectId.slice(0, 8)}) — étape ${claimed.stage}, traitement`);
  try {
    // Signature ACTUELLE : advanceProductionJob(jobId, { timeBudgetMs? }) —
    // un worker local n'a pas l'échéance serverless : pas de budget borné.
    const result: ProductionTickResult = await advanceProductionJob(claimed.id, {});
    const skipped = result.skipped ? " (tick neutre — backoff en cours)" : "";
    console.log(`[video-worker] production ${result.stage ?? "-"} → ${result.status}${skipped} : ${result.message}`);
  } catch (error) {
    console.error(`[video-worker] incident production ${claimed.id.slice(0, 8)} :`, error instanceof Error ? error.message : error);
  }
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// File de RENDU (comportement historique corrigé)
// ────────────────────────────────────────────────────────────────────────────

async function renderTick(): Promise<boolean> {
  const claimed = await claimNextQueuedJob().catch((error: unknown) => {
    console.error("[video-worker] incident claim rendu :", error instanceof Error ? error.message : error);
    return null;
  });
  if (!claimed) return false;
  console.log(`[video-worker] rendu ${claimed.id.slice(0, 8)} (projet ${claimed.projectId.slice(0, 8)}) — étape ${claimed.stage}, traitement`);
  try {
    // FIX Task 106-c : l'ancienne signature advanceJob(id, ORIGIN) est
    // obsolète — la signature actuelle est advanceJob(jobId, { timeBudgetMs? }).
    const result = await advanceJob(claimed.id, {});
    console.log(`[video-worker] rendu ${result.stage ?? "-"} → ${result.status} : ${result.message}`);
    if (result.status === "completed") {
      const job = await getJob(claimed.id);
      if (job?.tmpDir) await cleanupPassFiles(job.tmpDir);
    }
  } catch (error) {
    console.error(`[video-worker] incident rendu ${claimed.id.slice(0, 8)} :`, error instanceof Error ? error.message : error);
  }
  return true;
}

/** UN cycle : d'abord la production, puis le rendu. true si du travail a été fait. */
async function cycle(): Promise<boolean> {
  const productionWorked = await productionTick();
  const renderWorked = await renderTick();
  return productionWorked || renderWorked;
}

async function main(): Promise<void> {
  console.log(
    `[video-worker] démarré (mode ${RUN_ONCE ? "once" : "loop"}, poll ${POLL_INTERVAL_MS} ms) — files : production puis rendu.`,
  );
  if (RUN_ONCE) {
    const worked = await cycle();
    console.log(`[video-worker] cycle unique terminé (${worked ? "travail effectué" : "files vides"}).`);
    return;
  }
  while (!stopping) {
    const worked = await cycle();
    // Pas de pause supplémentaire quand du travail a été fait (drain rapide),
    // pause POLL_INTERVAL_MS entre cycles à vide (comportement historique).
    if (!worked) await sleep(POLL_INTERVAL_MS);
  }
  console.log("[video-worker] arrêt propre effectué.");
}

main()
  .then(() => {
    // Mode --once (ou arrêt propre) : sortie explicite avec succès.
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("[video-worker] fatal :", error instanceof Error ? error.message : error);
    process.exit(1);
  });
