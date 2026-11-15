/**
 * PM2 — worker de ticks gen3ia (P2 : exécution des agents sur le VPS).
 *
 * Démarrage :
 *   CRON_SECRET=<secret> pm2 start infra/deploy/ecosystem.worker.config.js
 *   pm2 save
 *
 * Le process appelle /api/queue/dispatch-tick + /api/cron/workflow-triggers
 * toutes les 10 s (boucle locale signée CRON_SECRET) : les missions agents,
 * rendus vidéo et workflows à déclencheurs avancent même sans client
 * connecté. Voir scripts/worker-ticks.mjs pour le contrat complet.
 */
module.exports = {
  apps: [
    {
      name: "gen3ia-worker-ticks",
      script: "scripts/worker-ticks.mjs",
      cwd: "/opt/gen3ia",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "256M",
      kill_timeout: 100_000,
      max_restarts: 50,
      restart_delay: 5_000,
      env: {
        GEN3IA_WORKER_URL: "http://127.0.0.1:3000",
        WORKER_TICK_INTERVAL_MS: "10000",
        // CRON_SECRET : hérité de l'environnement d'appel (jamais commité).
      },
      out_file: "/var/log/gen3ia/worker-ticks.out.log",
      error_file: "/var/log/gen3ia/worker-ticks.err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
