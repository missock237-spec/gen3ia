#!/usr/bin/env node
/**
 * Sonde d'accessibilité Gen3ia (Rec 8 — roadmap-enterprise).
 *
 * Scanne les pages publiques avec axe-core (WCAG 2.1 AA) via Playwright
 * et ÉCHOUE (exit 1) sur toute violation `critical` ou `serious` non
 * listée dans l'allowlist documentée ci-dessous.
 *
 * Usage :
 *   node scripts/a11y_prod.mjs                     # scan https://gen3ia.online
 *   BASE_URL=http://localhost:3000 node scripts/a11y_prod.mjs   # scan local (CI)
 *
 * CI : le job `a11y` build + démarre le serveur Next puis appelle ce
 * script sur http://localhost:3000 — hermétique (aucune dépendance à la
 * production) et bloquant sur violation non tolérée.
 *
 * Maintenance de l'allowlist : une entrée est une exception DOCUMENTÉE
 * (cause connue + ticket/décision). Toute autre violation critical/
 * serious doit être CORRIGÉE dans le code, pas tolerée.
 */
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const BASE_URL = (process.env.BASE_URL || "https://gen3ia.online").replace(/\/$/, "");

/** Pages publiques scannées (Rec 8 : /, /login — + pages publiques utiles). */
const PAGES = ["/", "/login"];

/**
 * Allowlist d'exceptions documentées.
 * Clé : `${page}::${ruleId}` — Valeur : raison documentée.
 * Vide à l'installation : toute violation critical/serious fait échouer
 * la sonde et doit être corrigée (ou ajoutée ici avec justification).
 */
const ALLOWLIST = {
  // " /::color-contrast": "Exemple : dégradé marketing validé AA 3:1 en texte large",
};

/** Règles axe exclues avec justification permanente. */
const RULES_DISABLED = [];

/** Impacts qui font échouer la sonde. */
const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

function selectors(node, max = 3) {
  const target = Array.isArray(node.target) ? node.target : [node.target];
  return target.slice(0, max).map((t) => (typeof t === "string" ? t : JSON.stringify(t))).join(", ");
}

async function scanPage(browser, pagePath) {
  const url = `${BASE_URL}${pagePath}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (!response || !response.ok()) {
      return { pagePath, url, ok: false, error: `HTTP ${response ? response.status() : "inconnu"}`, violations: [], incomplete: [] };
    }
    // Laisse l'hydratation React se stabiliser (réduise les faux positifs
    // sur les éléments montés/remplacés après le premier rendu).
    await page.waitForTimeout(1500);

    let builder = new AxeBuilder({ page }).withTags(TAGS);
    if (RULES_DISABLED.length) builder = builder.disableRules(RULES_DISABLED);
    const results = await builder.analyze();

    return {
      pagePath,
      url,
      ok: true,
      violations: results.violations || [],
      incomplete: results.incomplete || [],
    };
  } catch (error) {
    return { pagePath, url, ok: false, error: String(error?.message || error), violations: [], incomplete: [] };
  } finally {
    await context.close();
  }
}

function filterBlocking(violations) {
  return violations
    .filter((v) => BLOCKING_IMPACTS.has(v.impact))
    .map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, helpUrl: v.helpUrl }));
}

async function main() {
  console.log(`\n=== Sonde accessibilité Gen3ia — ${BASE_URL} ===`);
  console.log(`Pages : ${PAGES.join(", ")} — tags : ${TAGS.join(", ")}\n`);

  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const reports = [];
  try {
    for (const pagePath of PAGES) {
      const report = await scanPage(browser, pagePath);
      reports.push(report);
      const blocking = report.ok ? filterBlocking(report.violations) : [];
      const tolerated = blocking.filter((v) => ALLOWLIST[`${report.pagePath}::${v.id}`]);
      const unexpected = blocking.filter((v) => !ALLOWLIST[`${report.pagePath}::${v.id}`]);

      if (!report.ok) {
        console.log(`✗ ${report.pagePath} — INACCESSIBLE : ${report.error}`);
        continue;
      }
      if (blocking.length === 0) {
        console.log(`✓ ${report.pagePath} — aucune violation critical/serious`);
      } else {
        console.log(`${unexpected.length === 0 ? "○" : "✗"} ${report.pagePath} — ${blocking.length} violation(s) critical/serious :`);
        for (const v of blocking) {
          const tag = ALLOWLIST[`${report.pagePath}::${v.id}`] ? "TOLÉRÉE (documentée)" : "BLOQUANTE";
          console.log(`    [${v.impact}] ${v.id} — ${v.help} — ${v.nodes} élément(s) — ${tag}`);
          console.log(`      ${v.helpUrl}`);
        }
      }
      // Stocke le détail pour le rapport final (sélecteurs des nœuds).
      report.detail = (report.violations || [])
        .filter((v) => BLOCKING_IMPACTS.has(v.impact))
        .map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 5).map((n) => selectors(n)) }));
    }
  } finally {
    await browser.close();
  }

  const unreachable = reports.filter((r) => !r.ok);
  const blockingTotal = reports.reduce((acc, r) => {
    if (!r.ok) return acc;
    return acc + (r.violations || []).filter((v) => BLOCKING_IMPACTS.has(v.impact) && !ALLOWLIST[`${r.pagePath}::${v.id}`]).length;
  }, 0);

  if (reports.some((r) => r.detail?.length)) {
    console.log("\n--- Détail des sélecteurs en violation (max 5/règle) ---");
    for (const r of reports) {
      if (!r.detail?.length) continue;
      for (const v of r.detail) {
        console.log(`  ${r.pagePath} :: ${v.id}`);
        for (const sel of v.nodes) console.log(`      ${sel}`);
      }
    }
  }

  console.log(`\n=== Bilan : ${blockingTotal} violation(s) bloquante(s), ${unreachable.length} page(s) inaccessible(s) ===\n`);

  if (unreachable.length > 0 || blockingTotal > 0) process.exit(1);
}

main().catch((error) => {
  console.error("Sonde a11y en échec :", error);
  process.exit(1);
});
