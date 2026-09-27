#!/usr/bin/env node
/* Sonde ciblée : génération d'app artefact (runAppTurn) avec patience 240 s. */
const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `probe-app-${Date.now()}@gen3ia.test`;

async function main() {
  const signUp = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: "AuditPass123!" }),
  })).json();
  const session = await fetch(`${BASE}/api/auth/session`, { method: "POST", headers: { Authorization: `Bearer ${signUp.idToken}` } });
  const cookie = (session.headers.get("set-cookie") || "").match(/gen3ia_session=[^;]+/)?.[0] || "";
  console.log("session:", session.status, "cookie:", cookie ? "oui" : "non");

  const create = await (await fetch(`${BASE}/api/workspace/conversations`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "Sonde app" }),
  })).json();
  const conversationId = create.id || create.conversation?.id;
  console.log("conversation:", conversationId);

  const t0 = Date.now();
  const streamRes = await fetch(`${BASE}/api/workspace/conversations/${conversationId}/messages/stream`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message: "agent ia, aidez-moi à créer une page web de liste de tâches en mode sombre, écrite en React." }),
  });
  console.log("stream status:", streamRes.status);
  // Consommer le flux (limite 240 s)
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let events = 0, done = false;
  const timer = setTimeout(() => { console.log("TIMEOUT 240s"); process.exit(2); }, 240000);
  while (!done) {
    const { value, done: d } = await reader.read();
    if (d) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split("\n")) {
      if (line.startsWith("data:")) {
        events++;
        if (line.includes('"type":"done"') || line.includes('"done":true') || line.includes("completed")) {
          done = true;
        }
      }
    }
  }
  clearTimeout(timer);
  console.log(`flux terminé en ${((Date.now() - t0) / 1000).toFixed(1)}s · ${events} événements`);

  // Vérifier l'artefact
  const detail = await (await fetch(`${BASE}/api/workspace/conversations/${conversationId}`, { headers: { cookie } })).json();
  const artifacts = detail.artifacts || detail.conversation?.artifacts || [];
  const app = artifacts.find((a) => a.type === "code/html" || (a.content || (a.versions?.[0]?.content) || "").includes("<html"));
  console.log("artefacts:", artifacts.length, "app:", app ? `${app.id} · /preview/${app.id}` : "ABSENT");
  if (app) {
    const pv = await fetch(`${BASE}/preview/${app.id}`, { headers: { cookie } });
    const html = await pv.text();
    console.log("/preview:", pv.status, "· contient html:", html.includes("<html"), "· modal param ok:", pv.status === 200);
  }
  process.exit(app ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
