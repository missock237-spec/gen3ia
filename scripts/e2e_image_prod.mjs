#!/usr/bin/env node
/**
 * E2E production Gen3ia — génération d'images réelle (Agnes AI).
 *
 * 1. Crée un compte réel Firebase (identitytoolkit signUp, projet gen3ia-b5a92).
 * 2. Échange l'ID token contre un cookie de session (/api/auth/session).
 * 3. POST /api/agent/chat  (chemin universel)  : « Génère une image … »
 * 4. POST /api/chat/message (chat IA)          : « Crée une image … »
 * 5. POST /api/ai/image      (endpoint dédié)  : prompt direct.
 * Chaque étape doit renvoyer une URL d'image téléchargeable (HTTP 200, image/*).
 */

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `e2e-img-${Date.now()}@gen3ia.test`;
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
  if (!response.ok) throw new Error(`signUp: ${JSON.stringify(data).slice(0, 200)}`);
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
  log("2/session", `authentifié, wallet=${data.wallet ? Math.round(data.wallet.balanceMinor / 100) + " " + data.wallet.currency : "dégradé"}`);
  return cookie;
}

async function downloadAndVerifyImage(imageUrl, label) {
  const response = await fetch(imageUrl, { method: "GET" });
  const buffer = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get("content-type") || "?";
  const ok = response.ok && type.startsWith("image/") && buffer.length > 10_000;
  log(label, `image ${response.status} ${type} ${Math.round(buffer.length / 1024)} Ko → ${ok ? "OK" : "ÉCHEC"}`);
  return ok;
}

async function testAgentChat(cookie) {
  log("3/agent-chat", "message: « Génère une image d'un coucher de soleil sur Douala, style photoréaliste »");
  const started = Date.now();
  const response = await fetch(`${BASE}/api/agent/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message: "Génère une image d'un coucher de soleil sur Douala, style photoréaliste" }),
  });
  const data = await response.json();
  const latency = ((Date.now() - started) / 1000).toFixed(1);
  if (!response.ok) throw new Error(`agent/chat HTTP ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
  log("3/agent-chat", `HTTP ${response.status} en ${latency}s · mode=${data.mode} · imageUrl=${data.imageUrl ? "présente" : "ABSENTE"}`);
  if (!data.imageUrl) throw new Error(`agent/chat: pas d'imageUrl: ${JSON.stringify(data).slice(0, 300)}`);
  return downloadAndVerifyImage(data.imageUrl, "3/agent-chat");
}

async function testChatIA(cookie) {
  log("4/chat-ia", "message: « Crée une image d'un lion majestueux dans la savane »");
  const started = Date.now();
  const response = await fetch(`${BASE}/api/chat/message`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message: "Crée une image d'un lion majestueux dans la savane" }),
  });
  const data = await response.json();
  const latency = ((Date.now() - started) / 1000).toFixed(1);
  if (!response.ok) throw new Error(`chat/message HTTP ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const imageUrl = data.message?.imageUrl;
  log("4/chat-ia", `HTTP ${response.status} en ${latency}s · imageUrl=${imageUrl ? "présente" : "ABSENTE"}`);
  if (!imageUrl) throw new Error(`chat/message: pas d'imageUrl: ${JSON.stringify(data).slice(0, 300)}`);
  return downloadAndVerifyImage(imageUrl, "4/chat-ia");
}

async function testDedicatedEndpoint(cookie) {
  log("5/api-ai-image", "POST /api/ai/image { prompt: 'Affiche publicitaire élégante pour un café à Yaoundé' }");
  const started = Date.now();
  const response = await fetch(`${BASE}/api/ai/image`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ prompt: "Affiche publicitaire élégante pour un café artisanal à Yaoundé, style éditorial", size: "1K", ratio: "1:1" }),
  });
  const data = await response.json();
  const latency = ((Date.now() - started) / 1000).toFixed(1);
  if (!response.ok) throw new Error(`ai/image HTTP ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
  log("5/api-ai-image", `HTTP ${response.status} en ${latency}s · model=${data.model} · ${Math.round((data.latencyMs || 0) / 100) / 10}s provider`);
  return downloadAndVerifyImage(data.imageUrl, "5/api-ai-image");
}

const results = [];
try {
  const { idToken } = await signUp();
  const cookie = await createSession(idToken);
  results.push(await testAgentChat(cookie).catch((e) => { console.error("ERREUR:", e.message); return false; }));
  results.push(await testChatIA(cookie).catch((e) => { console.error("ERREUR:", e.message); return false; }));
  results.push(await testDedicatedEndpoint(cookie).catch((e) => { console.error("ERREUR:", e.message); return false; }));
} catch (error) {
  console.error("ERREUR FATALE:", error.message);
  process.exitCode = 1;
}

const passed = results.filter(Boolean).length;
console.log(`\nRÉSULTAT: ${passed}/${results.length} tests image en production ${passed === results.length ? "✅" : "❌"}`);
if (passed !== results.length) process.exitCode = 1;
