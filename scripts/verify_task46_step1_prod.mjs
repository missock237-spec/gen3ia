#!/usr/bin/env node
/**
 * Vérification PRODUCTION Task 46 — Étapes 1+2 : historique des conversations
 * d'agents mémorisé + reprise des missions longues.
 *
 * Contrôles (gen3ia.online) :
 *  1. Disponibilité : / 200, /api/health 200.
 *  2. Sécurité du nouveau contrat : /api/agent/chat POST sans session → 401
 *     (aucune écriture anonyme) ; /api/agent/chat/approve sans session → 401.
 *  3. Contrat de détail conversation : /api/chat/conversations/<id> sans
 *     session → 401 (le champ runs ajouté ne contourne pas l'authentification).
 *  4. Déploiement : la réponse serveur porte le nouveau build (x-vercel-id
 *     présent, pas de page d'erreur 5xx).
 *
 * Usage : node scripts/verify_task46_step1_prod.mjs
 */
const BASE = process.env.BASE_URL || "https://gen3ia.online";

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  // ---- 1. Disponibilité ---------------------------------------------------
  const home = await fetch(`${BASE}/`, { redirect: "follow" });
  record("Vitrine / joignable", home.status === 200, `status ${home.status}`);

  const health = await fetch(`${BASE}/api/health`);
  const healthBody = await health.json().catch(() => ({}));
  record("Health API 200", health.status === 200, `status ${health.status} ${JSON.stringify(healthBody).slice(0, 80)}`);

  // ---- 2. Sécurité : aucune écriture anonyme sur les chemins modifiés -----
  const agentChat = await fetch(`${BASE}/api/agent/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "probe anonyme" }),
  });
  record("POST /api/agent/chat sans session → 401", agentChat.status === 401, `status ${agentChat.status}`);

  const approve = await fetch(`${BASE}/api/agent/chat/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approvalId: "probe", action: "approve" }),
  });
  record("POST /api/agent/chat/approve sans session → 401", approve.status === 401, `status ${approve.status}`);

  // ---- 3. Détail conversation : authentification requise -------------------
  const detail = await fetch(`${BASE}/api/chat/conversations/0000000000000000probe`, { redirect: "manual" });
  record("GET /api/chat/conversations/[id] sans session → 401", detail.status === 401, `status ${detail.status}`);

  // ---- 3 bis. Étape 2 : route de reprise des missions longues -------------
  const cont = await fetch(`${BASE}/api/agent/chat/continue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ executionId: "probe-inexistant" }),
  });
  record("POST /api/agent/chat/continue sans session → 401", cont.status === 401, `status ${cont.status}`);

  // ---- 4. Build vivant -----------------------------------------------------
  const vercelId = home.headers.get("x-vercel-id");
  record("Réponse servie par Vercel (build vivant)", Boolean(vercelId), `x-vercel-id ${vercelId ?? "absent"}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "🎉 TOUS VERTS" : "💥 ÉCHECS"} : ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Probe crash:", error);
  process.exit(1);
});
