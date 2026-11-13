/**
 * genAPI — CONFIGURATION PM2 du master daemon gen3 (VPS souverain AlmaLinux).
 *
 * Déploiement :
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 save           # persistance après redémarrage du VPS
 *   pm2 logs gen3-daemon
 *
 * Le daemon genAPI ne tourne JAMAIS sur Vercel : il pilote OpenSSL
 * (terminal intégré) et le serveur gRPC mTLS gen3 — deux briques qui
 * exigent un hôte persistant avec système de fichiers réel.
 */
module.exports = {
  apps: [
    {
      // Nom du process PM2 (logs, sondes : pm2 logs gen3-daemon).
      name: "gen3-daemon",
      // Point d'entrée TypeScript du daemon (exécuté via tsx, cf. interpreter).
      script: "scripts/genapi-daemon.mts",
      // tsx charge les .mts + résout les alias "@/…" du tsconfig — appelé
      // via npx pour ne rien installer au niveau global du VPS.
      interpreter: "npx",
      interpreter_args: "--yes tsx",
      // FORK (un seul processus) : le daemon est stateful (serveur gRPC sur
      // un port unique, terminal intégré OpenSSL) — le mode cluster est
      // interdit ici (conflit de port + double provisionnement).
      exec_mode: "fork",
      instances: 1,
      // Garde-fou mémoire : le daemon tient des buffers de paquets (base64)
      // et des connexions gRPC — au-delà de 1 Go, PM2 redémarre proprement.
      max_memory_restart: "1G",
      // Le master daemon se relève automatiquement après un incident.
      autorestart: true,
      // NODE_OPTIONS=--conditions=react-server neutralise le garde
      // `server-only` hors Next (même convention que video-worker.mts).
      env: {
        NODE_OPTIONS: "--conditions=react-server",
        NODE_ENV: "production",
      },
      // NOTE HONNÊTE : PM2 n'interprète PAS `env_file` (option
      // documentaire). Le script scripts/genapi-daemon.mts charge lui-même
      // .env.genapi (FIREBASE_*, GENAPI_CA_*, GENAPI_GRPC_PORT…) à
      // l'amorçage — voir l'entête de ce script pour la liste des variables.
      env_file: ".env.genapi",
    },
  ],
};
