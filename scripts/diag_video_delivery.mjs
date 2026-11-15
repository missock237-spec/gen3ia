#!/usr/bin/env node
/** Diagnostic livraison chat vidéo : inspecte productionLog + job après complétion. */
const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `diag-deliv-${Date.now()}@gen3ia.test`;
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
    body: JSON.stringify({ title: "Diag livraison vidéo" }),
  }).then((x) => x.json());
  const conversationId = conv.conversation?.id ?? conv.id;
  console.log("conversation:", conversationId);
  const send = (message) =>
    fetch(`${BASE}/api/workspace/conversations/${conversationId}/messages`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ message }),
    }).then((x) => x.json());

  const t1 = await send("Créé une vidéo de 5s d'un bébé qui marche");
  const projectId = t1.artifacts?.[0]?.videoProjectId;
  console.log("projet:", projectId);

  for (let i = 0; i < 45; i += 1) {
    await sleep(20000);
    const st = await fetch(`${BASE}/api/video/projects/${projectId}/production`, { headers: { cookie } }).then((x) => x.json().catch(() => ({})));
    if (i % 3 === 0) console.log(`[poll ${i}] stage=${st.stage} progress=${st.progress}`);
    if (st.status === "failed") { console.log("✗ pipeline échoué:", st.error); process.exit(1); }
    if (st.status === "completed" || st.stage === "done") {
      console.log(`[poll ${i}] TERMINÉ`);
      break;
    }
  }
  // Journal de production du projet + rendu + détail job
  const proj = await fetch(`${BASE}/api/video/projects/${projectId}`, { headers: { cookie } }).then((x) => x.json()).catch(() => ({}));
  const log = proj.project?.productionLog ?? [];
  console.log("\nJOURNAL DE PRODUCTION (dernières entrées):");
  for (const entry of log.slice(-8)) console.log(` - [${entry.actor}] ${entry.message?.slice(0, 160)}`);
  const st = await fetch(`${BASE}/api/video/projects/${projectId}/production`, { headers: { cookie } }).then((x) => x.json().catch(() => ({})));
  console.log("\nJOB:", JSON.stringify({ status: st.status, stage: st.stage, error: st.error, renderJobId: st.renderJobId, timeline: st.timeline?.slice?.(-4) }, null, 1));
})();
