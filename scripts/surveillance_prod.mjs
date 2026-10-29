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
 * ITÉRATION 32 — tolérance post-swap (re-test unique, fail-closed préservé).
 * Série documentée de transitoires liés à la bascule atomique :
 *   - it.29 : 502 sur 3 endpoints DANS la fenêtre de swap (auto-guéri < 60 s) ;
 *   - it.31 : health TTFB 3282 ms à ~6 min post-swap, rétabli 944 ms à 13:39Z
 *     — le ROUGE a révélé (et réparé) le canal d'alarme, mais le verdict
 *     était un faux positif.
 * Principe : une défaillance ÉLIGIBLE (5xx, TTFB > seuil, erreur réseau ERR)
 * est re-testée UNE fois après RETEST_DELAY_MS (défaut 60 s) ; elle ne
 * devient ROUGE que si elle PERSISTE au re-test (une vraie panne persiste
 * sur 60 s, un réchauffement post-swap passe). Restent IMMÉDIATS (aucun
 * re-test) : 4xx inattendu (régression réelle : route manquante, auth
 * cassée), version.json illisible, livraison bloquée (lag 3 h par définition
 * non transitoire). Chaque re-test est VISIBLE (log + results.md), jamais
 * silencieux. Le gate CD (sonde de régression, strict) n'a PAS cette
 * tolérance : la porte de déploiement reste stricte, le monitorage devient
 * intelligent.
 *
 * Sorties : tableau lisible + results.md (pour le corps d'issue) + exit code.
 * Aucune dépendance : fetch natif Node 20+.
 */
const BASE = (process.env.BASE_URL ?? "https://gen3ia.online").replace(/\/$/, "");
const MAX_TTFB_MS = Number(process.env.MAX_TTFB_MS ?? 3000);
const RETEST_DELAY_MS = Number(process.env.RETEST_DELAY_MS ?? 60_000); // 0 = désactivé
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

/** Éligible au re-test post-swap : signatures de réchauffement transitoire.
 *  5xx (502/503 pendant la bascule), TTFB > seuil (cold start), ERR réseau.
 *  Un 4xx inattendu (404 route manquante, 403 auth cassée) est une
 *  RÉGRESSION RÉELLE : immédiat, jamais re-testé. */
function eligibleRetest(r) {
  return r.statut === "ERR" || (typeof r.statut === "number" && r.statut >= 500) || r.raison.startsWith("TTFB");
}

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

/* Tolérance post-swap (it.32) : re-test UNIQUE des échecs éligibles.
 * Conditions : re-test activé (RETEST_DELAY_MS > 0), au moins un échec,
 * TOUS les échecs éligibles (un seul 4xx réel → ROUGE immédiat), version
 * lisible et livraison non bloquée (par définition non transitoires). */
let retestEffectue = false;
let retestAbsorbe = false;
if (
  RETEST_DELAY_MS > 0 &&
  echecsEndpoints.length > 0 &&
  echecsEndpoints.every(eligibleRetest) &&
  version &&
  !livraisonBloquee
) {
  console.log(`⏳ ${echecsEndpoints.length} échec(s) de signature transitoire (post-swap) — re-test unique dans ${RETEST_DELAY_MS / 1000} s…`);
  await new Promise((res) => setTimeout(res, RETEST_DELAY_MS));
  retestEffectue = true;
  const retest = [];
  for (const e of echecsEndpoints) retest.push(await sondeEndpoint([e.nom, e.chemin]));
  // Remplacement dans les résultats : la seconde mesure fait foi
  // (traçabilité conservée dans les logs et results.md).
  for (const r2 of retest) {
    const idx = resultats.findIndex((r) => r.nom === r2.nom);
    if (idx >= 0) resultats[idx] = r2;
  }
  retestAbsorbe = retest.every((r) => r.ok);
  console.log(retestAbsorbe
    ? `♻️ Re-test : tous les endpoints re-testés sont revenus conformes — transitoire post-swap absorbé (VERDICT VERT, preuve dans results.md).`
    : `❌ Re-test : au moins une défaillance PERSISTE après ${RETEST_DELAY_MS / 1000} s — verdict ROUGE (vraie panne, pas un réchauffement).`);
}

const echecsFinaux = resultats.filter((r) => !r.ok);
const echecs = [];
for (const e of echecsFinaux) {
  const marqueur = retestEffectue ? " [PERSISTE au re-test +" + RETEST_DELAY_MS / 1000 + " s]" : "";
  echecs.push(`endpoint ${e.nom} (${e.chemin}) : ${e.raison} [statut=${e.statut}, ttfb=${e.ttfb} ms]${marqueur}`);
}
if (!version) echecs.push("version.json illisible ou injoignable");
if (livraisonBloquee) echecs.push(`livraison bloquée : prod=${prodSha?.slice(0, 8)} ≠ main=${shaM?.slice(0, 8)} avec build vieux de ${ageBuildHeures.toFixed(1)} h (> ${LIVRAISON_BLOQUEE_HEURES} h)`);
if (!echecsFinaux.length && version && Number.isFinite(ageBuildHeures) === false) echecs.push("buildDate absent de version.json");

const verdict = echecs.length === 0 ? "VERT" : "ROUGE";
const horodatage = new Date().toISOString();

console.log(`=== SURVEILLANCE SYNTHÉTIQUE PROD — ${horodatage} — verdict ${verdict} ===`);
if (retestEffectue) console.log(`re-test post-swap : ${retestAbsorbe ? "ABSORBÉ (transitoire)" : "défaillance persistante"} — délai ${RETEST_DELAY_MS / 1000} s`);
for (const r of resultats) console.log(`${r.ok ? "✅" : "❌"} ${r.nom.padEnd(18)} ${String(r.statut).padEnd(4)} ${String(r.ttfb).padStart(6)} ms ${r.raison}`);
console.log(`version.json : gitSha=${prodSha?.slice(0, 8) ?? "?"} buildDate=${buildDate ?? "?"} (âge ${Number.isFinite(ageBuildHeures) ? ageBuildHeures.toFixed(1) + " h" : "?"})`);
console.log(`main : ${shaM?.slice(0, 8) ?? "inconnu"} | lag SHA : ${lagSha ? "OUI" : "non"} | livraison bloquée : ${livraisonBloquee ? "OUI" : "non"}`);

/* results.md — corps d'issue (markdown). */
const lignes = resultats.map((r) => `| ${r.ok ? "✅" : "❌"} | \`${r.chemin}\` | ${r.statut} | ${r.ttfb} ms | ${r.raison || "—"} |`).join("\n");
const md = [
  `## Surveillance production — ${horodatage} — **${verdict}**`,
  "",
  retestEffectue
    ? `_Tolérance post-swap (it.32) : re-test unique après ${RETEST_DELAY_MS / 1000} s — ${retestAbsorbe ? "transitoire absorbé, verdict VERT" : "défaillance PERSISTANTE, verdict ROUGE"}._`
    : "",
  `| | Endpoint | Statut | TTFB | Note |`,
  `|---|---|---|---|---|`,
  lignes,
  "",
  `- version.json : \`${prodSha ?? "?"}\` — buildDate \`${buildDate ?? "?"}\` (âge ${Number.isFinite(ageBuildHeures) ? ageBuildHeures.toFixed(1) + " h" : "?"})`,
  `- main : \`${shaM?.slice(0, 8) ?? "?"}\` — lag SHA : **${lagSha ? "OUI" : "non"}** — livraison bloquée : **${livraisonBloquee ? "OUI" : "non"}**`,
  "",
  ...echecs.map((e) => `- ⚠️ ${e}`),
  "",
  `_Seuils : statut 2xx/3xx/401, TTFB ≤ ${MAX_TTFB_MS} ms ; livraison bloquée = lag SHA + build > ${LIVRAISON_BLOQUEE_HEURES} h ; échec 5xx/TTFB/ERR re-testé une fois après ${RETEST_DELAY_MS / 1000} s (4xx, version.json et livraison bloquée : immédiats)._`,
].join("\n");
await import("node:fs").then((fs) => fs.writeFileSync("results.md", md, "utf8"));

if (verdict === "ROUGE") {
  console.error("ÉCHECS:\n" + echecs.map((e) => " - " + e).join("\n"));
  process.exit(1);
}
