import { buildApp } from "./app.js";

/**
 * Service sandbox Gen3ia — HTTP + HMAC (cf. docs/terminal-execution.md).
 *
 * HOST : en production VPS le service n'est exposé QU'EN LOCAL
 * (HOST=127.0.0.1 — l'app Next.js appelle http://127.0.0.1:8080/execute
 * depuis la même machine) ; défaut 0.0.0.0 conservé pour les déploiements
 * conteneurisés où l'orchestrateur route le trafic.
 */
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST?.trim() || "0.0.0.0";

const app = await buildApp();

app.listen({ host, port }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
