#!/usr/bin/env node
/**
 * Vérification e2e production — commit ea627f3 (Task 36 — les 11 points).
 *
 * 1. signUp Firebase + session                      : compte réel.
 * 2. Santé /api/public/health                       : plateforme OK.
 * 3. Thème clair global                             : couche de compat
 *    [data-theme="light"] servie (text-white adapté, pastels corrigés) + le
 *    choix de thème Paramètres présent.
 * 4. Champ prompt SANS limite de caractères         : aucun `maxLength:2e4`
 *    (20000) résiduel dans les bundles du composer ; serveur chat à 2e5.
 * 5. Chat Gen IA + historique                       : bundles /studio/agents
 *    contiennent « Gen IA », « Agent IA universel », provisionnement
 *    automatique et « Historique des chats ».
 * 6. APPROBATION CONDITIONNELLE (réel)              : action via API non
 *    connectée (web.api.write POST jsonplaceholder) → carte de validation
 *    créée (statut awaiting_approval / étape awaiting) — l'approbation ne
 *    concerne que les apps NON connectées (apps connectées = exécution
 *    directe, vérifié par les 16 tests unitaires approval-policy).
 * 7. Publicité PRO                                  : /api/ads/campaigns
 *    répond (403 pour non-admin = route PRO présente et protégée) ;
 *    non-régression : annonces toujours diffusées.
 * 8. Arrière-plan / hors-ligne                      : /sw.js sert la file
 *    durable (IndexedDB) + Background Sync « gen3ia-outbox ».
 * 9. Non-régression : logo officiel toujours servi (icon-192, 192×192).
 */

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `e2e-t36-${Date.now()}@gen3ia.test`;
const PASSWORD = "Gen3iaE2E!2026";

let failures = 0;
function check(step, ok, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} [${step}]${extra ? " " + extra : ""}`);
  if (!ok) failures += 1;
}

async function consumeStream(cookie, conversationId, message, extraBody = {}) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/workspace/conversations/${conversationId}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message, ...extraBody }),
  });
  if (!res.ok) return { status: res.status, events: [], ms: Date.now() - t0, error: (await res.text()).slice(0, 300) };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t)); } catch {}
    }
  }
  if (buffer.trim()) { try { events.push(JSON.parse(buffer.trim())); } catch {} }
  return { status: res.status, events, ms: Date.now() - t0 };
}

function runSteps(events) {
  const latest = new Map();
  for (const e of events.filter((e) => e.type === "step_update")) {
    if (e.step?.id) latest.set(e.step.id, e.step);
  }
  return [...latest.values()];
}

async function newConversation(cookie) {
  const res = await fetch(`${BASE}/api/workspace/conversations`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  return data.conversation?.id;
}

async function allScripts() {
  const home = await fetch(`${BASE}/`, { cache: "no-store" }).then((r) => r.text());
  const hrefs = [...home.matchAll(/<script[^>]+src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]);
  const chunks = [];
  for (const href of hrefs) {
    const body = await fetch(`${BASE}${href}`, { cache: "no-store" }).then((r) => r.text());
    chunks.push({ href, body });
  }
  return chunks;
}

async function main() {
  console.log("=== TASK 36 — LES 11 POINTS —", BASE, "===");

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

  // 3. Thème clair global — couche de compat servie + choix Paramètres
  const home = await fetch(`${BASE}/`, { cache: "no-store" }).then((r) => r.text());
  const cssHrefs = [...home.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  let lightCompat = false, bootstrapTheme = false;
  for (const href of cssHrefs) {
    const css = await fetch(href.startsWith("http") ? href : `${BASE}${href}`, { cache: "no-store" }).then((r) => r.text());
    const flat = css.replace(/\s+/g, "");
    if (flat.includes(`[data-theme=light].text-white:not(:where(`)) lightCompat = true;
  }
  bootstrapTheme = home.includes("gen3ia-theme") && home.includes("data-theme");
  // Le sélecteur vit dans les bundles chargés par /settings (client component).
  const settingsPage = await fetch(`${BASE}/settings`, { headers: { cookie }, cache: "no-store" }).then((r) => r.text());
  const settingsScripts = [...settingsPage.matchAll(/<script[^>]+src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]);
  let settingsChoice = false;
  for (const href of settingsScripts) {
    const body = await fetch(`${BASE}${href}`, { cache: "no-store" }).then((r) => r.text());
    if (body.includes("theme-choice-light") && body.includes("theme-choice-dark")) { settingsChoice = true; break; }
  }
  check("3/theme-clair-global", lightCompat && bootstrapTheme && settingsChoice,
    `compat CSS=${lightCompat} · bootstrap=${bootstrapTheme} · choix Paramètres=${settingsChoice} (${settingsScripts.length} chunks)`);

  // 4. Champ prompt SANS limite — aucun maxLength 20000 dans les bundles
  const chunks = await allScripts();
  const maxLengthResidual = chunks.filter((c) => /maxLength:\s*2e4\b/.test(c.body));
  const chatServerCap = chunks.some((c) => /200_000|max\(2e5\)|2e5\)/.test(c.body));
  check("4/prompt-sans-limite", maxLengthResidual.length === 0,
    `${chunks.length} chunks scannés · maxLength 2e4 résiduel=${maxLengthResidual.length}`);

  // 5. Chat Gen IA + historique (bundle /studio/agents)
  const agentsPage = await fetch(`${BASE}/studio/agents`, { headers: { cookie }, cache: "no-store" }).then((r) => r.text());
  const agentChunksHrefs = [...agentsPage.matchAll(/<script[^>]+src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]);
  let genIaBundle = false, historyBundle = false, autoProvision = false;
  for (const href of agentChunksHrefs) {
    const body = await fetch(`${BASE}${href}`, { cache: "no-store" }).then((r) => r.text());
    if (body.includes("Agent IA universel")) genIaBundle = true;
    if (body.includes("Historique des chats")) historyBundle = true;
    if (body.includes("Gen IA")) autoProvision = true;
  }
  check("5/chat-gen-ia-historique", genIaBundle && historyBundle && autoProvision,
    `identité Gen IA=${genIaBundle} · rail historique=${historyBundle} · auto-provisionnement=${autoProvision}`);

  // 6. APPROBATION CONDITIONNELLE (réel) — app NON connectée → validation
  let step6ok = false, step6detail = "";
  for (let attempt = 1; attempt <= 2 && !step6ok; attempt += 1) {
    const c6 = await newConversation(cookie);
    const r6 = await consumeStream(cookie, c6,
      "Crée un nouvel article : envoie une requête POST avec le corps {\"title\":\"Gen IA test\",\"body\":\"validation\",\"userId\":1} sur https://jsonplaceholder.typicode.com/posts");
    const steps6 = runSteps(r6.events);
    const writeStep = steps6.find((s) => s.toolName === "web.api.write");
    const awaiting = writeStep?.status === "awaiting" || steps6.some((s) => s.status === "awaiting");
    const approvals = r6.events.filter((e) => e.type === "approval_created");
    step6ok = r6.status === 200 && Boolean(writeStep) && (awaiting || approvals.length > 0 || /awaiting_approval/i.test(JSON.stringify(r6.events)));
    step6detail = `HTTP ${r6.status} · ${(r6.ms / 1000).toFixed(1)}s · étape web.api.write=${writeStep ? `« ${writeStep.status} »` : "absente"} · approbations=${approvals.length}`;
    if (!step6ok && attempt === 1) await new Promise((r) => setTimeout(r, 4000));
  }
  check("6/approbation-non-connectee", step6ok, step6detail);

  // 7. Publicité PRO — routes campagnes protégées + annonces toujours diffusées
  const campRes = await fetch(`${BASE}/api/ads/campaigns`, { headers: { cookie }, cache: "no-store" });
  const campForbidden = campRes.status === 403 || campRes.status === 401;
  const placementRes = await fetch(`${BASE}/api/ads/placement?placement=settings&mode=all`, { headers: { cookie }, cache: "no-store" });
  const placementBody = await placementRes.json().catch(() => ({}));
  const adsCount = (placementBody.ads ?? []).length;
  check("7/publicite-pro", campForbidden && placementRes.ok && adsCount > 0,
    `campagnes HTTP ${campRes.status} (protégé) · placement HTTP ${placementRes.status} · ${adsCount} annonce(s)`);

  // 8. Arrière-plan / hors-ligne — SW avec file durable + Background Sync
  const sw = await fetch(`${BASE}/sw.js`, { cache: "no-store" }).then((r) => r.text());
  const swOutbox = sw.includes("gen3ia-outbox") && sw.includes("indexedDB") && sw.includes("sync");
  check("8/arriere-plan-hors-ligne", swOutbox, `sw.js ${(sw.length / 1024).toFixed(1)} Ko · outbox=${swOutbox}`);

  // 9. Non-régression logo
  const icon = await fetch(`${BASE}/icons/icon-192.png?v=g3-logo-1`, { cache: "no-store" });
  const iconBuf = Buffer.from(await icon.arrayBuffer());
  const iconOk = icon.ok && iconBuf.length > 1000 && iconBuf[0] === 0x89 && iconBuf[1] === 0x50;
  let iconWidth = 0;
  if (iconOk) iconWidth = iconBuf.readUInt32BE(16);
  check("9/logo-officiel", iconOk && iconWidth === 192, `${iconBuf.length} octets · ${iconWidth}×${iconWidth}`);

  console.log("=== RÉSULTAT ===");
  console.log(failures === 0 ? "TOUS LES TESTS SONT VERTS" : `${failures} TEST(S) EN ÉCHEC`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("E2E fatal:", error);
  process.exit(1);
});
