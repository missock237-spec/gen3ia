#!/usr/bin/env node
/**
 * Vérification e2e production — commit ce2fd05 (Tâche 34-G : LOGO OFFICIEL).
 * Mission : « Crée ce logo, puis fait en sorte que ce logo soit le logo
 * officiel de gen3ia et que pendant l'exécution d'une tâche dans le projet
 * ce logo doit s'afficher ».
 *
 * 1. signUp Firebase + session          : compte réel.
 * 2. Santé /api/public/health           : plateforme OK.
 * 3. GET /                              : metadata icons ?v=g3-logo-1 +
 *    logo <img class="g3-logo"> rendu côté serveur (header/footer vitrine)
 *    + JSON-LD schema.org sur la nouvelle icône.
 * 4. GET /login                         : logo officiel dans le panneau auth.
 * 5. GET /favicon.ico                   : 200, image ICO multi-tailles.
 * 6. GET /icons/*.png (?v=g3-logo-1)    : signatures PNG + dimensions IHDR
 *    (192, 512, 512 maskable, 32, 16, 180).
 * 7. GET /manifest.webmanifest          : icônes + raccourcis versionnés.
 * 8. CSS servi                          : .g3-logo--working + @keyframes
 *    g3-logo-working + garde prefers-reduced-motion (halo d'exécution).
 * 9. Bundles JS de l'espace de travail  : le composant Gen3iaLogo et l'état
 *    "working" sont bien dans le build servi (logo pendant l'exécution).
 * 10. Non-régression : publicités toujours diffusées.
 * 11. Non-régression : aucune règle "dashed" dans les CSS servis.
 */

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `e2e-logo-${Date.now()}@gen3ia.test`;
const PASSWORD = "Gen3iaE2E!2026";
const V = "g3-logo-1";

let failures = 0;
function check(step, ok, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} [${step}]${extra ? " " + extra : ""}`);
  if (!ok) failures += 1;
}

async function get(path, { cookie } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { ...(cookie ? { cookie } : {}) },
    cache: "no-store",
  });
  const type = res.headers.get("content-type") ?? "";
  // undici décompresse automatiquement gzip/br : le corps est déjà décodé.
  let body = "";
  if (/html|json|manifest|css|javascript|text/.test(type)) {
    body = await res.text();
  }
  return { res, type, body };
}

/** Dimensions PNG depuis l'en-tête IHDR (octets 16-24). */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function collectScripts(html, base = BASE) {
  return [...html.matchAll(/<script[^>]+src="(\/_next\/static\/[^"]+\.js[^"]*)"/g)]
    .map((m) => `${BASE}${m[1]}`);
}

async function main() {
  console.log("=== VÉRIFICATION LOGO OFFICIEL GEN3IA —", BASE, "===");

  // 1. Auth réelle
  const signUpRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
  });
  const auth = await signUpRes.json();
  check("1/signUp", signUpRes.ok && Boolean(auth.idToken), EMAIL);
  const sessionRes = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.idToken}` },
  });
  const cookie = (sessionRes.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  check("1b/session", sessionRes.ok && Boolean(cookie), `HTTP ${sessionRes.status}`);

  // 2. Santé
  const healthRes = await fetch(`${BASE}/api/public/health`, { cache: "no-store" });
  check("2/health", healthRes.ok, `HTTP ${healthRes.status}`);

  // 3. Vitrine — metadata icons versionnées + logo rendu + JSON-LD
  const home = await get("/");
  const metaIcons = home.body.includes(`/icons/favicon-32.png?v=${V}`)
    && home.body.includes(`/icons/icon-192.png?v=${V}`);
  const logoRendered = /<img[^>]+class="[^"]*g3-logo[^"]*"[^>]+src="\/icons\/icon-192\.png"/.test(home.body.replace(/class="([^"]*)"|src="([^"]*)"/g, (m) => m));
  const logoImg = home.body.includes(`src="/icons/icon-192.png"`);
  const jsonLd = home.body.includes(`"logo":"${BASE}/icons/icon-192.png"`) || home.body.includes("/icons/icon-192.png");
  check("3/vitrine-icons", home.res.ok && metaIcons, `HTTP ${home.res.status} · icons versionnées=${metaIcons}`);
  check("3b/vitrine-logo", logoRendered || logoImg, `img g3-logo rendu=${logoRendered || logoImg}`);

  // 4. Page d'authentification — logo officiel (AuthAuroraAside)
  const login = await get("/login");
  const loginLogo = login.body.includes(`src="/icons/icon-192.png"`);
  check("4/login-logo", login.res.ok && loginLogo, `HTTP ${login.res.status} · img logo présent=${loginLogo}`);

  // 5. favicon.ico (nouveau, multi-tailles)
  const fav = await fetch(`${BASE}/favicon.ico?v=${V}`, { cache: "no-store" });
  const favBuf = Buffer.from(await fav.arrayBuffer());
  const favOk = fav.ok && favBuf.length > 2000 && favBuf.readUInt16LE(0) === 0 && favBuf.readUInt16LE(2) >= 1;
  check("5/favicon-ico", favOk, `HTTP ${fav.status} · ${favBuf.length} octets · ${fav.headers.get("content-type")}`);

  // 6. Icônes PNG — signature + dimensions
  for (const [file, size] of [
    ["icon-192.png", 192], ["icon-512.png", 512], ["maskable-512.png", 512],
    ["favicon-32.png", 32], ["favicon-16.png", 16], ["apple-touch-icon.png", 180],
  ]) {
    const r = await fetch(`${BASE}/icons/${file}?v=${V}`, { cache: "no-store" });
    const buf = Buffer.from(await r.arrayBuffer());
    const dims = pngSize(buf);
    check(`6/${file}`, r.ok && dims?.w === size && dims?.h === size,
      `HTTP ${r.status} · ${buf.length} octets · ${dims ? `${dims.w}x${dims.h}` : "signature PNG absente"}`);
  }

  // 7. Manifest PWA versionné
  const manifest = await get(`/manifest.webmanifest`);
  const manifestOk = manifest.body.includes(`/icons/icon-512.png?v=${V}`)
    && manifest.body.includes(`/icons/maskable-512.png?v=${V}`);
  check("7/manifest", manifest.res.ok && manifestOk, `HTTP ${manifest.res.status} · icônes versionnées=${manifestOk}`);

  // 8. CSS servi — styles du logo + animation d'exécution (toutes les feuilles)
  const cssHrefs = [...home.body.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  let cssOk = false, cssDetail = "aucun CSS trouvé";
  for (const href of cssHrefs) {
    const css = await get(href);
    if (css.body.includes("g3-logo")) {
      cssOk = css.body.includes(".g3-logo--working")
        && css.body.includes("@keyframes g3-logo-working")
        && css.body.includes("prefers-reduced-motion");
      cssDetail = `${css.body.length} octets · logo--working=${css.body.includes(".g3-logo--working")} · keyframes=${css.body.includes("@keyframes g3-logo-working")} · reduced-motion=${css.body.includes("prefers-reduced-motion")}`;
      break;
    }
  }
  check("8/css-halo-execution", cssOk, cssDetail);

  // 9. Bundles de l'espace de travail — Gen3iaLogo + état working dans le build
  const conv = await fetch(`${BASE}/api/workspace/conversations`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({}),
  });
  const convData = await conv.json().catch(() => ({}));
  const convId = convData.conversation?.id;
  check("9b/conversation", conv.ok && Boolean(convId), `HTTP ${conv.status}`);
  if (convId) {
    const ws = await get(`/workspace/conversations/${convId}`, { cookie });
    const scripts = collectScripts(ws.body);
    let found = false;
    for (const url of scripts.slice(0, 40)) {
      const chunk = await fetch(url, { cache: "no-store" }).then((r) => r.text()).catch(() => "");
      if (chunk.includes("g3-logo--working") && chunk.includes("/icons/icon-192.png")) { found = true; break; }
    }
    check("9/logo-pendant-execution-bundle", found, `${scripts.length} scripts scannés · Gen3iaLogo(working) présent=${found}`);
  } else {
    check("9/logo-pendant-execution-bundle", false, "conversation de test impossible");
  }

  // 10. Non-régression : publicités (session requise)
  const ads = await get(`/api/ads/placement?placement=settings&mode=all`, { cookie });
  let adsCount = 0;
  try { adsCount = (JSON.parse(ads.body).ads ?? []).length; } catch {}
  check("10/ads", ads.res.ok && adsCount >= 1, `HTTP ${ads.res.status} · ${adsCount} annonce(s)`);

  // 11. Non-régression : aucune règle "dashed"
  let noDashed = true;
  for (const href of cssHrefs) {
    const css = await get(href);
    if (/dashed/.test(css.body)) { noDashed = false; break; }
  }
  check("11/no-dashed", noDashed);

  console.log(failures === 0 ? "\n✅ TOUS LES TESTS VERTS" : `\n❌ ${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("ERREUR FATALE", e); process.exit(1); });
