/**
 * genAPI — MASTER DAEMON gen3 : POINT D'ENTRÉE PM2 (miroir de
 * scripts/video-worker.mts).
 *
 * Déploiement sur le VPS souverain AlmaLinux (le daemon genAPI ne tourne
 * JAMAIS sur Vercel — il pilote OpenSSL et un serveur gRPC mTLS) :
 *
 *   pm2 start scripts/genapi-daemon.mts \
 *     --name gen3-daemon \
 *     --interpreter npx --interpreter-args "--yes tsx" \
 *     --time --max-memory-restart 1G
 *
 *   Variables requises (fichier .env.genapi chargé par ce script, ou
 *   exportées dans l'environnement PM2) :
 *     NODE_OPTIONS=--conditions=react-server   # neutralise le garde server-only
 *     FIREBASE_PROJECT_ID=…                    # identité Firestore/r2fs
 *     FIREBASE_CLIENT_EMAIL=…
 *     FIREBASE_PRIVATE_KEY=…
 *     GENAPI_CA_KEY_PATH=/etc/gen3ia/genapi/ca.key
 *     GENAPI_CA_CERT_PATH=/etc/gen3ia/genapi/ca.crt
 *     GENAPI_GRPC_PORT=9443                    # port du serveur gRPC mTLS
 *     GENAPI_EXECUTION_CREDITS_MINOR=15        # tarif standard par exécution
 *     GENAPI_SANDBOX_MODE=process              # durcissement VPS : gvisor|firecracker|process
 *
 *   Sondes (sans daemon permanent) :
 *     NODE_OPTIONS=--conditions=react-server npx tsx scripts/genapi-daemon.mts --once
 *
 * CLI :
 *   --once          un seul cycle (provisionnements en attente) puis sortie ;
 *   --interval <s>  pause entre cycles en mode boucle (défaut 5 s) ;
 *   --sans-serveur  NE PAS monter le serveur gRPC mTLS (provisionnement seul).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// Chargement de .env.genapi (PM2 n'interprète pas env_file : le daemon
// s'en charge lui-même, sans dépendance dotenv).
// ---------------------------------------------------------------------------

const CHEMIN_ENV = path.resolve(process.cwd(), ".env.genapi");

function chargerEnvGenapi(): void {
  if (!existsSync(CHEMIN_ENV)) return;
  try {
    for (const ligne of readFileSync(CHEMIN_ENV, "utf8").split("\n")) {
      const propre = ligne.trim();
      if (!propre || propre.startsWith("#")) continue;
      const egal = propre.indexOf("=");
      if (egal <= 0) continue;
      const cle = propre.slice(0, egal).trim();
      const valeur = propre.slice(egal + 1).trim().replace(/^['"]|['"]$/g, "");
      if (cle && !(cle in process.env)) process.env[cle] = valeur;
    }
    console.log("[genapi-daemon] .env.genapi chargé.");
  } catch (erreur: unknown) {
    console.error("[genapi-daemon] incident de lecture .env.genapi :", erreur instanceof Error ? erreur.message : erreur);
  }
}

chargerEnvGenapi();

// ---------------------------------------------------------------------------
// CLI : --once | --interval <secondes> | --sans-serveur
// ---------------------------------------------------------------------------

const args = parseArgs({
  options: {
    once: { type: "boolean", default: false },
    interval: { type: "string", default: "5" },
    "sans-serveur": { type: "boolean", default: false },
  },
  strict: false,
});

const parsedInterval = Number(args.values.interval);
const INTERVALLE_MS =
  Number.isFinite(parsedInterval) && parsedInterval > 0 ? Math.floor(parsedInterval * 1000) : 5_000;
const DEMARRER_SERVEUR = args.values["sans-serveur"] !== true;

/** Arrêt propre : SIGINT/SIGTERM quittent après le cycle courant. */
let stopping = false;
function onSignal(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`[genapi-daemon] signal ${signal} reçu — arrêt propre demandé…`);
}
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

async function main(): Promise<void> {
  console.log(
    `[genapi-daemon] démarré (mode ${args.values.once === true ? "once" : "boucle"}, interval ${INTERVALLE_MS} ms, serveur gRPC ${DEMARRER_SERVEUR ? "activé" : "désactivé"}).`,
  );
  const { boucleDaemonGenAPI, arreterServeurGenAPI, demanderArretGenAPI } = await import("@/lib/genapi/daemon");
  process.on("SIGINT", () => demanderArretGenAPI());
  process.on("SIGTERM", () => demanderArretGenAPI());
  try {
    const rapport = await boucleDaemonGenAPI({
      once: args.values.once === true,
      intervalleMs: INTERVALLE_MS,
      demarrerServeur: DEMARRER_SERVEUR,
    });
    console.log(
      `[genapi-daemon] rapport : ${rapport.cycles} cycle(s), ${rapport.provisions} provisionnement(s)${
        rapport.serveurPort !== undefined ? `, serveur gRPC port ${rapport.serveurPort}` : ""
      }.`,
    );
  } finally {
    await arreterServeurGenAPI().catch(() => undefined);
  }
  console.log("[genapi-daemon] arrêt propre effectué.");
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((erreur: unknown) => {
    console.error("[genapi-daemon] fatal :", erreur instanceof Error ? erreur.message : erreur);
    process.exit(1);
  });
