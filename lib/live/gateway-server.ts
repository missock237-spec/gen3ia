import { startLiveGateway } from "./gateway";

/**
 * Serveur autonome de la gateway live (WebSocket temps réel).
 *
 * Tourne HORS de Next.js (pm2 start ... tsx lib/live/gateway-server.ts) :
 * contrairement à `next start`, tsx ne charge PAS .env.production — le
 * chargement est fait ici, sans écraser les variables déjà présentes
 * (Node 20.12+ : process.loadEnvFile n'écrase jamais l'environnement réel).
 * Ordre : .env.production (VPS) puis .env (développement local).
 *
 * Restauration post-Task 150 : le script npm `live:gateway` référençait ce
 * fichier alors qu'il avait été supprimé — le point d'entrée desktop est de
 * nouveau opérationnel (mode « desktop », client PC avec pairing token).
 * Le copilote visuel (surface /copilot) reste RETIRÉ : ses fournisseurs de
 * vision externes ont été supprimés en Task 150 — voir gateway.ts.
 */
for (const envFile of [".env.production", ".env"]) {
  try {
    process.loadEnvFile(envFile);
    break;
  } catch {
    // fichier absent : contexte sans fichier d'environnement
  }
}

const port = Number(process.env.LIVE_GATEWAY_PORT || 8787);
startLiveGateway(port);
console.log(`Gen3ia Live Gateway listening on :${port}`);
