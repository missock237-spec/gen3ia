#!/usr/bin/env node
/**
 * Vérification e2e production — commit 17ce75e.
 * Mission : suppression du chat IA (Gen) + chats plein écran à tout moment.
 *
 * 1.  GET  /                                  : 200, plus aucun bouton/chat Gen.
 * 2.  Meta viewport                           : interactive-widget=resizes-content.
 * 3.  POST /api/gen/chat                      : 404 (route supprimée).
 * 4.  GET  /api/health                        : 200 (non-régression).
 * 5.  signUp Firebase + session               : compte réel + cookie.
 * 6.  GET  /workspace/conversations (auth)    : 200 + CSS plein écran (--g3-vvh).
 * 7.  GET  /studio/agents (auth)              : 200.
 * 8.  GET  /api/agents (auth)                 : 200 (backend chat agent intact).
 * 9.  CSS                                     : var(--g3-vvh, 100dvh) servie.
 */

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `e2e-fullscreen-${Date.now()}@gen3ia.test`;
const PASSWORD = "Gen3iaE2E!2026";

let failures = 0;
function check(step, ok, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} [${step}] ${ok ? "" : "— ÉCHEC"}${extra ? " " + extra : ""}`);
  if (!ok) failures += 1;
}

async function main() {
  // 1. Accueil sans Gen
  const home = await fetch(`${BASE}/`, { cache: "no-store" });
  const homeHtml = await home.text();
  check("1/accueil", home.ok, `HTTP ${home.status}`);
  const genButtonGone = !homeHtml.includes("Discuter avec Gen") && !homeHtml.includes("gen-chat") && !homeHtml.includes("assistante Gen3ia");
  check("1b/gen-retiré", genButtonGone, "aucune trace du widget Gen dans l'accueil");

  // 2. Viewport plein écran (clavier)
  const viewportOk = homeHtml.includes("interactive-widget=resizes-content");
  check("2/viewport", viewportOk, "interactive-widget=resizes-content présent");

  // 3. Route Gen supprimée
  const genRoute = await fetch(`${BASE}/api/gen/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "ping" }),
  });
  check("3/gen-404", genRoute.status === 404, `HTTP ${genRoute.status} (attendu 404)`);

  // 4. Santé
  const health = await fetch(`${BASE}/api/health`, { cache: "no-store" });
  check("4/health", health.ok, `HTTP ${health.status}`);

  // 5. Auth réelle
  const signUpRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
  });
  const auth = await signUpRes.json();
  check("5/signUp", signUpRes.ok && Boolean(auth.idToken), EMAIL);
  const sessionRes = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.idToken}` },
  });
  const setCookie = sessionRes.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  check("5b/session", sessionRes.ok && Boolean(cookie), "cookie de session posé");

  const headers = { cookie, "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36" };

  // 6. Conversation plein écran
  const conv = await fetch(`${BASE}/workspace/conversations`, { headers, cache: "no-store" });
  const convHtml = await conv.text();
  check("6/conversations", conv.ok, `HTTP ${conv.status}`);
  const cssUrls = [...convHtml.matchAll(/href="(\/_next\/static\/[^"]+\.css)"/g)].map((m) => m[1]);
  check("6b/conv-css", cssUrls.length > 0, `${cssUrls.length} feuille(s) de style liée(s)`);

  // 7. Chat d'agent IA plein écran
  const agents = await fetch(`${BASE}/studio/agents`, { headers, cache: "no-store" });
  check("7/studio-agents", agents.ok, `HTTP ${agents.status}`);

  // 8. Backend agent intact
  const agentsApi = await fetch(`${BASE}/api/agents`, { headers, cache: "no-store" });
  const agentsData = await agentsApi.json().catch(() => ({}));
  check("8/api-agents", agentsApi.ok && Array.isArray(agentsData.agents), `HTTP ${agentsApi.status} · ${Array.isArray(agentsData.agents) ? agentsData.agents.length : "?"} agent(s)`);

  // 9. CSS plein écran : variable --g3-vvh consommée par .g3-shell
  if (cssUrls.length > 0) {
    let vvhOk = false;
    for (const url of cssUrls) {
      const css = await (await fetch(`${BASE}${url}`, { cache: "no-store" })).text();
      if (css.includes("--g3-vvh") && css.includes("var(--g3-vvh")) { vvhOk = true; break; }
    }
    check("9/css-vvh", vvhOk, "--g3-vvh servie et consommée par .g3-shell");
  } else {
    check("9/css-vvh", false, "aucune feuille de style trouvée");
  }

  console.log(failures === 0 ? "\n✅ TOUS LES CONTRÔLES VERTS" : `\n❌ ${failures} contrôle(s) en échec`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("FATAL", error);
  process.exit(1);
});
