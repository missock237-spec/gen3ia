/**
 * PM2 — DAEMON PIPELINE GEN3IA (process de fond, auto-apprentissage).
 *
 * Isolation des ressources (VPS 2 Go — le serveur utilisateur est
 * PRIORITAIRE) :
 *   · instances: 1 — le scraping est séquentiel et poliment rythmé ;
 *   · max_memory_restart: '1G' — au-delà, PM2 redémarre le daemon
 *     (l'état batch/empreintes est persisté sur disque, aucun lost) ;
 *   · autorestart — crash = relance immédiate, jamais de collecte morte ;
 *   · le serveur principal `gen3ia` N'EST PAS géré ici (il possède sa
 *     propre configuration PM2 sur le VPS) : ce fichier ne touche qu'au
 *     pipeline, jamais à l'inférence.
 *
 * Installation VPS (cf. README.md) :
 *   cd /opt/gen3ia/pipeline && npm ci --omit=dev && npm run build
 *   pm2 start ecosystem.config.js && pm2 save
 */
module.exports = {
  apps: [
    {
      name: "gen3ia-pipeline",
      cwd: __dirname,
      script: "./dist/index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
      },
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
