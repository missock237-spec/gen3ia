#!/usr/bin/env node
/**
 * Sonde STICKY : lance une vidéo et, une fois stage=done atteint, sonde
 * LONGUEMENT (10 min) le job + le fil pour déterminer si le job finit
 * « completed » et si la livraison chat arrive. Enregistre chaque changement.
 */
const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `sticky-vid-${Date.now()}@gen3ia.test`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const a = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: "Gen3iaE2E!2026", returnSecureToken: true }),
  }).then((x) => x.json());
  const s = await fetch(`${BASE}/api/auth/session`, { method: "POST", headers: { authorization: `Bearer ${a.idToken}` } });
  const cookie = (s.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const conv = await fetch(`${BASE}/api/workspace/conversations`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "Sticky vidéo" }),
  }).then((x) => x.json());
  const conversationId = conv.conversation?.id ?? conv.id;
  const send = (message) =>
    fetch(`${BASE}/api/workspace/conversations/${conversationId}/messages`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ message }),
    }).then((x) => x.json());
  const list = () =>
    fetch(`${BASE}/api/workspace/conversations/${conversationId}`, { headers: { cookie } }).then((x) => x.json());

  const t1 = await send("Créé une vidéo de 5s d'un bébé qui marche");
  const projectId = t1.artifacts?.[0]?.videoProjectId;
  console.log("projet:", projectId, "· conversation:", conversationId);

  let doneReached = false;
  for (let i = 0; i < 30 && !doneReached; i += 1) {
    await sleep(20000);
    const st = await fetch(`${BASE}/api/video/projects/${projectId}/production`, { headers: { cookie } }).then((x) => x.json().catch(() => ({})));
    console.log(`[poll ${i}] status=${st.status} stage=${st.stage} progress=${st.progress}`);
    if (st.stage === "done" || st.status === "completed" || st.status === "failed") doneReached = true;
  }
  console.log("--- phase done : sonde longue du statut ET du fil ---");
  for (let j = 0; j < 30; j += 1) {
    await sleep(20000);
    const st = await fetch(`${BASE}/api/video/projects/${projectId}/production`, { headers: { cookie } }).then((x) => x.json().catch(() => ({})));
    const messages = await list().catch(() => ({}));
    const docs = messages.conversation?.messages ?? messages.messages ?? messages;
    const items = Array.isArray(docs) ? docs : docs.items ?? [];
    const assistantCount = items.filter((m) => m.role === "assistant").length;
    const lastContent = [...items].reverse().find((m) => m.role === "assistant")?.content ?? "";
    const delivered = /Votre vidéo est prête/i.test(lastContent);
    console.log(`[done ${j}] status=${st.status} stage=${st.stage} · messages assistant=${assistantCount} · livré=${delivered}`);
    if (st.status === "completed" && delivered) { console.log("✓ COMPLET : job completed + message de livraison dans le fil"); return; }
    if (delivered && st.status !== "processing") { console.log("✓ livré (statut:", st.status + ")"); return; }
  }
  console.log("✗ job non finalisé/livré après la sonde longue");
})();
