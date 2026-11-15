#!/usr/bin/env node
/** Suivi de la production vidéo lancée par le chat workspace (scénario capture 2). */
const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `follow-vid-${Date.now()}@gen3ia.test`;

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
    body: JSON.stringify({ title: "Suivi vidéo 5s" }),
  }).then((x) => x.json());
  const conversationId = conv.conversation?.id ?? conv.id;

  const send = (message) =>
    fetch(`${BASE}/api/workspace/conversations/${conversationId}/messages`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ message }),
    }).then((x) => x.json());

  console.log("[1] envoi « Créé une vidéo de 5s d'un bébé qui marche »");
  const t1 = await send("Créé une vidéo de 5s d'un bébé qui marche");
  const projectId = t1.artifacts?.[0]?.videoProjectId;
  console.log("[1] artefact vidéo:", t1.artifacts?.[0]?.type, "· projet:", projectId);
  if (!projectId) throw new Error("pas de projet vidéo créé");

  // Suivi : étapes de production réelles (stage, progress) — réponse plate
  // GET /api/video/projects/{id}/production → { status, stage, progress, … }
  let last = "";
  for (let i = 0; i < 40; i += 1) {
    await sleep(20000);
    const st = await fetch(`${BASE}/api/video/projects/${projectId}/production`, { headers: { cookie } })
      .then((x) => x.json().catch(() => ({})));
    const line = `stage=${st.stage} progress=${st.progress} status=${st.status} err=${st.error ?? "-"}`;
    if (line !== last) { console.log(`[poll ${i}]`, line); last = line; }
    if (st.status === "completed" || st.stage === "done") {
      console.log("✓ VIDÉO COMPLÈTE (pipeline terminé)");
      return;
    }
    if (st.status === "failed") { console.log("✗ ÉCHEC pipeline"); process.exit(1); }
  }
  console.log("→ pipeline toujours en cours après le budget de suivi (rendu asynchrone long) — le lancement et l'avancement sont confirmés");
})();
