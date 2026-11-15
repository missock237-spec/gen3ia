import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LocalScraperPipeline, type TargetConfig } from "./pipeline";
import {
  chargerBatchStateFichier,
  lireTrainerOptions,
  verifierEtDeclencher,
} from "./trainer";

/**
 * DAEMON PIPELINE GEN3IA — process de FOND (PM2 `gen3ia-pipeline`).
 *
 * « Séparation des flux » : ce process tourne en continu en arrière-plan
 * (scraping + préparation du corpus) pendant que le serveur principal
 * gen3ia gère exclusivement les utilisateurs, le streaming audio/vidéo
 * et les réponses temps réel. Les deux ne partagent QUE le fichier
 * JSONL local (découplage asynchrone total).
 *
 * Boucle : toutes les PIPELINE_INTERVAL_MINUTES (défaut 60) —
 *   1. lecture déclarative de config/targets.json ;
 *   2. scraping de chaque cible (fetch léger, Puppeteer si requiresJs) ;
 *   3. append JSONL + déduplication SHA-256 persistée ;
 *   4. Queue & Batching : seuil (1 000 docs) OU intervalle (60 min)
 *      atteint → déclenchement de l'ingestion incrémentale serveur.
 *
 * Résilience : aucune exception ne sort de la boucle (une cible en
 * échec n'interrompt jamais les autres ni le daemon), arrêt propre sur
 * SIGTERM/SIGINT, cycle immédiat possible avec --once (cron/debug).
 */

function chargerEnvLocal(cwd: string): void {
  // services/pipeline/.env (jamais commité) : GEN3IA_INGEST_URL, GEN3IA_CRON_SECRET…
  // Sur le VPS, deploy.sh y copie CRON_SECRET depuis .env.production.
  try {
    const brut = readFileSync(join(cwd, ".env"), "utf-8");
    for (const ligne of brut.split("\n")) {
      const propre = ligne.trim();
      if (!propre || propre.startsWith("#")) continue;
      const egale = propre.indexOf("=");
      if (egale <= 0) continue;
      const cle = propre.slice(0, egale).trim();
      const valeur = propre.slice(egale + 1).trim().replace(/^["']|["']$/g, "");
      if (!(cle in process.env)) process.env[cle] = valeur;
    }
  } catch {
    // Fichier absent : env du process seule (comportement normal en dev).
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  chargerEnvLocal(cwd);

  const dataDir = join(cwd, "data");
  const logsDir = join(cwd, "logs");
  const uneFois = process.argv.includes("--once");

  const pipeline = new LocalScraperPipeline(dataDir, logsDir);
  // initialize() : mkdir data/logs + CHARGEMENT du cache d'empreintes
  // SHA-256 (sans lui, aucune déduplication entre cycles — chaque cycle
  // réécrirait les mêmes documents dans le JSONL).
  await pipeline.initialize();
  const logger = pipeline.log;
  const options = lireTrainerOptions();
  const etatBatch = await chargerBatchStateFichier(dataDir);

  logger.info(
    `Daemon pipeline démarré (cycle: ${process.env.PIPELINE_INTERVAL_MINUTES ?? "60"} min, ` +
      `batch: ${options.batchThreshold} docs / ${options.intervalMinutes} min, ` +
      `ingest: ${options.ingestUrl}).`,
  );

  let enCours = false;
  let arret = false;

  const cycle = async (): Promise<void> => {
    if (enCours) return;
    enCours = true;
    try {
      // 1. Cibles déclaratives (sans modifier le code).
      let cibles: TargetConfig[] = [];
      try {
        cibles = JSON.parse(readFileSync(join(cwd, "config", "targets.json"), "utf-8")) as TargetConfig[];
      } catch (erreur) {
        logger.error(
          `config/targets.json illisible (${erreur instanceof Error ? erreur.message : erreur}) — cycle ignoré.`,
        );
        return;
      }

      // 2-3. Scraping séquentiel + append JSONL (dédupliqué).
      let nouveaux = 0;
      for (const cible of cibles) {
        if (arret) break;
        const extrait = await pipeline.processTarget(cible);
        if (extrait) nouveaux += 1;
      }
      logger.info(`Cycle terminé : ${nouveaux} nouveau(x) document(s) sur ${cibles.length} cible(s).`);

      // 4. Queue & Batching — déclenchement incrémental si seuil/heure.
      const etat = await verifierEtDeclencher(
        etatBatch,
        nouveaux,
        options,
        join(dataDir, "batch-state.json"),
        logger,
      );
      etatBatch.pendingSinceTrigger = etat.pendingSinceTrigger;
      etatBatch.lastTriggerOkAt = etat.lastTriggerOkAt;
    } catch (erreur) {
      // Garantie daemon : AUCUNE exception ne sort du cycle.
      logger.error(
        `Cycle en échec (non fatal, le daemon continue): ${erreur instanceof Error ? erreur.message : erreur}`,
      );
    } finally {
      enCours = false;
    }
  };

  // Arrêt propre (PM2 envoie SIGTERM).
  const arreter = (signal: string): void => {
    if (arret) return;
    arret = true;
    logger.info(`Signal ${signal} reçu — arrêt propre du daemon…`);
    void pipeline.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => arreter("SIGTERM"));
  process.on("SIGINT", () => arreter("SIGINT"));

  await cycle();

  if (uneFois) {
    logger.info("Mode --once : cycle unique terminé, sortie.");
    await pipeline.close();
    return;
  }

  // Boucle continue : setTimeout (pas setInterval) → aucun chevauchement
  // de cycles même si un cycle dépasse l'intervalle.
  const intervalleMs = Number(process.env.PIPELINE_INTERVAL_MINUTES ?? "60") * 60_000;
  const boucle = (): void => {
    if (arret) return;
    setTimeout(async () => {
      await cycle();
      boucle();
    }, intervalleMs).unref();
  };
  boucle();
}

main().catch((erreur) => {
  // Erreur critique au démarrage uniquement (config absente, disque…).
  console.error("Erreur critique dans le pipeline :", erreur);
  process.exit(1);
});
