#!/usr/bin/env node
/**
 * Sonde production Task 55 — recommandation C (scoping orgId multi-tenant).
 *
 * Vérifications RÉELLES sur https://gen3ia.online :
 *  1) site vivant ;
 *  2) le déploiement ACTIF est bien le build du commit Task 55
 *     (dpl-id du statut GitHub Vercel ↔ empreinte /api/deploy-info) ;
 *  3) /api/agents reste protégée sans session (401 structuré, aucune fuite
 *     de liste — le scopage org ne change pas la garde d'authentification) ;
 *  4) /api/organizations vivante : 401 sans session (la surface org
 *     historique doit rester stable après le rewiring) ;
 *  5) /api/workflows vivante : 401 sans session ;
 *  6) régressions nulles : sw.js max-age=0 must-revalidate + deploy-info
 *     no-store (garde-fous des Tasks 48/51).
 */

import assert from "node:assert/strict";

const BASE = "https://gen3ia.online";
const TOKEN = process.argv[2] || "";
const COMMIT = process.argv[3] || "";

const results = [];
async function probe(label, fn) {
  try {
    await fn();
    results.push([label, "VERT"]);
  } catch (error) {
    results.push([label, `ROUGE — ${error.message}`]);
  }
}

// 1) Site vivant
await probe("site vivant (200, HTML Gen3ia)", async () => {
  const response = await fetch(BASE, { redirect: "manual" });
  assert.equal(response.status, 200, `status=${response.status}`);
  const html = await response.text();
  assert.ok(html.toLowerCase().includes("gen3ia"), "HTML sans marque Gen3ia");
});

// 2) Déploiement actif = build du commit Task 55
await probe("déploiement ACTIF = build du commit Task 55 (dpl-id GitHub ↔ deploy-info)", async () => {
  const response = await fetch(
    `https://api.github.com/repos/missock237-spec/gen3ia/commits/${COMMIT}/status`,
    { headers: TOKEN ? { Authorization: `token ${TOKEN}` } : {} },
  );
  const status = await response.json();
  const vercel = (status.statuses ?? []).find((s) => s.context === "Vercel");
  assert.ok(vercel && vercel.state === "success", `Vercel non success (${status.state})`);
  const dplFromCommit = String(vercel.target_url ?? "").split("/").pop() ?? "";
  assert.ok(/^[A-Za-z0-9]{10,}$/.test(dplFromCommit), `dpl id non extrait de ${vercel.target_url}`);
  const info = await fetch(`${BASE}/api/deploy-info`);
  assert.equal(info.status, 200, `deploy-info status=${info.status}`);
  const body = await info.json();
  // Normalisation : deploy-info renvoie l'id préfixé "dpl_", l'URL GitHub
  // le suffixe brut — comparaison sur la partie alphanumérique commune.
  const normalize = (id) => String(id ?? "").replace(/^dpl_/, "");
  const active = normalize(body.deploymentId ?? body.deploymentId2);
  assert.equal(active, normalize(dplFromCommit), `déploiement actif ${active} ≠ build du commit ${dplFromCommit}`);
});

// 3) Agents API protégée sans session
await probe("/api/agents sans session → 401 structuré (scopage org sans faille d'auth)", async () => {
  const response = await fetch(`${BASE}/api/agents`, { headers: { accept: "application/json" } });
  assert.equal(response.status, 401, `status=${response.status}`);
  const body = await response.json();
  assert.ok(body.error, "401 sans message d'erreur");
});

// 4) Création d'agent avec orgId sans session → 401 (jamais 500)
await probe("/api/agents POST orgId sans session → 401 (la politique ne fuit rien d'anonyme)", async () => {
  const response = await fetch(`${BASE}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Sonde anonyme", orgId: "org-sonde" }),
  });
  assert.equal(response.status, 401, `status=${response.status}`);
});

// 5) Organisations : surface historique stable
await probe("/api/organizations sans session → 401", async () => {
  const response = await fetch(`${BASE}/api/organizations`);
  assert.equal(response.status, 401, `status=${response.status}`);
});

// 6) Workflows : surface rewirée vivante
await probe("/api/workflows sans session → 401", async () => {
  const response = await fetch(`${BASE}/api/workflows`);
  assert.equal(response.status, 401, `status=${response.status}`);
});

// 7) Régressions nulles — cache headers
await probe("régressions nulles : sw.js max-age=0 must-revalidate + deploy-info no-store", async () => {
  const sw = await fetch(`${BASE}/sw.js`, { headers: { "user-agent": "Mozilla/5.0 probe-gen3ia" } });
  assert.equal(sw.status, 200, `sw.js status=${sw.status}`);
  assert.match(sw.headers.get("cache-control") ?? "", /max-age=0\s*,?\s*must-revalidate/, "sw.js cache-control");
  const info = await fetch(`${BASE}/api/deploy-info`);
  assert.match(info.headers.get("cache-control") ?? "", /no-store/, "deploy-info cache-control");
});

let fail = 0;
for (const [label, state] of results) {
  console.log(`[${state === "VERT" ? "✓" : "✗"}] ${label} → ${state}`);
  if (state !== "VERT") fail++;
}
console.log(fail === 0 ? "\nSONDE PROD : " + results.length + "/" + results.length + " VERTES" : `\nSONDE PROD : ${results.length - fail}/${results.length} — corriger les rouges`);
process.exit(fail === 0 ? 0 : 1);
