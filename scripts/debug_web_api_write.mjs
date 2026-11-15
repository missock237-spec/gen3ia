#!/usr/bin/env node
/** Debug : comment le moteur route une demande de POST API (web.api.write). */
const BASE = "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `e2e-dbg-${Date.now()}@gen3ia.test`;
const PASSWORD = "Gen3iaE2E!2026";

async function main() {
  const signUpRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
  });
  const auth = await signUpRes.json();
  const sessionRes = await fetch(`${BASE}/api/auth/session`, { method: "POST", headers: { authorization: `Bearer ${auth.idToken}` } });
  const cookie = (sessionRes.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  const convRes = await fetch(`${BASE}/api/workspace/conversations`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({}),
  });
  const conv = (await convRes.json()).conversation?.id;
  console.log("conversation:", conv);

  const res = await fetch(`${BASE}/api/workspace/conversations/${conv}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message: "Crée un nouvel article : envoie une requête POST avec le corps {\"title\":\"Gen IA test\",\"body\":\"validation\",\"userId\":1} sur https://jsonplaceholder.typicode.com/posts" }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === "status") console.log("STATUS", e.phase, "—", e.label);
        else if (e.type === "step_update") console.log("STEP", e.step.phase, e.step.toolName ?? "(llm)", e.step.status, "—", (e.step.title ?? "").slice(0, 90));
        else if (e.type === "approval_created") console.log("APPROVAL", e.approval?.toolName, e.approval?.status);
        else if (e.type === "run_status") console.log("RUN", e.status);
        else if (e.type === "message_complete") console.log("FINAL:", (e.message?.content ?? "").slice(0, 400).replace(/\n+/g, " | "));
        else console.log("EVENT", e.type);
      } catch {}
    }
  }
}
main().catch(console.error);
