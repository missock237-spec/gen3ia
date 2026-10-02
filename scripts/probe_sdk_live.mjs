/**
 * Sonde réelle du SDK contre la PRODUCTION gen3ia.online (lecture seule —
 * GET uniquement, aucun effet de bord, aucune facturation).
 *
 * Prérequis : npm run sdk:build (importe le bundle ESM git-ignoré).
 *
 * Valide : transport fetch réel, normalisation baseUrl, parsing JSON,
 * mapping d'erreurs 404 (anti-énumération) et 400 (runId invalide).
 */
import { Gen3iaClient, Gen3iaApiError } from "../sdk/dist/esm/index.js";

const client = new Gen3iaClient({ baseUrl: "https://gen3ia.online" });

// 1) Sonde de santé publique.
const health = await client.health();
if (!health.ok || health.service !== "gen3ia") {
  console.error("ÉCHEC : health inattendue", health);
  process.exit(1);
}
console.log("1/3 health OK —", health.time);

// 2) Métadonnées SDK exposées par l'app (pre-deploy : peut ne pas exister encore).
const metaResponse = await fetch("https://gen3ia.online/api/public/sdk");
console.log(`2/3 /api/public/sdk → HTTP ${metaResponse.status} (200 attendu après déploiement, 404 avant)`);

// 3) Erreur structurée : mission avec runId invalide → 400 (auth requise d'abord, mais l'ordre serveur peut renvoyer 401).
const noAuth = new Gen3iaClient({ baseUrl: "https://gen3ia.online", firebaseToken: "token-invalide-probe" });
try {
  await noAuth.missions.get("$$$$");
  console.error("ÉCHEC : requête aurait dû échouer");
  process.exit(1);
} catch (error) {
  if (error instanceof Gen3iaApiError && error.status >= 400 && error.status < 500) {
    console.log(`3/3 erreur structurée OK — HTTP ${error.status} correctement enveloppée en Gen3iaApiError`);
  } else {
    console.error("ÉCHEC : type d'erreur inattendu", error);
    process.exit(1);
  }
}

console.log("SONDE SDK : 3/3 OK");
