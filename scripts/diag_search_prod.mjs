#!/usr/bin/env node
/** Diagnostic : déclenche un plan web.search en production et imprime
 * l'erreur réelle contenue dans l'output de l'étape échouée. */
const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `diag-search-${Date.now()}@gen3ia.test`;
const PASSWORD = "Gen3iaE2E!2026";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const signUp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
  });
  const auth = await signUp.json();
  const session = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.idToken}` },
  });
  const cookie = (session.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const headers = { "content-type": "application/json", cookie };

  const conv = await (await fetch(`${BASE}/api/workspace/conversations`, { method: "POST", headers, body: "{}" })).json();
  const res = await fetch(`${BASE}/api/workspace/conversations/${conv.conversation.id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "Fais une recherche web : intelligence artificielle Afrique 2026" }),
  });
  const turn = await res.json();
  console.log("run:", turn.run?.id, "statut:", turn.run?.status);
  for (const step of turn.run?.steps ?? []) {
    console.log(`- [${step.status}] ${step.phase} — ${step.title}`);
    if (step.toolName) console.log(`   outil: ${step.toolName} input=${JSON.stringify(step.toolInput).slice(0, 120)}`);
    if (step.output) console.log(`   output: ${step.output.slice(0, 500)}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
