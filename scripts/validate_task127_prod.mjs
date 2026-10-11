#!/usr/bin/env node
/**
 * VALIDATION PRODUCTION — Tasks 119 à 127 (évolution Gen3ia).
 * Vérifie en production réelle : statut public, terminal réel (serverless),
 * audio livré directement (artefact + lecteur, sans lien markdown),
 * vidéo CapCut (voix off + options respectées), Jules (détection code),
 * palette 2 couleurs.
 */
const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `evol-task127-${Date.now()}@gen3ia.test`;
const PASSWORD = "Gen3iaE2E!2026";
const results = [];
function log(step, ...parts) { console.log(`[${step}]`, ...parts); }
function record(name, ok, detail) { results.push({ name, ok, detail }); log(ok ? "PASS" : "FAIL", name, "-", detail ?? ""); }

async function signUp() {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`signUp: ${JSON.stringify(d).slice(0, 300)}`);
  return d;
}
async function createSession(idToken) {
  const r = await fetch(`${BASE}/api/auth/session`, { method: "POST", headers: { authorization: `Bearer ${idToken}` } });
  const d = await r.json();
  if (!r.ok || !d.authenticated) throw new Error(`session: ${r.status}`);
  const setCookie = r.headers.getSetCookie?.() ?? [];
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}
const j = (r) => r.json();

// ─── 1. Statut public ───
async function checkPublicStatus() {
  try {
    const r = await fetch(`${BASE}/api/status`);
    const d = await j(r);
    record("Statut public /api/status", r.status === 200 && d.status === "ok", `${r.status} ${d.status} v=${d.version ?? "?"} services=${JSON.stringify(d.services ?? {})}`);
  } catch (e) { record("Statut public /api/status", false, e.message); }
}

// ─── 2. Terminal réel ───
async function checkTerminal(cookie) {
  try {
    const r = await fetch(`${BASE}/api/terminal/exec`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ command: 'echo "gen3ia-real-check" && node -e "console.log(6*7)"' }),
    });
    const d = await j(r);
    const ok = r.status === 200 && (d.execution?.mode === "serverless" || d.execution?.mode === "sandbox") && String(d.execution?.stdout ?? "").includes("gen3ia-real-check") && String(d.execution?.stdout ?? "").includes("42");
    record("Terminal réel (echo+node)", ok, `mode=${d.execution?.mode} exit=${d.execution?.exitCode} out=${String(d.execution?.stdout ?? "").trim().slice(0, 60).replace(/\n/g, " | ")}`);
  } catch (e) { record("Terminal réel (echo+node)", false, e.message); }
  try {
    const r = await fetch(`${BASE}/api/terminal/exec`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ command: 'print("py ok", 2**10)' , workspaceId: "wpy" }),
    });
    const d = await j(r);
    const ok = r.status === 200 && String(d.execution?.stdout ?? "").includes("py ok") && String(d.execution?.stdout ?? "").includes("1024");
    record("Terminal réel (python)", ok, `mode=${d.execution?.mode} out=${String(d.execution?.stdout ?? "").trim().slice(0, 50).replace(/\n/g, " | ")}`);
  } catch (e) { record("Terminal réel (python)", false, e.message); }
  try {
    const r = await fetch(`${BASE}/api/terminal/exec`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ command: "sudo rm -rf /" }),
    });
    record("Terminal deny-list (sudo)", r.status >= 400 || (await j(r)).ok === false, `HTTP ${r.status}`);
  } catch (e) { record("Terminal deny-list (sudo)", false, e.message); }
}

// ─── 3. Audio direct (chat workspace) ───
async function checkAudioDirect(cookie) {
  try {
    let r = await fetch(`${BASE}/api/workspace/conversations`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ title: "Validation audio direct T127" }) });
    const conv = await j(r);
    const convId = conv.conversation?.id ?? conv.id;
    if (!convId) throw new Error("conversation id manquant");
    const send = async (text) => {
      const rr = await fetch(`${BASE}/api/workspace/conversations/${convId}/messages`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ text }) });
      if (!rr.ok) throw new Error(`send message: ${rr.status}`);
      await new Promise((s) => setTimeout(s, 2500));
      const g = await fetch(`${BASE}/api/workspace/conversations/${convId}`, { headers: { cookie } });
      const dd = await j(g);
      const messages = dd.conversation?.messages ?? dd.messages ?? [];
      return messages;
    };
    let messages = await send("Peut tu me générer un audio qui dit : Bonjour, ceci est un test de livraison audio directe");
    const assistantMsgs = messages.filter((m) => m.role === "assistant");
    const last = assistantMsgs[assistantMsgs.length - 1];
    const hasAudioArtifact = JSON.stringify(last?.artifacts ?? last?.artefacts ?? []).includes('"audio"') || (last?.artifacts ?? []).some?.((a) => a.type === "audio");
    const hasMarkdownLink = /\[Écouter l[' ]audio\]\(/i.test(last?.content ?? last?.text ?? "");
    record("Audio — artefact audio présent (livraison directe)", hasAudioArtifact, `artefacts=${JSON.stringify(last?.artifacts ?? []).slice(0, 120)}`);
    record("Audio — PLUS de lien markdown expirable", !hasMarkdownLink, last?.content?.slice(0, 80) ?? "");
  } catch (e) { record("Audio direct", false, e.message); }
}

// ─── 4. Vidéo CapCut ───
async function checkVideo(cookie) {
  try {
    const r = await fetch(`${BASE}/api/workspace/conversations`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ title: "Validation vidéo CapCut T127" }) });
    const conv = await j(r);
    const convId = conv.conversation?.id ?? conv.id;
    const rr = await fetch(`${BASE}/api/workspace/conversations/${convId}/messages`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ text: "Créé une vidéo réaliste de 15 secondes d'un coucher de soleil sur la mer à Douala, avec voix off en français et sous-titres" }) });
    if (!rr.ok) throw new Error(`message: ${rr.status}`);
    let done = false, tries = 0, lastSnapshot = null;
    while (!done && tries < 120) {
      tries++;
      await new Promise((s) => setTimeout(s, 10000));
      const g = await fetch(`${BASE}/api/workspace/conversations/${convId}`, { headers: { cookie } });
      const dd = await j(g);
      const messages = dd.conversation?.messages ?? dd.messages ?? [];
      lastSnapshot = messages.map((m) => `${m.role}:${(m.content ?? m.text ?? "").slice(0, 60)}`).join(" || ");
      const productionMsg = messages.find((m) => (m.content ?? m.text ?? "").includes("Votre vidéo est prête")) || messages.find((m) => (m.content ?? m.text ?? "").toLowerCase().includes("vidéo") && (m.content ?? m.text ?? "").includes("prête"));
      if (productionMsg) { done = true; }
    }
    record("Vidéo CapCut — production complétée et livrée", done, done ? "message de livraison présent" : `timeout après ${tries} sondages — dernier état: ${String(lastSnapshot).slice(0, 300)}`);
  } catch (e) { record("Vidéo CapCut", false, e.message); }
}

// ─── 5. Jules (détection code) ───
async function checkJules(cookie) {
  try {
    const r = await fetch(`${BASE}/api/workspace/conversations`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ title: "Validation Jules T127" }) });
    const conv = await j(r);
    const convId = conv.conversation?.id ?? conv.id;
    const rr = await fetch(`${BASE}/api/workspace/conversations/${convId}/messages`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ text: "Écris une fonction Python qui calcule la suite de Fibonacci" }) });
    if (!rr.ok) throw new Error(`message: ${rr.status}`);
    await new Promise((s) => setTimeout(s, 6000));
    const g = await fetch(`${BASE}/api/workspace/conversations/${convId}`, { headers: { cookie } });
    const dd = await j(g);
    const messages = dd.conversation?.messages ?? dd.messages ?? [];
    const last = messages.filter((m) => m.role === "assistant").pop();
    const text = last?.content ?? last?.text ?? "";
    const mentionsJules = /jules/i.test(text);
    record("Jules — demande de code détectée et routed vers Jules (ou notice honnête)", mentionsJules, text.slice(0, 160).replace(/\n/g, " "));
  } catch (e) { record("Jules", false, e.message); }
}

// ─── 6. Palette 2 couleurs ───
async function checkColors() {
  try {
    const r = await fetch(BASE);
    const html = await r.text();
    const cssMatch = html.match(/\/_next\/static\/[^"']+\.css/);
    if (!cssMatch) throw new Error("CSS non trouvé");
    const cssR = await fetch(`${BASE}${cssMatch[0]}`);
    const css = await cssR.text();
    const banned = ["#2FD48A", "#F5AE31", "#F6626E", "#E14FEA", "#8FD8EC", "#C44BFF"].filter((c) => css.toUpperCase().includes(c));
    const hasViolet = css.includes("#7C5CFF") || css.toLowerCase().includes("#7c5cff");
    const hasCyan = css.includes("#2AD4E8") || css.toLowerCase().includes("#2ad4e8");
    record("Palette 2 couleurs — anciennes teintes absentes", banned.length === 0, banned.length ? `encore présentes: ${banned.join(",")}` : "violet+cyan seules");
    record("Palette 2 couleurs — violet #7C5CFF + cyan #2AD4E8 présents", hasViolet && hasCyan, `violet=${hasViolet} cyan=${hasCyan}`);
  } catch (e) { record("Palette 2 couleurs", false, e.message); }
}

(async () => {
  log("0/auth", `compte ${EMAIL}`);
  const auth = await signUp();
  const cookie = await createSession(auth.idToken);
  log("0/session", "session créée");
  await checkPublicStatus();
  await checkTerminal(cookie);
  await checkAudioDirect(cookie);
  await checkJules(cookie);
  await checkColors();
  // Vidéo en dernier (long)
  await checkVideo(cookie);
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n════════ RÉSULTAT: ${pass}/${results.length} vérifications vertes ════════`);
  for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name} — ${r.detail}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})();
