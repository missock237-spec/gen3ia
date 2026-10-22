import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import type winston from "winston";

/**
 * WORKER D'APPRENTISSAGE — Queue & Batching.
 *
 * Plutôt que d'entraîner gen3 à chaque page récupérée (ce qui saturerait
 * les ressources du VPS 2 Go), les documents s'accumulent dans le JSONL
 * partagé ; CE worker surveille l'accumulation et déclenche l'ingestion
 * incrémentale côté serveur (POST /api/cron/knowledge-ingest, protégée
 * par CRON_SECRET) dès qu'un seuil critique est atteint :
 *   · PIPELINE_BATCH_THRESHOLD nouveaux documents (défaut 1 000), OU
 *   · PIPELINE_TRAIN_INTERVAL_MINUTES écoulées depuis le dernier
 *     déclenchement RÉUSSI (défaut 60 min),
 * le premier des deux gagnant. Cas lastTriggerOkAt = 0 (jamais ingéré —
 * installation fraîche ou reprise) avec des documents en attente =
 * rattrapage IMMÉDIAT ; rien en attente = aucun déclencheur à vide.
 *
 * Le déclencheur est fire-and-forget : un échec réseau/HTTP est
 * journalisé et RETENTÉ au prochain cycle — jamais de crash, jamais de
 * perte (les documents restent dans le JSONL jusqu'à consommation
 * effective, l'offset serveur fait foi).
 *
 * Le compteur « en attente » est persisté (data/batch-state.json) : un
 * redémarrage du daemon ne remet pas le compteur à zéro (approximatif
 * mais monotone — l'ingestion réelle est idempotente côté serveur).
 */

export interface BatchState {
  /** Documents extraits depuis le dernier déclencheur RÉUSSI. */
  pendingSinceTrigger: number;
  /** Timestamp (ms) du dernier déclencheur accepté (2xx). */
  lastTriggerOkAt: number;
}

export function nouveauBatchState(): BatchState {
  return { pendingSinceTrigger: 0, lastTriggerOkAt: 0 };
}

export function chargerBatchState(brut: string | null): BatchState {
  if (!brut) return nouveauBatchState();
  try {
    const data = JSON.parse(brut) as Partial<BatchState>;
    return {
      pendingSinceTrigger:
        typeof data.pendingSinceTrigger === "number" && Number.isFinite(data.pendingSinceTrigger)
          ? Math.max(0, Math.floor(data.pendingSinceTrigger))
          : 0,
      lastTriggerOkAt:
        typeof data.lastTriggerOkAt === "number" && Number.isFinite(data.lastTriggerOkAt)
          ? data.lastTriggerOkAt
          : 0,
    };
  } catch {
    return nouveauBatchState();
  }
}

/** Configuration du déclencheur (valeurs = recommandations du guide). */
export interface TrainerOptions {
  batchThreshold: number;
  intervalMinutes: number;
  ingestUrl: string;
  cronSecret: string;
  /** Injection pour tests. */
  trigger?: (url: string, secret: string) => Promise<boolean>;
}

export function lireTrainerOptions(env: NodeJS.ProcessEnv = process.env): TrainerOptions {
  return {
    batchThreshold: Number(env.PIPELINE_BATCH_THRESHOLD ?? "1000"),
    intervalMinutes: Number(env.PIPELINE_TRAIN_INTERVAL_MINUTES ?? "60"),
    ingestUrl:
      env.GEN3IA_INGEST_URL?.trim() || "https://gen3ia.online/api/cron/knowledge-ingest",
    cronSecret: env.GEN3IA_CRON_SECRET?.trim() || "",
  };
}

/** POST de déclenchement (réel) — fire-and-forget côté appelant. */
export async function declencherIngestion(url: string, secret: string): Promise<boolean> {
  if (!secret) return false;
  try {
    const reponse = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(60_000),
    });
    return reponse.ok;
  } catch {
    return false;
  }
}

/**
 * Décide et déclenche l'entraînement incrémental. Retourne le nouvel état.
 * Ne lève JAMAIS (best-effort total, tout est journalisé).
 */
export async function verifierEtDeclencher(
  etat: BatchState,
  nouveauxDocuments: number,
  options: TrainerOptions,
  statePath: string,
  logger: winston.Logger,
): Promise<BatchState> {
  const suivant: BatchState = {
    pendingSinceTrigger: etat.pendingSinceTrigger + nouveauxDocuments,
    lastTriggerOkAt: etat.lastTriggerOkAt,
  };

  if (nouveauxDocuments > 0) {
    await sauverBatchState(statePath, suivant).catch(() => undefined);
  }

  const seuilAtteint = suivant.pendingSinceTrigger >= options.batchThreshold;
  const intervalleMs = options.intervalMinutes * 60_000;
  const heureAtteinte = Date.now() - suivant.lastTriggerOkAt >= intervalleMs;

  // Aucun document en attente : RIEN à ingérer — aucun appel (l'heure
  // « écoulée » depuis lastTriggerOkAt=0 ne doit pas provoquer des
  // déclencheurs à vide à chaque cycle).
  if (suivant.pendingSinceTrigger <= 0) return suivant;

  if (!seuilAtteint && !heureAtteinte) return suivant;

  const motif = seuilAtteint
    ? `seuil ${suivant.pendingSinceTrigger}/${options.batchThreshold} documents`
    : `intervalle ${options.intervalMinutes} min`;

  if (!options.cronSecret) {
    logger.warn(
      `Déclenchement ${motif} bloqué : GEN3IA_CRON_SECRET absent — configurez pipeline/.env (les documents restent en attente, aucune perte).`,
    );
    return suivant;
  }

  const trigger = options.trigger ?? declencherIngestion;
  const ok = await trigger(options.ingestUrl, options.cronSecret);
  if (ok) {
    logger.info(
      `Entraînement incrémental déclenché (${motif}) — ingestion serveur acceptée.`,
    );
    return { pendingSinceTrigger: 0, lastTriggerOkAt: Date.now() };
  }

  logger.warn(
    `Déclenchement ${motif} ÉCHOUÉ (réseau/HTTP) — retenté au prochain cycle, documents conservés.`,
  );
  return suivant;
}

async function sauverBatchState(statePath: string, etat: BatchState): Promise<void> {
  // Tmp au nom IMPRÉVISIBLE (UUID) : pas de course concurrentielle sur
  // un nom prédictible (alerte CodeQL js/insecure-temporary-file).
  const tmp = `${statePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(etat), "utf-8");
  await fs.rename(tmp, statePath);
}

export async function chargerBatchStateFichier(dataDir: string): Promise<BatchState> {
  try {
    return chargerBatchState(await fs.readFile(join(dataDir, "batch-state.json"), "utf-8"));
  } catch {
    return nouveauBatchState();
  }
}
