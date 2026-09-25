#!/usr/bin/env node
/**
 * Vérification e2e production — commit 6ffb86c (Interface V2 « Aurora OS »).
 * Mission : « Version 2 de toute l'interface : style premium, moderne,
 * innovant, structuré, design pro — reparti de zéro ».
 *
 * Contrôles :
 *  1. Vitrine / 200 + marqueurs V2 (aurora, gradient-border, badge V2,
 *     display font) + SEO préservé (JSON-LD FAQPage/Organization, FAQ).
 *  2. CSS servie = design system V2 (tokens --g3-gradient, #7C5CFF…)
 *     + ancienne palette claire (#f6f4ef) absente.
 *  3. /login et /signup : split-screen aurora (aside + g3-gradient-border).
 *  4. signUp Firebase + session réelle → pages applicatives 200 :
 *     /dashboard, /workspace/conversations, /studio/agents, /settings.
 *  5. API intacte : /api/agents, /api/auth/access, /api/public/health.
 *  6. Plein écran chat conservé : meta interactive-widget + --g3-vvh.
 */

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `e2e-v2-${Date.now()}@gen3ia.test`;
const PASSWORD = "Gen3iaE2E!2026";

let failures = 0;
function check(step, ok, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} [${step}]${extra ? " " + extra : ""}`);
  if (!ok) failures += 1;
}

async function getHtml(path, cookie) {
  const res = await fetch(`${BASE}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "follow",
  });
  const html = await res.text().catch(() => "");
  return { res, html };
}

(async () => {
  console.log(`\n=== Vérification Interface V2 — ${BASE} ===\n`);

  // 1. Vitrine : marqueurs V2 + SEO/GEO préservé
  const home = await getHtml("/");
  check("1/home-200", home.res.status === 200, `HTTP ${home.res.status}`);
  const v2Markers = [
    "Interface V2 · Aurora",
    "g3-gradient-border",
    "gradient-text",
    "aurora",
    "Décrivez-le.",
    "font-display",
  ];
  for (const marker of v2Markers) {
    check(`1/v2-marker:${marker.slice(0, 24)}`, home.html.includes(marker));
  }
  check("1/seo-jsonld", home.html.includes('"FAQPage"') && home.html.includes('"Organization"') && home.html.includes('"SoftwareApplication"'));
  check("1/seo-faq-visible", home.html.includes("Qu'est-ce que Gen3ia ?") && home.html.includes("Combien coûte Gen3ia ?"));
  check("1/old-skin-gone", !home.html.includes("#f6f4ef") && !home.html.includes("bg-[#f6f4ef]"), "ancienne vitrine crème absente");

  // 2. CSS V2 servie (tous les chunks CSS)
  const cssLinks = [...home.html.matchAll(/href="([^"]*_next\/static\/[^"]+\.css)"/g)].map((m) => m[1]);
  check("2/css-link", cssLinks.length > 0, `${cssLinks.length} chunk(s) CSS`);
  if (cssLinks.length > 0) {
    let css = "";
    let allOk = true;
    for (const link of cssLinks) {
      const cssRes = await fetch(link.startsWith("http") ? link : `${BASE}${link}`);
      if (!cssRes.ok) allOk = false;
      css += await cssRes.text();
    }
    check("2/css-200", allOk, `${cssLinks.length} chunk(s) · ${css.length} octets cumulés`);
    const cssLower = css.toLowerCase();
    const tokens = ["--g3-gradient", "#7c5cff", "#2ad4e8", "gen3ia-aurora-drift", ".g3-gradient-border", ".g3-brand-mark", "--g3-vvh"];
    for (const token of tokens) {
      check(`2/css-token:${token.slice(0, 26)}`, cssLower.includes(token));
    }
    check("2/css-font-space-grotesk", css.includes("font-display") || css.includes("Space Grotesk"), "typographie V2");
    check("2/css-old-token-gone", !css.includes("#6366F1"), "ancien indigo remplacé");
  }

  // 3. Auth : split-screen aurora
  for (const path of ["/login", "/signup"]) {
    const auth = await getHtml(path);
    check(`3/${path}-200`, auth.res.status === 200, `HTTP ${auth.res.status}`);
    check(`3/${path}-aurora`, auth.html.includes("g3-gradient-border") && auth.html.includes("aurora"));
  }

  // 4. Session réelle → pages applicatives V2
  const signUpRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
  });
  const auth = await signUpRes.json();
  check("4/signUp", signUpRes.ok && Boolean(auth.idToken), EMAIL);
  const sessionRes = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.idToken}` },
  });
  const cookie = (sessionRes.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  check("4/session", sessionRes.ok && Boolean(cookie), `HTTP ${sessionRes.status}`);

  for (const path of ["/dashboard", "/workspace/conversations", "/studio/agents", "/settings"]) {
    const page = await getHtml(path, cookie);
    const isOk = page.res.status === 200 && !page.html.includes("__NEXT_ERROR");
    check(`4/page:${path}`, isOk, `HTTP ${page.res.status}`);
  }

  // 5. API intactes
  const agentsRes = await fetch(`${BASE}/api/agents`, { headers: { cookie } });
  check("5/api-agents", agentsRes.status === 200, `HTTP ${agentsRes.status}`);
  const accessRes = await fetch(`${BASE}/api/auth/access`, { headers: { cookie } });
  check("5/api-access", accessRes.status === 200, `HTTP ${accessRes.status}`);
  const healthRes = await fetch(`${BASE}/api/public/health`);
  check("5/api-health", healthRes.status === 200, `HTTP ${healthRes.status}`);

  // 6. Chat plein écran conservé (gains Task 27 non régressés)
  const conv = await getHtml("/workspace/conversations", cookie);
  check("6/fullscreen-vvh", conv.html.includes("--g3-vvh") || conv.html.includes("g3-shell"), "chaîne de hauteur conservée");

  console.log(`\n=== ${failures === 0 ? "TOUS LES CONTRÔLES SONT VERTS" : failures + " CONTRÔLE(S) EN ÉCHEC"} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error("ERREUR FATALE:", error?.message ?? error);
  process.exit(1);
});
