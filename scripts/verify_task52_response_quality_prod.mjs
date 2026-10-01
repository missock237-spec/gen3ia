#!/usr/bin/env node
/**
 * Sonde production Task 52 — qualité des réponses IA.
 *
 * Vérifie, contre https://gen3ia.online :
 *  1. site vivant ;
 *  2. le déploiement ACTIF est bien le commit Task 52 (empreinte /api/deploy-info
 *     cohérente avec 3b46d0f) — Vercel construit le commit verbatim, CI verte ;
 *  3. empreinte STABLE sur deux requêtes fraîches (sémantique de référence
 *     utilisée par le rechargement automatique Task 51) ;
 *  4. régressions nulles : sw.js toujours max-age=0 must-revalidate + skipWaiting
 *     (les navigations restent network-first — condition du rechargement auto) ;
 *  5. la page d'accueil sert bien le build actif (HTML 200, marqueur Gen3ia).
 *
 * Usage : node scripts/verify_task52_response_quality_prod.mjs
 */
import assert from "node:assert/strict";

const BASE = process.env.GEN3IA_PROD_URL ?? "https://gen3ia.online";
const COMMIT_SHA = "3b46d0f";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";

const results = [];
async function probe(label, fn) {
  try {
    await fn();
    results.push({ label, ok: true });
    console.log(`VERT  — ${label}`);
  } catch (error) {
    results.push({ label, ok: false, error });
    console.log(`ROUGE — ${label}\n        ${error?.message ?? error}`);
  }
}

// 1) Site vivant.
await probe("site vivant (GET / → 200, HTML Gen3ia)", async () => {
  const res = await fetch(BASE, { signal: AbortSignal.timeout(30_000) });
  assert.equal(res.status, 200, `status ${res.status}`);
  const html = await res.text();
  assert.ok(html.toLowerCase().includes("gen3ia"), "marqueur Gen3ia absent du HTML");
});

// 2) Le déploiement ACTIF est celui du commit Task 52 : le dpl-id Vercel du
// commit (API GitHub, statut « Vercel ») est comparé à l'empreinte servie
// par le domaine de production (/api/deploy-info — Task 51).
let fingerprint1;
await probe(`déploiement actif = build du commit ${COMMIT_SHA} (Task 52)`, async () => {
  const statusRes = await fetch(
    `https://api.github.com/repos/missock237-spec/gen3ia/commits/${COMMIT_SHA}/status`,
    {
      signal: AbortSignal.timeout(30_000),
      headers: {
        ...(GITHUB_TOKEN ? { authorization: `token ${GITHUB_TOKEN}` } : {}),
        "user-agent": "gen3ia-prod-probe",
      },
    },
  );
  assert.equal(statusRes.status, 200, `status GitHub ${statusRes.status}`);
  const status = await statusRes.json();
  const vercel = (status.statuses ?? []).find((s) => s.context === "Vercel");
  assert.ok(vercel, "statut Vercel absent sur le commit");
  assert.equal(vercel.state, "success", "déploiement Vercel non success");
  const dplFromCommit = String(vercel.target_url ?? "").split("/").pop() ?? "";
  assert.ok(/^[A-Za-z0-9]{10,}$/.test(dplFromCommit), `dpl id non extrait de ${vercel.target_url}`);

  const res = await fetch(`${BASE}/api/deploy-info`, {
    signal: AbortSignal.timeout(30_000),
    headers: { "cache-control": "no-cache" },
  });
  assert.equal(res.status, 200, `status ${res.status}`);
  assert.match(
    res.headers.get("cache-control") ?? "",
    /no-store/i,
    "deploy-info doit rester no-store",
  );
  const body = await res.json();
  fingerprint1 = body;
  const active = String(body?.deploymentId ?? "").replace(/^dpl_/, "");
  assert.equal(
    active,
    dplFromCommit,
    `déploiement actif « ${active || "(vide)"} » ≠ build du commit « ${dplFromCommit} »`,
  );
});

// 3) Empreinte STABLE (le client Task 51 compare UNIQUEMENT deploymentId —
// generatedAt est volatil par conception ; comparer comme le client).
await probe("empreinte STABLE sur une seconde requête fraîche (deploymentId)", async () => {
  const res = await fetch(`${BASE}/api/deploy-info?fresh=${Date.now()}`, {
    signal: AbortSignal.timeout(30_000),
    headers: { "cache-control": "no-cache" },
  });
  assert.equal(res.status, 200, `status ${res.status}`);
  const body = await res.json();
  assert.equal(
    body?.deploymentId,
    fingerprint1?.deploymentId,
    "deploymentId instable entre deux requêtes",
  );
});

// 4) Régressions nulles : sw.js (rechargement automatique Task 51).
await probe("sw.js : max-age=0 must-revalidate + skipWaiting préservés", async () => {
  const res = await fetch(`${BASE}/sw.js`, {
    signal: AbortSignal.timeout(30_000),
    headers: { "cache-control": "no-cache" },
  });
  assert.equal(res.status, 200, `status ${res.status}`);
  const cache = res.headers.get("cache-control") ?? "";
  assert.match(cache, /max-age=0/i, `Cache-Control sw.js inattendu : ${cache}`);
  assert.match(cache, /must-revalidate/i, `Cache-Control sw.js inattendu : ${cache}`);
  const sw = await res.text();
  assert.ok(sw.includes("skipWaiting"), "skipWaiting absent de sw.js");
});

// 5) offline.html toujours servi en no-cache (politique étape 19 intacte).
await probe("offline.html : max-age=0 must-revalidate (régression nulle)", async () => {
  const res = await fetch(`${BASE}/offline.html`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(res.status, 200, `status ${res.status}`);
  const cache = res.headers.get("cache-control") ?? "";
  assert.match(cache, /max-age=0/i, `Cache-Control offline.html inattendu : ${cache}`);
  assert.match(cache, /must-revalidate/i, `Cache-Control offline.html inattendu : ${cache}`);
});

const failed = results.filter((r) => !r.ok);
console.log(`\nRésultat : ${results.length - failed.length}/${results.length} sondes vertes`);
process.exit(failed.length > 0 ? 1 : 0);
