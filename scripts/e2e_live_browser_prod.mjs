#!/usr/bin/env node
/**
 * E2E production Gen3ia — Agent Live en mode navigateur (sans téléchargement).
 *
 * 1. Crée un compte réel Firebase (identitytoolkit signUp).
 * 2. Échange l'ID token contre un cookie de session (/api/auth/session).
 * 3. Crée une session Live (mode "browser", permission screen.read).
 * 4. POST /api/live/sessions/[id]/start  → le navigateur devient le client.
 * 5. POST /api/live/sessions/[id]/frames → 2 vraies frames JPEG analysées
 *    par la vision IA (boucle live serverless, sans gateway WebSocket).
 * 6. PUT résultat d'action si l'agent en propose une.
 * 7. GET session + POST stop.
 *
 * Chaque réponse de frame doit contenir une décision de vision non vide :
 * c'est la preuve que le live agent fonctionne directement via navigateur.
 */

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `e2e-live-${Date.now()}@gen3ia.test`;
const PASSWORD = "Gen3iaE2E!2026";
// Garde PC-only : le script se présente comme un navigateur d'ordinateur.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const HEADERS = { "user-agent": UA };
const DEVICE_ID = "web-e2e-live-01";

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
    headers: { ...HEADERS, authorization: `Bearer ${idToken}` },
  });
  const data = await response.json();
  if (!response.ok || !data.authenticated) throw new Error(`session: HTTP ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("session: aucun cookie posé");
  log("2/session", "authentifié (cookie de session OK)");
  return cookie;
}

function readFrame(name) {
  return fs.readFileSync(new URL(`./fixtures/${name}.b64`, import.meta.url), "utf8").trim();
}

let checks = { total: 0, passed: 0 };
function check(label, ok, detail = "") {
  checks.total += 1;
  if (ok) checks.passed += 1;
  log("check", `${ok ? "OK  " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const auth = await signUp();
  const cookie = await createSession(auth.idToken);
  const headers = { ...HEADERS, "content-type": "application/json", cookie };

  // 3) Création de la session Live (mode navigateur).
  let response = await fetch(`${BASE}/api/live/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "E2E live navigateur",
      objective: "Observe cet écran de test : décris ce que tu vois et confirme si une fenêtre d'application est visible.",
      permissions: ["screen.read"],
      mode: "browser",
    }),
  });
  const created = await response.json();
  check("création session (201, mode browser)", response.status === 201 && created.session?.id, `HTTP ${response.status}`);
  const sessionId = created.session?.id;
  if (!sessionId) throw new Error("session id manquant");

  // 4) Démarrage du client navigateur.
  response = await fetch(`${BASE}/api/live/sessions/${sessionId}/start`, {
    method: "POST",
    headers,
    body: JSON.stringify({ deviceId: DEVICE_ID }),
  });
  const started = await response.json();
  check("start navigateur (running)", response.status === 200 && started.ok === true, `HTTP ${response.status} status=${started.session?.status}`);

  // 5) Boucle live : 2 frames réelles analysées par la vision.
  const frames = [readFrame("live_frame_1"), readFrame("live_frame_2")];
  let sawDecision = false;
  let sawAction = null;
  for (let i = 0; i < frames.length; i++) {
    const t0 = Date.now();
    response = await fetch(`${BASE}/api/live/sessions/${sessionId}/frames`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        timestamp: Date.now(),
        width: 800,
        height: 500,
        jpegBase64: frames[i],
      }),
    });
    const data = await response.json().catch(() => ({}));
    const latency = ((Date.now() - t0) / 1000).toFixed(1);
    const message = data.decision?.message ?? "";
    check(`frame ${i + 1}/2 vision (décision non vide)`, response.status === 200 && typeof message === "string" && message.length > 3, `HTTP ${response.status} ${latency}s « ${message.slice(0, 110)} »`);
    if (response.status === 200 && message) sawDecision = true;
    if (data.action?.actionId) sawAction = data.action;

    // 6) Résultat d'action exécutée par le navigateur.
    if (data.action?.actionId) {
      const isWait = data.action.action?.type === "wait";
      const resultResponse = await fetch(`${BASE}/api/live/sessions/${sessionId}/frames`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          deviceId: DEVICE_ID,
          actionId: data.action.actionId,
          ok: isWait,
          ...(isWait ? {} : { error: "Action non exécutable en mode navigateur (test E2E)" }),
        }),
      });
      check(`résultat action (${data.action.action?.type})`, resultResponse.status === 200, `HTTP ${resultResponse.status}`);
    }
  }

  // 7) État final + arrêt propre.
  response = await fetch(`${BASE}/api/live/sessions/${sessionId}`, { headers });
  const state = await response.json();
  check("session lisible (runtime actif)", response.status === 200 && Boolean(state.session?.runtime), `status=${state.session?.status} iterations=${state.session?.runtime?.iteration ?? "?"}`);

  response = await fetch(`${BASE}/api/live/sessions/${sessionId}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "stop" }),
  });
  check("arrêt de la session", response.status === 200, `HTTP ${response.status}`);

  console.log(`\nRésumé : ${checks.passed}/${checks.total} vérifications vertes — décision vision reçue : ${sawDecision ? "OUI" : "NON"}${sawAction ? `, action proposée : ${sawAction.action?.type}` : ""}`);
  if (checks.passed < checks.total || !sawDecision) {
    process.exitCode = 1;
  }
}

import fs from "node:fs";

main().catch((error) => {
  console.error("E2E live navigateur : ÉCHEC —", error.message);
  process.exitCode = 1;
});
