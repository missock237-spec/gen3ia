#!/usr/bin/env node
/**
 * Budget de bundle — First Load JS par route (Task 39, Rec 5.1/5.4).
 *
 * Source de vérité locale : .next/app-build-manifest.json, dont les
 * entrées `pages[route]` listent UNIQUEMENT les chunks INITIAUX de la
 * route (les chunks async/dynamiques n'y figurent pas — vérifié Task 38
 * quand zod est sorti des entrypoints). On mesure le poids GZIP de ces
 * chunks (estimation fidèle du transfert réel ; Vercel sert du brotli,
 * ~15 % plus léger encore).
 *
 * Budgets (gzip, par route, toutes routes confondues) :
 *  - FAIL > 240 kB : le build échoue (blocage CI). 240 kB gzip local
 *    ≈ 200 kB brotli réels = cible « First Load < 200 kB » du plan.
 *  - WARN > 225 kB : niveau actuel (surface principale 220 kB gzip) —
 *    tout nouveau kilo-octet au-delà doit être justifié.
 *  - SCAN : aucun marqueur serveur-seul (re2js, webchannel-blob,
 *    « Firestore instance has already been provided ») ne doit apparaître
 *    dans un chunk initial — le SDK Firestore est interdit au client.
 *
 * Usage : npm run build && npm run check:bundle
 *         BUDGET_FIRST_LOAD_KB=260 node scripts/check_bundle_budget.mjs (override)
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = process.cwd();
const NEXT_DIR = join(ROOT, ".next");
const MANIFEST = join(NEXT_DIR, "app-build-manifest.json");

const BUDGET_KB = Number(process.env.BUDGET_FIRST_LOAD_KB || 240);
const WARN_KB = Number(process.env.WARN_FIRST_LOAD_KB || 225);
const FORBIDDEN_MARKERS = [
  "re2js",
  "webchannel-blob",
  "Firestore instance has already been provided",
];

if (!existsSync(MANIFEST)) {
  console.error(
    "check:bundle — .next/app-build-manifest.json introuvable. Lance `npm run build` d'abord.",
  );
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const pages = manifest.pages || {};

if (Object.keys(pages).length === 0) {
  console.error("check:bundle — manifeste vide (0 route) : build Next incomplet ?");
  process.exit(2);
}

/** Somme gzip des chunks initiaux uniques d'une route + marqueurs interdits. */
function measureRoute(files) {
  const uniq = [...new Set(files)];
  let gzipTotal = 0;
  let rawTotal = 0;
  const markers = new Map(); // marker -> chunk
  for (const rel of uniq) {
    const abs = join(NEXT_DIR, rel.replace(/^\/?/, ""));
    if (!existsSync(abs)) continue;
    const stat = statSync(abs);
    if (!stat.isFile() || stat.size > 8_000_000) continue;
    const buf = readFileSync(abs);
    rawTotal += buf.length;
    gzipTotal += gzipSync(buf).length;
    // Scan marqueurs : uniquement les chunks raisonnables (évite le concat géant).
    if (buf.length < 1_500_000) {
      const text = buf.toString("utf8");
      for (const marker of FORBIDDEN_MARKERS) {
        if (text.includes(marker) && !markers.has(marker)) markers.set(marker, rel);
      }
    }
  }
  return { gzipTotal, rawTotal, markers: [...markers.entries()] };
}

const results = [];
let failures = 0;
let warnings = 0;

for (const [route, files] of Object.entries(pages).sort(
  (a, b) => b[1].length - a[1].length,
)) {
  const { gzipTotal, rawTotal, markers } = measureRoute(files);
  const kb = gzipTotal / 1024;
  const status =
    kb > BUDGET_KB ? "FAIL" : kb > WARN_KB ? "WARN" : "OK";
  if (status === "FAIL") failures++;
  if (status === "WARN") warnings++;
  results.push({
    status,
    route,
    gzipKb: kb.toFixed(0),
    rawKb: (rawTotal / 1024).toFixed(0),
    files: files.length,
  });
  for (const [marker, chunk] of markers) {
    failures++;
    console.error(
      `FAIL  [marqueur serveur-seul dans le bundle initial] "${marker}" <- ${chunk} (route ${route})`,
    );
  }
}

console.log("== Budget bundle : First Load JS par route (gzip) ==");
for (const r of results) {
  console.log(
    `${r.status.padEnd(4)} ${String(r.gzipKb).padStart(5)} kB gzip / ${String(r.rawKb).padStart(5)} kB brut  ${r.route}  (${r.files} chunks)`,
  );
}

const worst = results.reduce((a, b) => (Number(b.gzipKb) > Number(a.gzipKb) ? b : a));
console.log(
  `\nBudget : FAIL > ${BUDGET_KB} kB, WARN > ${WARN_KB} kB. Pire route : ${worst.route} (${worst.gzipKb} kB gzip).`,
);
console.log(
  `Marqueurs serveur-seul scannés dans ${results.length} routes : ${FORBIDDEN_MARKERS.join(", ")}.`,
);

if (failures > 0) {
  console.error(`\ncheck:bundle — ${failures} dépassement(s) : build NON conforme au budget.`);
  process.exit(1);
}
if (warnings > 0) {
  console.warn(`\ncheck:bundle — ${warnings} route(s) en WARN (au-dessus du niveau actuel) : justifie chaque kB ajouté.`);
}
process.exit(0);
