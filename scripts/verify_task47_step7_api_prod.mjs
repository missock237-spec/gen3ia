#!/usr/bin/env node
/**
 * Vérification PRODUCTION Task 47 — Étape 7 : Agent gen API appelable +
 * outils « en clair » reconnus et durcis automatiquement.
 *
 * Contrôles (gen3ia.online) :
 *  1. Disponibilité : / 200, /api/health 200.
 *  2. Nouvelle route API v1 vivante :
 *     - POST /api/v1/agents/<id>/run sans clé → 401 structuré (jamais 500) ;
 *     - avec clé invalide → 401 (message machine, pas d'exécution) ;
 *     - le chemin /api/v1 n'est PAS intercepté par une redirection HTML.
 *  3. Routes d'hygiène des outils toujours authentifiées :
 *     - POST /api/agents/generate sans session → 401/403 (pas d'exécution LLM anonyme) ;
 *     - POST /api/agents sans session → 401.
 *  4. Déploiement vivant : x-vercel-id présent (nouveau build servi).
 *
 * Usage : node scripts/verify_task47_step7_api_prod.mjs
 */
const BASE = process.env.BASE_URL || "https://gen3ia.online";

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function jsonProbe(path, init) {
  const response = await fetch(`${BASE}${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  let body = null;
  try { body = await response.json(); } catch { /* HTML redirect ou texte */ }
  return { response, contentType, body };
}

async function main() {
  // ---- 1. Disponibilité ---------------------------------------------------
  const home = await fetch(`${BASE}/`, { redirect: "follow" });
  record("Vitrine / joignable", home.status === 200, `status ${home.status}`);

  const health = await fetch(`${BASE}/api/health`);
  record("Sonde /api/health", health.status === 200, `status ${health.status}`);

  // ---- 2. Route API v1 : agent appelable par clé ---------------------------
  const noKey = await jsonProbe("/api/v1/agents/agent_probe_inexistant/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objective: "Sonde de vérification étape 7" }),
  });
  record(
    "POST /api/v1/agents/<id>/run sans clé → 401 JSON structuré",
    noKey.response.status === 401 && noKey.body && typeof noKey.body.error === "string",
    `status ${noKey.response.status}, error=${noKey.body?.error ?? "(absent)"}`,
  );

  const badKey = await jsonProbe("/api/v1/agents/agent_probe_inexistant/run", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer g3x_probe_invalide", "x-gen3ia-project-id": "proj_probe" },
    body: JSON.stringify({ objective: "Sonde de vérification étape 7" }),
  });
  record(
    "POST /api/v1/agents/<id>/run clé invalide → 401 sans exécution",
    badKey.response.status === 401 && badKey.body && !("outputs" in (badKey.body ?? {})),
    `status ${badKey.response.status}, error=${badKey.body?.error ?? "(absent)"}`,
  );

  // ---- 3. Hygiène des outils : routes toujours authentifiées ---------------
  const gen = await jsonProbe("/api/agents/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: "Sonde anonyme — un agent qui analyse mes emails" }),
  });
  record(
    "POST /api/agents/generate anonyme → refus auth structuré",
    [401, 403].includes(gen.response.status) && gen.body && typeof gen.body.error === "string",
    `status ${gen.response.status}, error=${gen.body?.error ?? "(absent)"}`,
  );

  const create = await jsonProbe("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Sonde", description: "Sonde anonyme", type: "universal", systemPrompt: "x" }),
  });
  record(
    "POST /api/agents anonyme → refus auth structuré",
    [401, 403].includes(create.response.status) && create.body && typeof create.body.error === "string",
    `status ${create.response.status}, error=${create.body?.error ?? "(absent)"}`,
  );

  // ---- 4. Déploiement vivant ----------------------------------------------
  const vercelId = home.headers.get("x-vercel-id");
  record("Réponse portée par Vercel (build vivant)", Boolean(vercelId), `x-vercel-id=${vercelId ?? "(absent)"}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "🟢 SUCCÈS" : "🔴 ÉCHEC"} — ${results.length - failed.length}/${results.length} sondes vertes`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("❌ Sonde interrompue :", error?.message ?? error);
  process.exit(1);
});
