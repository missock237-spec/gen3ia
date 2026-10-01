#!/usr/bin/env node
/**
 * Sonde Task 51 : rechargement automatique du navigateur après chaque
 * build Vercel — vérification RÉELLE du déploiement de production :
 * statut Vercel sur le commit poussé + alive du site + comportement réel
 * de /api/deploy-info (empreinte stable, jamais cachée) + régressions des
 * portes PWA antérieures (sw.js, politique de cache). Aucune assertion
 * sur des internals : uniquement des faits observables depuis l'extérieur
 * (API GitHub + HTTP public).
 */
const TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = "missock237-spec/gen3ia";
const SHA = "892d4a1";
const BASE = "https://gen3ia.online";
const AUTH = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "VERT" : "ROUGE"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// 1) Déploiement Vercel (GitHub commit status "Vercel").
const statuses = await fetch(`https://api.github.com/repos/${REPO}/commits/${SHA}/status`, {
  headers: AUTH,
}).then(
  (r) => (r.ok ? r.json() : null),
  () => null,
);
if (statuses) {
  const vercel = (statuses.statuses || []).find((s) => s.context?.toLowerCase().includes("vercel"));
  check(
    "Vercel deployment",
    vercel ? vercel.state === "success" : false,
    vercel ? `${vercel.state} (${vercel.description || "sans description"})` : "aucun statut Vercel sur le commit",
  );
  check("statut global du commit", statuses.state === "success", `state=${statuses.state}`);
} else {
  check("API GitHub jointe", false, "statuses indisponible");
}

// 2) Site vivant.
const home = await fetch(`${BASE}/`, { redirect: "manual" }).catch(() => null);
check("site vivant", Boolean(home && home.status < 500), `status=${home?.status}`);

// 3) /api/deploy-info : 200 + JSON { ok, deploymentId non vide } + no-store strict.
const deployInfo = await fetch(`${BASE}/api/deploy-info`, { cache: "no-store" }).catch(() => null);
if (deployInfo && deployInfo.ok) {
  const body = await deployInfo.json().catch(() => null);
  check(
    "/api/deploy-info : 200 + empreinte non vide",
    Boolean(body?.ok) && typeof body?.deploymentId === "string" && body.deploymentId.length > 0,
    body ? `deploymentId=${body.deploymentId}` : "JSON invalide",
  );
  const cc = deployInfo.headers.get("cache-control") || "";
  check("/api/deploy-info : Cache-Control no-store", cc.includes("no-store"), cc || "absent");
} else {
  check("/api/deploy-info joignable", false, deployInfo ? `status=${deployInfo.status}` : "échec réseau");
}

// 4) Empreinte STABLE sur deux requêtes successives (sémantique de référence
//    côté client : un onglet ne doit jamais voir l'empreinte osciller).
const second = await fetch(`${BASE}/api/deploy-info`, { cache: "no-store" }).catch(() => null);
if (deployInfo && second && deployInfo.ok && second.ok) {
  const a = (await deployInfo.json().catch(() => null))?.deploymentId;
  const b = (await second.json().catch(() => null))?.deploymentId;
  check("empreinte stable (2 requêtes)", Boolean(a && b && a === b), `a=${a} b=${b}`);
} else {
  check("empreinte stable (2 requêtes)", false, "second appel indisponible");
}

// 5) Régressions : sw.js toujours revalidé à chaque visite + vivant (skipWaiting).
const sw = await fetch(`${BASE}/sw.js`, { cache: "no-store" }).catch(() => null);
const swCc = sw?.headers.get("cache-control") || "";
check("sw.js max-age=0 must-revalidate (rappel étape 19)", swCc.includes("max-age=0") && swCc.includes("must-revalidate"), swCc || "absent");
const swText = await sw?.text().catch(() => null);
check("sw.js vivant (skipWaiting présent)", Boolean(swText?.includes("skipWaiting")), sw ? `${sw.status}` : "absent");

console.log(failures === 0 ? "\nTask 51 : 7/7 sondes VERTES." : `\nTask 51 : ${failures} sonde(s) ROUGE(S).`);
process.exit(failures === 0 ? 0 : 1);
