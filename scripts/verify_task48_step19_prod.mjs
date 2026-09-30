#!/usr/bin/env node
/**
 * Sonde Task 48 (étape 19) : vérification RÉELLE du déploiement de
 * production — statut du déploiement Vercel sur le commit poussé + alive
 * du site + en-têtes de cache des assets statiques + présence du SW.
 * Aucune assertion sur des internals : uniquement des faits observables
 * depuis l'extérieur (API GitHub + HTTP public).
 */
const TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = "missock237-spec/gen3ia";
const SHA = "40fa14a";
const BASE = "https://gen3ia.online";

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "VERT" : "ROUGE"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// 1) Déploiement Vercel (GitHub commit status "Vercel") — auth facultative :
// le dépôt est public, l'API statuses fonctionne sans token.
const statuses = await fetch(`https://api.github.com/repos/${REPO}/commits/${SHA}/status`).then(
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
  check("CI / status global", statuses.state === "success", `state=${statuses.state}`);
} else {
  check("API GitHub jointe", false, "statuses indisponible");
}

// 2) Site vivant + en-têtes de cache des assets statiques (politique étape 19).
const probe = async (path) => {
  try {
    return await fetch(`${BASE}${path}`, { redirect: "manual" });
  } catch {
    return null;
  }
};

const home = await probe("/");
check("site vivant", Boolean(home && home.status < 500), `status=${home?.status}`);

const sw = await probe("/sw.js");
const swCc = sw?.headers?.get("cache-control") || "";
check("sw.js max-age=0 must-revalidate", swCc.includes("max-age=0") && swCc.includes("must-revalidate"), swCc || "absent");

const icons = await probe("/icons/icon-192.png");
const icCc = icons?.headers?.get("cache-control") || "";
check(
  "icônes cache long + SWR",
  icCc.includes("max-age=86400") && icCc.includes("stale-while-revalidate"),
  icCc || "absent",
);

const manifest = await probe("/manifest.webmanifest");
const mfCc = manifest?.headers?.get("cache-control") || "";
check(
  "manifeste 1 h + SWR",
  mfCc.includes("max-age=3600") && mfCc.includes("stale-while-revalidate"),
  mfCc || "absent",
);

// 3) Le service worker déployé référence toujours le signal (régression ?).
const swText = await sw?.text().catch(() => null);
check("sw.js vivant (skipWaiting présent)", Boolean(swText?.includes("skipWaiting")), sw ? `${sw.status}` : "absent");

console.log(failures === 0 ? "\nTask 48 : 6/6 sondes VERTES." : `\nTask 48 : ${failures} sonde(s) ROUGE(S).`);
process.exit(failures === 0 ? 0 : 1);
