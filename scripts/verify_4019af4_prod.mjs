#!/usr/bin/env node
/**
 * Vérification e2e production — commit 4019af4.
 * Mission : « Dans la conversation il est impossible de créer une image »
 * → correction + test qualité ultra réaliste.
 *
 * 1.  signUp Firebase + session                      : compte réel.
 * 2.  Conversation + STREAM — « Dessine-moi un chat qui dort sur un
 *     coussin rouge » : ANCIENNE FAILLE (aucun nom visuel → réponse texte)
 *     → désormais routée par le classificateur (image.generate) → imageUrl.
 * 3.  Conversation + STREAM — « Je veux une image ultra réaliste d'un
 *     tigre au bord d'une rivière » : ANCIENNE FAILLE (verbe « veux » non
 *     reconnu) → désormais détectée par la regex élargie → imageUrl.
 * 4.  Les deux images sont téléchargées : dimensions 2K attendues
 *     (2048 px de côté pour un ratio 1:1) + inspection visuelle du réalisme.
 * 5.  Artefacts image présents dans les conversations.
 */

import { writeFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `e2e-image-${Date.now()}@gen3ia.test`;
const PASSWORD = "Gen3iaE2E!2026";

let failures = 0;
function check(step, ok, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} [${step}]${extra ? " " + extra : ""}`);
  if (!ok) failures += 1;
}

async function consumeStream(cookie, conversationId, message) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/workspace/conversations/${conversationId}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) return { status: res.status, events: [], ms: Date.now() - t0, error: (await res.text()).slice(0, 300) };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t)); } catch {}
    }
  }
  if (buffer.trim()) { try { events.push(JSON.parse(buffer.trim())); } catch {} }
  return { status: res.status, events, ms: Date.now() - t0 };
}

function extractImageResult(events) {
  const done = events.find((e) => e.type === "done");
  const complete = [...events].reverse().find((e) => e.type === "message_complete")?.message;
  const artifact = events.find((e) => e.type === "artifact_created" && e.artifact?.type === "image")?.artifact;
  return { done, complete, artifact, imageUrl: complete?.imageUrl ?? artifact?.url };
}

async function main() {
  console.log("=== VÉRIFICATION IMAGE CONVERSATION —", BASE, "===");

  // 1. Auth réelle
  const signUpRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
  });
  const auth = await signUpRes.json();
  check("1/signUp", signUpRes.ok && Boolean(auth.idToken), EMAIL);
  const sessionRes = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.idToken}` },
  });
  const cookie = (sessionRes.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  check("1b/session", sessionRes.ok && Boolean(cookie), `HTTP ${sessionRes.status}`);

  // 2. FAILLE #1 — formulation sans nom visuel (ancien comportement : réponse
  // textuelle). Routage attendu : classificateur → image.generate → image.
  const conv1 = await fetch(`${BASE}/api/workspace/conversations`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({}),
  });
  const conv1Data = await conv1.json().catch(() => ({}));
  const c1 = conv1Data.conversation?.id;
  const r1 = await consumeStream(cookie, c1, "Dessine-moi un chat qui dort sur un coussin rouge.");
  const img1 = extractImageResult(r1.events);
  check("2/chat-sans-nom-visuel", r1.status === 200 && Boolean(img1.done) && typeof img1.imageUrl === "string" && img1.imageUrl.startsWith("http"),
    `HTTP ${r1.status} · ${r1.events.length} évts · ${(r1.ms / 1000).toFixed(1)}s · imageUrl=${img1.imageUrl ? "présente" : "ABSENTE"}`);
  if (img1.complete) check("2b/texte-qui-ne-refuse-pas", !/je ne (peux|peut)/i.test(img1.complete.content), `réponse: « ${String(img1.complete.content).slice(0, 120).replace(/\s+/g, " ")} »`);

  // 3. FAILLE #2 — verbe de volonté (« je veux ») non reconnu par l'ancienne
  // regex. Désormais détectée + qualité ultra réaliste (2K).
  const conv2 = await fetch(`${BASE}/api/workspace/conversations`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({}),
  });
  const conv2Data = await conv2.json().catch(() => ({}));
  const c2 = conv2Data.conversation?.id;
  const r2 = await consumeStream(cookie, c2, "Je veux une image ultra réaliste d'un tigre au bord d'une rivière.");
  const img2 = extractImageResult(r2.events);
  check("3/je-veux-une-image", r2.status === 200 && Boolean(img2.done) && typeof img2.imageUrl === "string" && img2.imageUrl.startsWith("http"),
    `HTTP ${r2.status} · ${r2.events.length} évts · ${(r2.ms / 1000).toFixed(1)}s · imageUrl=${img2.imageUrl ? "présente" : "ABSENTE"}`);

  // 4. Téléchargement + dimensions 2K attendues
  for (const [label, url, file] of [
    ["4a/chat-2k", img1.imageUrl, "/home/z/my-project/tool-results/prod_chat.png"],
    ["4b/tigre-2k", img2.imageUrl, "/home/z/my-project/tool-results/prod_tigre.png"],
  ]) {
    if (!url) { check(label, false, "pas d'URL à télécharger"); continue; }
    const imgRes = await fetch(url, { cache: "no-store" });
    const buf = Buffer.from(await imgRes.arrayBuffer());
    // Dimensions PNG : IHDR aux octets 16-24 (big-endian).
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    writeFileSync(file, buf);
    check(label, imgRes.ok && w >= 2048 && h >= 2048, `HTTP ${imgRes.status} · ${w}×${h}px · ${(buf.length / 1024 / 1024).toFixed(2)} Mo`);
  }

  // 5. Artefacts persistés dans la première conversation
  const d1 = await fetch(`${BASE}/api/workspace/conversations/${c1}`, { headers: { cookie }, cache: "no-store" });
  const d1Data = await d1.json().catch(() => ({}));
  const art1 = (d1Data.artifacts ?? []).filter((a) => a.type === "image");
  check("5/artefact-image", d1.status === 200 && art1.length >= 1, `conversation 1 : ${art1.length} artefact(s) image`);

  console.log(failures === 0 ? "\n✅ TOUS LES CONTRÔLES VERTS" : `\n❌ ${failures} contrôle(s) en échec`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
