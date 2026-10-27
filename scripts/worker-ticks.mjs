#!/usr/bin/env node
/**
 * WORKER DE TICKS GEN3IA — exécution des agents sur le VPS (P2).
 *
 * RÔLE : boucle locale qui déclenche en continu le dispatch de la FILE DE
 * TICKS R2 (lib/queue/tick-queue.ts) via POST /api/queue/dispatch-tick et
 * la sentinelle des déclencheurs de workflow via POST
 * /api/cron/workflow-triggers. Complète les déclencheurs existants :
 *   - délivrance immédiate à l'enqueue (self-appel signé) ;
 *   - pompage opportuniste par le polling client (throttle 5 s/instance) ;
 *   - cron sentinelle quotidien.
 * Avec ce worker, une mission agent / un rendu vidéo / un workflow part en
 * Quelques secondes même sans client connecté — 24 h/24, sur le VPS.
 *
 * POURQUOI PAS BULLMQ+REDIS : la file R2 est DÉJÀ la source de vérité
 * durable (at-least-once, bails ETag, dead-letters, reprise, HMAC interne).
 * Ajouter Redis créerait une DEUXIÈME source de vérité de l'état de file
 * (la même dette « deux stacks » que le P1 interdit) + un service de plus
 * sur un VPS 4 Go. Ce worker est un SIMPLE boucle HTTP signée : aucune
 * dépendance, aucune donnée métier, redémarrable sans état.
 *
 * SÉCURITÉ : s'adresse UNIQUEMENT à l'origine locale (127.0.0.1 par défaut)
 * avec le bearer CRON_SECRET (accepté par les receivers de tick). Aucun
 * secret n'est loggué ; le token ne quitte jamais la machine.
 *
 * DÉPLOIEMENT (VPS) :
 *   pm2 start infra/deploy/ecosystem.worker.config.js
 *   pm2 save
 * Variables : GEN3IA_WORKER_URL (défaut http://127.0.0.1:3000),
 *   CRON_SECRET, WORKER_TICK_INTERVAL_MS (défaut 10 000).
 */

import { readFileSync } from "node:fs";

// Charge .env.production du VPS si présent (sans dépendance dotenv).
function chargerEnvProduction() {
  for (const chemin of ["/opt/gen3ia/.env.production", ".env.production"]) {
    try {
      const contenu = readFileSync(chemin, "utf8");
      for (const ligne of contenu.split("\n")) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(ligne);
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
      }
      return chemin;
    } catch {
      // fichier absent — suivant
    }
  }
  return null;
}

chargerEnvProduction();

const URL_BASE = (
  process.env.GEN3IA_WORKER_URL?.trim() || "http://127.0.0.1:3000"
).replace(/\/+$/, "");
const SECRET = process.env.CRON_SECRET?.trim() || "";
const INTERVALLE = Math.max(2_000, Number(process.env.WORKER_TICK_INTERVAL_MS) || 10_000);

if (!SECRET) {
  console.error("[worker-ticks] CRON_SECRET manquant : incapable de signer les ticks. Arrêt.");
  process.exit(1);
}

let arret = false;
let joursSansIncident = new Date().toISOString().slice(0, 10);
let stats = { ticks: 0, echecs: 0, consecutifs: 0 };

function log(niveau, message, extra = {}) {
  console.log(
    JSON.stringify({ t: new Date().toISOString(), niveau, worker: "ticks", ...extra, message }),
  );
}

async function appeler(chemin, label) {
  const reponse = await fetch(`${URL_BASE}${chemin}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
      "user-agent": "gen3ia-worker-ticks/1",
    },
    body: JSON.stringify({ source: "vps-worker" }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!reponse.ok) {
    const corps = await reponse.text().catch(() => "");
    throw new Error(`${label} HTTP ${reponse.status} ${corps.slice(0, 200)}`);
  }
  return reponse.json().catch(() => ({}));
}

async function passe() {
  const t0 = Date.now();
  const dispatch = await appeler("/api/queue/dispatch-tick", "dispatch-tick");
  const workflows = await appeler("/api/cron/workflow-triggers", "workflow-triggers").catch(
    (e) => ({ erreur: String(e.message || e) }),
  );
  stats.ticks += 1;
  stats.consecutifs = 0;
  log("info", "passe ok", {
    ms: Date.now() - t0,
    dispatch: dispatch?.dispatched ?? dispatch ?? "ok",
    workflows: workflows?.erreur ?? `${workflows?.parcourus ?? 0} parcourus`,
  });
}

async function boucle() {
  while (!arret) {
    try {
      await passe();
    } catch (erreur) {
      stats.echecs += 1;
      stats.consecutifs += 1;
      // Backoff : après 6 échecs consécutifs, ralentit à 60 s max.
      const attente = Math.min(60_000, INTERVALLE * stats.consecutifs);
      log("warn", "passe en échec — backoff", {
        err: String(erreur.message || erreur),
        consecutifs: stats.consecutifs,
        attenteMs: attente,
      });
      await new Promise((r) => setTimeout(r, attente));
      continue;
    }
    const jour = new Date().toISOString().slice(0, 10);
    if (jour !== joursSansIncident) {
      joursSansIncident = jour;
      log("info", "heartbeat quotidien", { ...stats });
    }
    await new Promise((r) => setTimeout(r, INTERVALLE));
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    arret = true;
    log("info", `signal ${signal} reçu — arrêt gracieux (la passe en cours finit)`);
    // La boucle vérifie `arret` entre les passes ; force la sortie si la
    // passe HTTP pend : PM2 kill_after prend le relais.
    setTimeout(() => process.exit(0), 100_000).unref();
  });
}

log("info", "worker de ticks démarré", { url: URL_BASE, intervalleMs: INTERVALLE });
boucle().catch((erreur) => {
  log("error", "boucle interrompue", { err: String(erreur?.message || erreur) });
  process.exit(1);
});
