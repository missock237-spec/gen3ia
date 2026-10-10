#!/usr/bin/env node
/**
 * REPRODUCTION DES 2 CAPTURES 13:02 (workspace, chemin exact de l'utilisateur).
 *
 * Capture 1 (audio) : « Peut tu me générer un audio de 5s » → question de
 * clarification → « Bjr je suis entrain de venir » → BUG : le chat répond
 * « la plateforme ne prend en charge que la génération d'images, pas d'audio ».
 *
 * Capture 2 (vidéo) : « Créé une vidéo de 5s d'un bébé qui marche » → BUG :
 * « Étape de production vidéo : échec — ... n'a pas pu être lancé ».
 *
 * Le script affiche les réponses BRUTES production pour diagnostic, puis
 * sert de test de non-régression après correctif (attendu post-fix :
 * audio livré + production vidéo lancée).
 */

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `repro-cap-${Date.now()}@gen3ia.test`;
const PASSWORD = "Gen3iaE2E!2026";

function log(step, ...parts) {
  console.log(`[${step}]`, ...parts);
}

async function signUp() {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
    },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(`signUp: ${JSON.stringify(data).slice(0, 300)}`);
  log("1/auth", `compte créé ${EMAIL} (uid ${data.localId.slice(0, 8)}…)`);
  return data;
}

async function createSession(idToken) {
  const response = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${idToken}` },
  });
  const data = await response.json();
  if (!response.ok || !data.authenticated) throw new Error(`session: HTTP ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("session: aucun cookie posé");
  log("2/session", `authentifié · wallet=${data.wallet ? Math.round(data.wallet.balanceMinor / 100) + " " + data.wallet.currency : "dégradé"}`);
  return cookie;
}

async function createConversation(cookie, title) {
  const response = await fetch(`${BASE}/api/workspace/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`conversation: HTTP ${response.status} ${JSON.stringify(data).slice(0, 300)}`);
  const id = data.conversation?.id ?? data.id;
  log("3/conv", `conversation ${id} créée`);
  return id;
}

async function send(cookie, conversationId, message) {
  const started = Date.now();
  const response = await fetch(`${BASE}/api/workspace/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message }),
  });
  const latency = ((Date.now() - started) / 1000).toFixed(1);
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data, latency };
}

function describeMessage(data) {
  const m = data?.assistantMessage ?? data?.message ?? {};
  const content = typeof m.content === "string" ? m.content : JSON.stringify(m).slice(0, 600);
  const artifacts = data?.artifacts ?? [];
  return {
    content: content.slice(0, 1200),
    artifacts: artifacts.map((a) => `${a.type}:${a.title ?? a.id}`),
    imageUrl: m.imageUrl ?? data?.imageUrl,
    audio: data?.audio ?? m.audio,
  };
}

async function main() {
  const auth = await signUp();
  const cookie = await createSession(auth.idToken);

  console.log("\n════ CAPTURE 1 — AUDIO (scénario exact : 2 messages) ════");
  const convAudio = await createConversation(cookie, "Audio 5s");
  log("4a/msg1", "« Peut tu me générer un audio de 5s »");
  const r1 = await send(cookie, convAudio, "Peut tu me générer un audio de 5s");
  const d1 = describeMessage(r1.data);
  log("4a/rep1", `HTTP ${r1.status} en ${r1.latency}s · artefacts=[${d1.artifacts}]`);
  console.log("  └─ réponse:", JSON.stringify(d1.content).slice(0, 700));
  console.log("  └─ audio:", JSON.stringify(d1.audio)?.slice(0, 200));

  log("4b/msg2", "« Bjr je suis entrain de venir »");
  const r2 = await send(cookie, convAudio, "Bjr je suis entrain de venir");
  const d2 = describeMessage(r2.data);
  log("4b/rep2", `HTTP ${r2.status} en ${r2.latency}s · artefacts=[${d2.artifacts}]`);
  console.log("  └─ réponse:", JSON.stringify(d2.content).slice(0, 900));
  console.log("  └─ audio:", JSON.stringify(d2.audio)?.slice(0, 200));

  const bug1 = /pas d.audio|que la génération d.images|ne prend en charge/i.test(d2.content) && !d2.audio;
  console.log(bug1 ? "  ✗ BUG 1 REPRODUIT (audio refusé)" : "  ✓ audio traité (pas de refus détecté)");

  console.log("\n════ CAPTURE 2 — VIDÉO (message exact) ════");
  const convVideo = await createConversation(cookie, "Vidéo bébé");
  log("5a/msg", "« Créé une vidéo de 5s d'un bébé qui marche »");
  const r3 = await send(cookie, convVideo, "Créé une vidéo de 5s d'un bébé qui marche");
  const d3 = describeMessage(r3.data);
  log("5b/rep", `HTTP ${r3.status} en ${r3.latency}s · artefacts=[${d3.artifacts}]`);
  console.log("  └─ réponse:", JSON.stringify(d3.content).slice(0, 900));
  const bug2 = /Mission incomplète|échec|n'est pas disponible|a échoué/i.test(d3.content);
  const videoLaunched = /production vidéo est lancée|progression en temps réel/i.test(d3.content) || d3.artifacts.some((a) => a.startsWith("video"));
  console.log(bug2 && !videoLaunched ? "  ✗ BUG 2 REPRODUIT (vidéo non lancée)" : videoLaunched ? "  ✓ production vidéo lancée" : "  ? à analyser manuellement");

  console.log("\n════ RÉSUMÉ ════");
  console.log(`bug1_audio_refuse = ${bug1}`);
  console.log(`bug2_video_echec  = ${bug2 && !videoLaunched}`);
  console.log(`conversation audio : ${convAudio}`);
  console.log(`conversation vidéo : ${convVideo}`);
}

main().catch((error) => {
  console.error("REPRO ÉCHEC:", error.message);
  process.exit(1);
});
