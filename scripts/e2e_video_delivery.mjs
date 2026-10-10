#!/usr/bin/env node
/** E2E complet vidéo : lancement chat → complétion pipeline → MESSAGE DE LIVRAISON dans le fil. */
const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `e2e-vidfull-${Date.now()}@gen3ia.test`;
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
    body: JSON.stringify({ title: "E2E vidéo livraison" }),
  }).then((x) => x.json());
  const conversationId = conv.conversation?.id ?? conv.id;
  const send = (message) =>
    fetch(`${BASE}/api/workspace/conversations/${conversationId}/messages`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ message }),
    }).then((x) => x.json());
  const list = () =>
    fetch(`${BASE}/api/workspace/conversations/${conversationId}`, { headers: { cookie } })
      .then((x) => x.json());

  console.log("[1] « Créé une vidéo de 5s d'un bébé qui marche »");
  const t1 = await send("Créé une vidéo de 5s d'un bébé qui marche");
  const projectId = t1.artifacts?.[0]?.videoProjectId;
  console.log("[1] projet:", projectId);

  for (let i = 0; i < 45; i += 1) {
    await sleep(20000);
    const st = await fetch(`${BASE}/api/video/projects/${projectId}/production`, { headers: { cookie } }).then((x) => x.json().catch(() => ({})));
    if (i % 3 === 0) console.log(`[poll ${i}] stage=${st.stage} progress=${st.progress}`);
    if (st.status === "failed") { console.log("✗ ÉCHEC pipeline"); process.exit(1); }
    if (st.status === "completed" || st.stage === "done") {
      console.log(`[poll ${i}] stage=done progress=1 — pipeline terminé`);
      // La livraison chat suit la complétion (tick final / sondage) :
      // relecture du fil jusqu'à 3 min.
      for (let j = 0; j < 12; j += 1) {
        await sleep(15000);
        const messages = await list();
        const docs = messages.conversation?.messages ?? messages.messages ?? messages;
        const items = Array.isArray(docs) ? docs : docs.items ?? [];
        const lastAssistant = [...items].reverse().find((m) => m.role === "assistant");
        const content = lastAssistant?.content ?? "";
        if (/vidéo est prête|master|Regarder|télécharg|\.mp4|playback|prête/i.test(content) && !/est lancée/.test(content)) {
          console.log("\nMESSAGE DE LIVRAISON:", JSON.stringify(content.slice(0, 500)));
          console.log("✓ LIVRAISON CHAT CONFIRMÉE DANS LE FIL");
          return;
        }
        console.log(`[livraison ${j}] pas encore dans le fil…`);
      }
      break;
    }
  }
  // Lecture du FIL : le message de livraison chat (Task 114-a) doit être présent.
  const messages = await list();
  const docs = messages.conversation?.messages ?? messages.messages ?? messages;
  const items = Array.isArray(docs) ? docs : docs.items ?? [];
  const lastAssistant = [...items].reverse().find((m) => m.role === "assistant");
  const content = lastAssistant?.content ?? "";
  console.log("\nDERNIER MESSAGE ASSISTANT:", JSON.stringify(content.slice(0, 600)));
  const delivered = /vidéo est prête|master|Écouter|Regarder|télécharg|\.mp4|playback/i.test(content);
  console.log(delivered ? "✓ MESSAGE DE LIVRAISON PRÉSENT DANS LE FIL" : "✗ message de livraison absent");
})();
