#!/usr/bin/env node
/** Vérification du LIEN D'ÉCOUTE dans la livraison audio (scénario 3 tours). */
const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `check-audio-${Date.now()}@gen3ia.test`;

(async () => {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: "Gen3iaE2E!2026", returnSecureToken: true }),
  });
  const a = await r.json();
  const s = await fetch(`${BASE}/api/auth/session`, { method: "POST", headers: { authorization: `Bearer ${a.idToken}` } });
  const cookie = (s.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  const conv = await fetch(`${BASE}/api/workspace/conversations`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "Check lien audio" }),
  }).then((x) => x.json());
  const conversationId = conv.conversation?.id ?? conv.id;

  const send = (message) =>
    fetch(`${BASE}/api/workspace/conversations/${conversationId}/messages`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ message }),
    }).then((x) => x.json());

  await send("Peut tu me générer un audio de 5s");
  const tour2 = await send("Bienvenue à tous dans cette présentation");
  const msg = tour2.assistantMessage ?? {};
  console.log("CONTENU COMPLET DU MESSAGE ASSISTANT:");
  console.log(JSON.stringify(msg.content, null, 2));
  console.log("\nLien d'écoute présent:", /\[Écouter l'audio\]\(https?:\/\//.test(msg.content ?? ""));
  console.log("Artefacts:", JSON.stringify((tour2.artifacts ?? []).map((x) => ({ type: x.type, url: x.url, storagePath: x.storagePath })), null, 2));
})();
