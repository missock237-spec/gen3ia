#!/usr/bin/env node
/**
 * Vérification e2e production — audit « niveau Google » (commit 26c86db).
 *
 * 1. signUp Firebase + session                : compte réel.
 * 2. Santé                                    : plateforme OK sur Next 15.5.26.
 * 3. CSP strict SANS 'unsafe-eval'            : faille XSS fermée (audit #2).
 * 4. Permissions-Policy unifiée               : camera/microphone (self)
 *    identiques middleware + next.config (audit #1).
 * 5. HSTS unifié preload                      : max-age=63072000;
 *    includeSubDomains; preload (audit #7).
 * 6. X-Frame-Options                          : DENY sur l'app (strict),
 *    SAMEORIGIN uniquement sur /preview (modale artefact).
 * 7. CSP artefact dédiée /preview/*           : CDN jsdelivr/unpkg/eval
 *    confinés à la surface sandbox (apps agent exécutables).
 * 8. Trace-id cryptographique                 : trc_<uuid> (audit #9).
 * 9. POPUP OAuth Google OUVERTE               : CSP sans unsafe-eval n'a
 *    pas cassé Firebase Auth (regression test).
 * 10. POPUP OAuth GitHub OUVERTE              : idem.
 * 11. Non-régression Task 36                  : e2e complète (thème, prompt
 *     sans limite, Gen IA, approbation conditionnelle, pub PRO, sw hors-ligne,
 *     logo).
 */

import { chromium } from "playwright";

import { cspAuthorizes, cspAuthorizesAny, cspHasToken, urlHasHost } from "./lib/csp-probe.mjs";

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `e2e-audit-${Date.now()}@gen3ia.test`;
const PASSWORD = "AuditPass123!";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`OK   [${name}]${detail ? " " + detail : ""}`); }
  else { fail++; console.log(`FAIL [${name}]${detail ? " " + detail : ""}`); }
}

async function main() {
  // ---------- 1/2. signUp + santé ----------
  const signUpRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const signUp = await signUpRes.json();
  ok("1/signUp", Boolean(signUp.idToken), EMAIL);

  const sessionRes = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signUp.idToken}` },
  });
  ok("1b/session", sessionRes.status === 200);

  const health = await fetch(`${BASE}/api/health`);
  ok("2/health", health.status === 200);

  // ---------- 3-6. Headers ----------
  const homeHeaders = await fetch(`${BASE}/`);
  const csp = homeHeaders.headers.get("content-security-policy") || "";
  const perms = homeHeaders.headers.get("permissions-policy") || "";
  const hsts = homeHeaders.headers.get("strict-transport-security") || "";
  const xfo = homeHeaders.headers.get("x-frame-options") || "";
  const coop = homeHeaders.headers.get("cross-origin-opener-policy") || "";

  ok("3/csp-sans-unsafe-eval", csp.includes("script-src") && !csp.includes("unsafe-eval"),
    `script-src=${(csp.match(/script-src[^;]*/) || [""])[0].slice(0, 110)}`);
  ok("4a/permissions-policy-unifiee", perms === "camera=(self), microphone=(self), display-capture=(self), geolocation=()", perms);
  ok("5/hsts-preload", hsts === "max-age=63072000; includeSubDomains; preload", hsts);
  ok("6/xfo-app-deny", xfo === "DENY", xfo);
  ok("6b/coop-oauth", coop === "same-origin-allow-popups", coop);

  // ---------- 7. CSP artefact /preview ----------
  const previewRes = await fetch(`${BASE}/preview/audit-probe-id`, { redirect: "manual" });
  const previewCsp = previewRes.headers.get("content-security-policy") || "";
  const previewXfo = previewRes.headers.get("x-frame-options") || "";
  const jsdelivrOk = cspAuthorizesAny(previewCsp, "cdn.jsdelivr.net");
  const evalOk = cspHasToken(previewCsp, "'unsafe-eval'");
  const ancestorsSelfOk = cspAuthorizes(previewCsp, "frame-ancestors", "'self'");
  ok("7/csp-artefact-preview",
    jsdelivrOk && evalOk && ancestorsSelfOk,
    `jsdelivr=${jsdelivrOk} eval=${evalOk} ancestors-self=${ancestorsSelfOk}`);
  ok("7b/xfo-preview", previewXfo === "SAMEORIGIN", previewXfo);

  // ---------- 8. Trace-id cryptographique ----------
  const apiRes = await fetch(`${BASE}/api/health`);
  const traceId = apiRes.headers.get("x-gen3ia-trace-id") || "";
  const cryptoOk = /^trc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(traceId);
  const reuseRes = await fetch(`${BASE}/api/health`, { headers: { "x-gen3ia-trace-id": "audit-e2e-trace-2026" } });
  const reuseOk = reuseRes.headers.get("x-gen3ia-trace-id") === "audit-e2e-trace-2026";
  ok("8/trace-id-crypto", cryptoOk && reuseOk, `${traceId.slice(0, 44)} · réutilisation entrant=${reuseOk}`);

  // ---------- 9/10. Popups OAuth (CSP sans unsafe-eval) ----------
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 60000 });

  await page.getByRole("button", { name: /continuer avec google/i }).click();
  await page.waitForTimeout(8000);
  const googlePages = context.pages().map((p) => p.url());
  ok("9/popup-google", googlePages.some((u) => urlHasHost(u, "accounts.google.com")),
    (googlePages.find((u) => urlHasHost(u, "accounts.google.com")) || "aucune popup").slice(0, 80));

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 60000 });
  await page.getByRole("button", { name: /continuer avec github/i }).click();
  await page.waitForTimeout(8000);
  const githubPages = context.pages().map((p) => p.url());
  ok("10/popup-github", githubPages.some((u) => urlHasHost(u, "github.com")),
    (githubPages.find((u) => urlHasHost(u, "github.com")) || "aucune popup").slice(0, 80));

  await browser.close();

  // ---------- 11. Non-régression Task 36 (résumé compact) ----------
  const cookieRes = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signUp.idToken}` },
  });
  const setCookie = cookieRes.headers.get("set-cookie") || "";
  const cookie = (setCookie.match(/gen3ia_session=[^;]+/) || [""])[0];

  // pub PRO toujours diffusée
  const ads = await fetch(`${BASE}/api/ads/placement?placement=settings&mode=all`, { headers: { cookie } });
  const adsBody = await ads.json().catch(() => ({}));
  ok("11a/pub-pro", ads.status === 200 && Array.isArray(adsBody.ads) && adsBody.ads.length >= 1,
    `${adsBody.ads?.length ?? 0} annonce(s)`);

  // sw.js file hors-ligne
  const sw = await fetch(`${BASE}/sw.js`);
  const swText = await sw.text();
  ok("11b/sw-hors-ligne", sw.status === 200 && swText.includes("gen3ia-outbox"), `${swText.length} octets`);

  // logo officiel
  const logo = await fetch(`${BASE}/icons/icon-192.png?v=g3-logo-1`);
  const logoBuf = Buffer.from(await logo.arrayBuffer());
  ok("11c/logo-officiel", logo.status === 200 && logoBuf.length > 30000 && logoBuf[0] === 0x89, `${logoBuf.length} octets`);

  // NB : thème global + chat Gen IA + approbation conditionnelle sont
  // vérifiés par la suite Task 36 complète (scripts/verify_ea627f3_prod.mjs),
  // relancée en complément de ce script.

  console.log("\n=== RÉSULTAT AUDIT PRODUCTION ===");
  console.log(`${pass} OK / ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
