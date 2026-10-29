#!/usr/bin/env node
/**
 * SONDE SYNTHÉTIQUE DE PRODUCTION — Gen3ia (itération 24, Job 478451).
 *
 * Pourquoi : le guérisseur surveille l'ALIGNEMENT main↔prod (version.json)
 * mais rien ne vérifie l'EXPÉRIENCE UTILISATEUR réelle entre deux
 * déploiements — une prod qui servirait des 500 ou des latences dégradées
 * resterait invisible tant qu'aucun push ne déclenche un cycle. Cette sonde
 * complète la boucle : elle est exécutée par le workflow
 * surveillance-production.yml (cron 7,37 * * * *) et ouvre/met à jour/clôt
 * l'issue de dégradation (label surveillance-prod).
 *
 * Verdicts (exit 1 si au moins un ÉCHEC) :
 *   1. Les 10 endpoints critiques répondent 2xx/3xx/401 avec TTFB ≤ MAX_TTFB_MS.
 *   2. Livraison bloquée : prod gitSha ≠ main ET buildDate de prod > 3 h
 *      (si main n'a pas bougé, pas de lag — pas de faux positif quand le
 *      cycle d'amélioration est volontairement en pause).
 *   3. Info non bloquante : fraîcheur du build (buildDate), écart SHA.
 *
 * Sorties : tableau lisible + results.md (pour le corps d'issue) + exit code.
 * Aucune dépendance : fetch natif Node 20+.
 */
const BASE = (process.env.BASE_URL ?? "https://gen3ia.online").replace(/\/$/, "");
const MAX_TTFB_MS = Number(process.env.MAX_TTFB_MS ?? 3000);
const LIVRAISON_BLOQUEE_HEURES = 3;
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const REPO = process.env.GITHUB_REPOSITORY ?? "missock237-spec/gen3ia";

const ENDPOINTS = [
  ["health", "/api/health"],
  ["accueil", "/"],
  ["chat", "/chat"],
  ["dashboard", "/dashboard"],
  ["security.txt", "/.well-known/security.txt"],
  ["apple-touch-icon", "/apple-touch-icon.png"],
  ["sitemap", "/sitemap.xml"],
  ["robots", "/robots.txt"],
  ["llms.txt", "/llms.txt"],
  ["login", "/login"],
];

async function sondeEndpoint([nom, chemin]) {
  const debut = Date.now();
  const controle = new AbortController();
  const minuteur = setTimeout(() => controle.abort(), Math.max(MAX_TTFB_MS + 4000, 10000));
  try {
    const r = await fetch(BASE + chemin, {
      signal: controle.signal,
      headers: { "user-agent": "surveillance-prod/1.0 (job 478451)" },
      redirect: "manual",
    });
    clearTimeout(minuteur);
    const ttfb = Date.now() - debut;
    const statutOk = (r.status >= 200 && r.status < 400) || r.status === 401;
    return { nom, chemin, statut: r.status, ttfb, ok: statutOk && ttfb <= MAX_TTFB_MS, raison: !statutOk ? "statut inattendu" : ttfb > MAX_TTFB_MS ? `TTFB > ${MAX_TTFB_MS} ms` : "" };
  } catch (e) {
    clearTimeout(minuteur);
    return { nom, chemin, statut: "ERR", ttfb: Date.now() - debut, ok: false, raison: String(e?.cause?.code ?? e?.message ?? e).slice(0, 60) };
  }
}

async function shaMain() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
      headers: TOKEN ? { Authorization: `Bearer ${TOKEN}`, "user-agent": "surveillance-prod/1.0" } : { "user-agent": "surveillance-prod/1.0" },
    });
    if (!r.ok) return null;
    return (await r.json())?.sha ?? null;
  } catch {
    return null;
  }
}

const resultats = [];
for (const e of ENDPOINTS) resultats.push(await sondeEndpoint(e));

let version = null;
try {
  const r = await fetch(`${BASE}/version.json?rm=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
  version = await r.json();
} catch { version = null; }

const shaM = await shaMain();
const prodSha = version?.gitSha ?? null;
const buildDate = version?.buildDate ?? null;
const ageBuildHeures = buildDate ? (Date.now() - Date.parse(buildDate)) / 3_600_000 : Number.POSITIVE_INFINITY;
const lagSha = Boolean(shaM && prodSha && !shaM.startsWith(prodSha));
const livraisonBloquee = lagSha && ageBuildHeures > LIVRAISON_BLOQUEE_HEURES;

const echecsEndpoints = resultats.filter((r) => !r.ok);
const echecs = [];
for (const e of echecsEndpoints) echecs.push(`endpoint ${e.nom} (${e.chemin}) : ${e.raison} [statut=${e.statut}, ttfb=${e.ttfb} ms]`);
if (!version) echecs.push("version.json illisible ou injoignable");
if (livraisonBloquee) echecs.push(`livraison bloquée : prod=${prodSha?.slice(0, 8)} ≠ main=${shaM?.slice(0, 8)} avec build vieux de ${ageBuildHeures.toFixed(1)} h (> ${LIVRAISON_BLOQUEE_HEURES} h)`);
if (!echecsEndpoints.length && version && Number.isFinite(ageBuildHeures) === false) echecs.push("buildDate absent de version.json");

const verdict = echecs.length === 0 ? "VERT" : "ROUGE";
const horodatage = new Date().toISOString();

console.log(`=== SURVEILLANCE SYNTHÉTIQUE PROD — ${horodatage} — verdict ${verdict} ===`);
for (const r of resultats) console.log(`${r.ok ? "✅" : "❌"} ${r.nom.padEnd(18)} ${String(r.statut).padEnd(4)} ${String(r.ttfb).padStart(6)} ms ${r.raison}`);
console.log(`version.json : gitSha=${prodSha?.slice(0, 8) ?? "?"} buildDate=${buildDate ?? "?"} (âge ${Number.isFinite(ageBuildHeures) ? ageBuildHeures.toFixed(1) + " h" : "?"})`);
console.log(`main : ${shaM?.slice(0, 8) ?? "inconnu"} | lag SHA : ${lagSha ? "OUI" : "non"} | livraison bloquée : ${livraisonBloquee ? "OUI" : "non"}`);

/* results.md — corps d'issue (markdown). */
const lignes = resultats.map((r) => `| ${r.ok ? "✅" : "❌"} | \`${r.chemin}\` | ${r.statut} | ${r.ttfb} ms | ${r.raison || "—"} |`).join("\n");
const md = [
  `## Surveillance production — ${horodatage} — **${verdict}**`,
  "",
  `| | Endpoint | Statut | TTFB | Note |`,
  `|---|---|---|---|---|`,
  lignes,
  "",
  `- version.json : \`${prodSha ?? "?"}\` — buildDate \`${buildDate ?? "?"}\` (âge ${Number.isFinite(ageBuildHeures) ? ageBuildHeures.toFixed(1) + " h" : "?"})`,
  `- main : \`${shaM?.slice(0, 8) ?? "?"}\` — lag SHA : **${lagSha ? "OUI" : "non"}** — livraison bloquée : **${livraisonBloquee ? "OUI" : "non"}**`,
  "",
  ...echecs.map((e) => `- ⚠️ ${e}`),
  "",
  `_Seuils : statut 2xx/3xx/401, TTFB ≤ ${MAX_TTFB_MS} ms ; livraison bloquée = lag SHA + build > ${LIVRAISON_BLOQUEE_HEURES} h._`,
].join("\n");
await import("node:fs").then((fs) => fs.writeFileSync("results.md", md, "utf8"));

if (verdict === "ROUGE") {
  console.error("ÉCHECS:\n" + echecs.map((e) => " - " + e).join("\n"));
  process.exit(1);
}
