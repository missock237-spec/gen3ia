#!/usr/bin/env node
/**
 * Vérification e2e production — commit 07b5b85 (Tâche 35).
 * Mission : « Fait en sorte que les interfaces qui sont délimitées ne le
 * soient plus, puis fait en sorte que les agents puissent utiliser une API,
 * appeler une API pour l'utiliser ».
 *
 * 1. signUp Firebase + session                      : compte réel.
 * 2. Santé /api/public/health                       : plateforme OK.
 * 3. CSS servi                                      : règle globale
 *    border-color: transparent !important présente (aucune interface
 *    délimitée) — et aucune réapparition de "dashed".
 * 4. APPEL API RÉEL PAR URL : « Appelle cette API et dis-moi ce qu'elle
 *    contient : https://jsonplaceholder.typicode.com/users/1 »
 *    → étape web.api done + VRAIES données (Leanne Graham) dans la réponse.
 * 5. Non-régression : logo officiel toujours servi (icon-192, 192×192).
 * 6. Non-régression : publicités toujours diffusées.
 */

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `e2e-api-${Date.now()}@gen3ia.test`;
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

function finalMessage(events) {
  const complete = [...events].reverse().find((e) => e.type === "message_complete")?.message;
  return complete?.content ?? "";
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

async function main() {
  console.log("=== VÉRIFICATION SANS DÉLIMITATION + API DIRECTE —", BASE, "===");

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

  // 3. CSS servi — aucune délimitation
  const home = await fetch(`${BASE}/`, { cache: "no-store" }).then((r) => r.text());
  const cssHrefs = [...home.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  let noBorders = false, dashedFound = false;
  for (const href of cssHrefs) {
    const css = await fetch(href.startsWith("http") ? href : `${BASE}${href}`, { cache: "no-store" }).then((r) => r.text());
    // Lightning CSS sérialise transparent → #0000 et ::before → :before.
    const flat = css.replace(/\s+/g, "");
    if (/border-color:(#0000|transparent)!important/.test(flat)) noBorders = true;
    if (/dashed/.test(css)) dashedFound = true;
  }
  check("3/sans-delimitation", noBorders && !dashedFound,
    `${cssHrefs.length} feuille(s) · border-color transparent global=${noBorders} · dashed résiduel=${dashedFound}`);

  // 4. APPEL API RÉEL PAR URL (2 tentatives — dépendance externe)
  let step4ok = false, step4detail = "";
  for (let attempt = 1; attempt <= 2 && !step4ok; attempt += 1) {
    const c4 = await newConversation(cookie);
    const r4 = await consumeStream(cookie, c4,
      "Appelle cette API et dis-moi ce qu'elle contient : https://jsonplaceholder.typicode.com/users/1");
    const msg4 = finalMessage(r4.events).replace(/\u00A0/g, " ");
    const steps4 = runSteps(r4.events);
    const webApiStep = steps4.find((s) => s.toolName === "web.api");
    const hasRealData = /Leanne Graham/i.test(msg4) || steps4.some((s) => s.output && /Leanne Graham/i.test(s.output.replace(/\u00A0/g, " ")));
    step4ok = r4.status === 200 && webApiStep?.status === "done" && hasRealData;
    step4detail = `HTTP ${r4.status} · ${(r4.ms / 1000).toFixed(1)}s · étape web.api=${webApiStep ? `« ${webApiStep.status} »` : "absente"} · données réelles=${hasRealData} · « ${msg4.slice(0, 110).replace(/\s+/g, " ")} »`;
    if (!step4ok && attempt === 1) await new Promise((r) => setTimeout(r, 4000));
  }
  check("4/api-directe-url", step4ok, step4detail);

  // 5. Non-régression : logo officiel
  const logoRes = await fetch(`${BASE}/icons/icon-192.png?v=g3-logo-1`, { cache: "no-store" });
  const logoBuf = Buffer.from(await logoRes.arrayBuffer());
  const logoOk = logoRes.ok && logoBuf.length > 24 && logoBuf.readUInt32BE(0) === 0x89504e47
    && logoBuf.readUInt32BE(16) === 192 && logoBuf.readUInt32BE(20) === 192;
  check("5/logo-officiel", logoOk, `HTTP ${logoRes.status} · ${logoBuf.length} octets · 192x192=${logoOk}`);

  // 6. Non-régression : publicités
  const ads = await fetch(`${BASE}/api/ads/placement?placement=settings&mode=all`, { headers: { cookie }, cache: "no-store" });
  const adsData = await ads.json().catch(() => ({}));
  const adsCount = Array.isArray(adsData?.ads) ? adsData.ads.length : 0;
  check("6/ads", ads.ok && adsCount >= 1, `HTTP ${ads.status} · ${adsCount} annonce(s)`);

  console.log(failures === 0 ? "\n✅ TOUS LES TESTS VERTS" : `\n❌ ${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("ERREUR FATALE", e); process.exit(1); });
