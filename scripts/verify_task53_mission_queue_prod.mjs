#!/usr/bin/env node
/**
 * Sonde production Task 53 — recommandation A (file d'attente missions longues).
 *
 * Vérifications RÉELLES sur https://gen3ia.online :
 *  1) site vivant ;
 *  2) le déploiement ACTIF est bien le build du commit Task 53
 *     (dpl-id extrait du statut GitHub Vercel du commit, comparé à
 *     l'empreinte /api/deploy-info servie en production — même technique
 *     que la sonde Task 52) ;
 *  3) le receiver /api/queue/mission-tick est VIVANT et refuse proprement
 *     un appel non signé : la file n'étant pas (encore) configurée dans
 *     Vercel, la réponse attendue est 503 « Queue non configurée » — un
 *     500/404 signifierait une route cassée ;
 *  4) l'API de mission /api/agents/run reste protégée (401 structuré sans
 *     session) — comportement inchangé ;
 *  5) le suivi de mission /api/agents/runs/{uuid} est vivant : 401 sans
 *     session (scopage propriétaire en amont) et 400 sur runId mal formé ;
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

const UUID = "0f0e0d0c-1111-2222-3333-444455556666";

// 1) Site vivant
await probe("site vivant (200, HTML Gen3ia)", async () => {
  const response = await fetch(BASE, { redirect: "manual" });
  assert.equal(response.status, 200, `status=${response.status}`);
  const html = await response.text();
  assert.ok(html.toLowerCase().includes("gen3ia"), "HTML sans marque Gen3ia");
});

// 2) Déploiement actif = build du commit Task 53
await probe("déploiement ACTIF = build du commit Task 53 (dpl-id GitHub ↔ deploy-info)", async () => {
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
  const fingerprint = await info.json();
  const active = String(fingerprint?.deploymentId ?? "").replace(/^dpl_/, "");
  assert.equal(
    active,
    dplFromCommit,
    `déploiement actif « ${active || "(vide)"} » ≠ build du commit « ${dplFromCommit} »`,
  );
});

// 3) Receiver QStash vivant : refuse proprement sans file configurée
await probe("receiver /api/queue/mission-tick vivant — 503 propre (file non configurée)", async () => {
  const response = await fetch(`${BASE}/api/queue/mission-tick`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: UUID }),
  });
  assert.equal(response.status, 503, `status=${response.status} (un 404/500 = route cassée)`);
  const body = await response.json().catch(() => null);
  assert.ok(body?.error, "corps d'erreur attendu");
});

// 4) API de mission toujours protégée (401 structuré)
await probe("/api/agents/run sans session → 401 structuré", async () => {
  const response = await fetch(`${BASE}/api/agents/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objective: "Sonde production sans authentification" }),
  });
  assert.equal(response.status, 401, `status=${response.status}`);
  const body = await response.json().catch(() => null);
  const code = body?.code ?? body?.error?.code;
  assert.ok(body, "corps JSON attendu sur le 401");
  assert.ok(!("runId" in (body ?? {})), "aucun runId ne doit être émis sans authentification");
  assert.ok(code === "AUTH_REQUIRED" || typeof body?.error === "string", `code machine attendu, reçu ${JSON.stringify(body).slice(0, 120)}`);
});

// 5) Suivi de mission : 401 sans session / 400 sur runId mal formé
await probe("/api/agents/runs/{uuid} sans session → 401 (scopage propriétaire)", async () => {
  const response = await fetch(`${BASE}/api/agents/runs/${UUID}`);
  assert.equal(response.status, 401, `status=${response.status}`);
});
await probe("/api/agents/runs/{runId} mal formé → 400", async () => {
  const response = await fetch(`${BASE}/api/agents/runs/not-a-uuid`);
  assert.equal(response.status, 400, `status=${response.status}`);
});
await probe("/api/agents/runs/{uuid}/stream sans session → 401 (aucun flux anonyme)", async () => {
  const response = await fetch(`${BASE}/api/agents/runs/${UUID}/stream`);
  assert.equal(response.status, 401, `status=${response.status}`);
});

// 6) Régressions nulles
await probe("sw.js : max-age=0 must-revalidate (Task 48 intact)", async () => {
  const response = await fetch(`${BASE}/sw.js`, { headers: { "user-agent": "Mozilla/5.0 (sonde-gen3ia)" } });
  assert.equal(response.status, 200, `status=${response.status}`);
  const cc = response.headers.get("cache-control") ?? "";
  assert.match(cc, /max-age=0/, `cache-control=${cc}`);
  assert.match(cc, /must-revalidate/, `cache-control=${cc}`);
});
await probe("/api/deploy-info : no-store strict (Task 51 intact)", async () => {
  const response = await fetch(`${BASE}/api/deploy-info`);
  const cc = response.headers.get("cache-control") ?? "";
  assert.match(cc, /no-store/, `cache-control=${cc}`);
});

let red = 0;
for (const [label, status] of results) {
  console.log(`${status === "VERT" ? "✅" : "❌"} ${label} — ${status === "VERT" ? "VERT" : status}`);
  if (status !== "VERT") red++;
}
console.log(`\nSonde Task 53 : ${results.length - red}/${results.length} ${red === 0 ? "VERTES ✓" : `— ${red} ROUGE(s)`}`);
process.exit(red === 0 ? 0 : 1);
