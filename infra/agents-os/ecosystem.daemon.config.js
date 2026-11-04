/**
 * AGENTS-OS — ECOSYSTEM PM2 DU DAEMON D'AUTO-GUÉRISON (Module 1).
 *
 * Démarrage explicite (jamais au boot Next) :
 *   pm2 start infra/agents-os/ecosystem.daemon.config.js
 *
 * Le daemon tourne en FORK unique (une seule instance : le journal JSONL
 * et le cooldown sont en mémoire processus). Le niveau par défaut reste
 * "diagnostic" — l'activation de remédiations mutantes est une décision
 * d'exploitation explicite via AGENTS_OS_NIVEAU (commande|pm2|docker).
 */
module.exports = {
  apps: [
    {
      name: "agents-os-guerison",
      // tsx est présent via les devDependencies (npm ci complet au build).
      script: "node_modules/tsx/dist/cli.mjs",
      args: "lib/agents-os/auto-guerison/daemon.ts",
      cwd: "/var/www/gen3ia",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "256M",
      // Politique anti-chaos PM2 : 5 redémarrages max sur 60 s, puis stop.
      min_uptime: "30s",
      max_restarts: 5,
      restart_delay: 10_000,
      env: {
        NODE_ENV: "production",
        AGENTS_OS_NIVEAU: "diagnostic",
        AGENTS_OS_SEUIL: "2",
        AGENTS_OS_FENETRE_MS: "120000",
        AGENTS_OS_COOLDOWN_MS: "600000",
        AGENTS_OS_ETAT_DIR: "/var/www/gen3ia/var/agents-os",
      },
      out_file: "/root/.pm2/logs/agents-os-guerison-out.log",
      error_file: "/root/.pm2/logs/agents-os-guerison-error.log",
      time: true,
    },
  ],
};
