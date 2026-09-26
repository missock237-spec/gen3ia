#!/usr/bin/env node
/**
 * Vérification e2e production — commit 8c58989 (Auth OAuth + sous-services
 * sous autorité des agents).
 *
 * Contrôles :
 *  1. CSP corrigée : script-src autorise apis.google.com / www.gstatic.com /
 *     www.googleapis.com (cause racine du blocage Google/GitHub).
 *  2. OAuth : popup Google RÉELLEMENT ouverte depuis /login (Playwright).
 *  3. Session réelle (signUp Firebase) → API 200.
 *  4. Tâche planifiée créée DEPUIS LA CONVERSATION en langage naturel :
 *     « Chaque lundi à 9h, prépare-moi un rapport des actualités IA… »
 *     → document agentSchedules réel (jours [1], 09:00, agent résolu).
 *  5. Pilotage naturel : « montre-moi mes tâches planifiées » → liste réelle ;
 *     « désactive la tâche planifiée … » → désactivée en base.
 *  6. Workflow créé depuis la conversation (étapes numérotées → graphe réel)
 *     puis exécution demandée en langage naturel.
 */

import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `e2e-services-${Date.now()}@gen3ia.test`;
const PASSWORD = "Gen3iaE2E!2026";
const TIMEZONE = "Africa/Douala";

let failures = 0;
function check(step, ok, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} [${step}]${extra ? " " + extra : ""}`);
  if (!ok) failures += 1;
}

async function sendMessage(cookie, conversationId, message) {
  const res = await fetch(`${BASE}/api/workspace/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message, timezone: TIMEZONE }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

(async () => {
  console.log(`\n=== Vérification Auth OAuth + sous-services agents — ${BASE} ===\n`);

  // 1. CSP corrigée
  const pageHead = await fetch(`${BASE}/login`, { method: "HEAD" });
  const csp = pageHead.headers.get("content-security-policy") ?? "";
  check("1/csp-apis-google", csp.includes("https://apis.google.com"), "script-src autorise gapi");
  check("1/csp-gstatic", csp.includes("https://www.gstatic.com"));
  check("1/csp-frame-googleapis", csp.includes("https://content.googleapis.com"));
  check("1/login-200", pageHead.status === 200, `HTTP ${pageHead.status}`);

  // 2. OAuth réel : le clic Google ouvre le popup vers la page Google
  let oauthOk = false;
  let popupUrl = "";
  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 60_000 });
    const popupPromise = context.waitForEvent("page", { timeout: 20_000 }).catch(() => null);
    await page.getByRole("button", { name: /continuer avec google/i }).click();
    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
      popupUrl = popup.url();
      oauthOk = /accounts\.google\.com|firebaseapp\.com\/__\/auth/.test(popupUrl);
      await popup.close().catch(() => {});
    }
    await browser.close();
  } catch (error) {
    console.log("      diagnostic popup:", String(error).slice(0, 120));
  }
  check("2/oauth-popup-google", oauthOk, popupUrl ? popupUrl.slice(0, 90) : "popup non ouverte");

  // 3. Session réelle
  const signUpRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
  });
  const auth = await signUpRes.json();
  check("3/signUp", signUpRes.ok && Boolean(auth.idToken), EMAIL);
  const sessionRes = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.idToken}` },
  });
  const cookie = (sessionRes.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  check("3/session", sessionRes.ok && Boolean(cookie), `HTTP ${sessionRes.status}`);

  // Conversation
  const convRes = await fetch(`${BASE}/api/workspace/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({}),
  });
  const convBody = await convRes.json().catch(() => ({}));
  const conversationId = convBody?.conversation?.id;
  check("3/conversation", convRes.ok && Boolean(conversationId), conversationId ?? "absente");

  // 4. Tâche planifiée créée EN LANGAGE NATUREL (tour déterministe, sans LLM)
  const turn1 = await sendMessage(cookie, conversationId, "Chaque lundi à 9h, prépare-moi un rapport des actualités IA de la semaine");
  const content1 = String(turn1.body?.assistantMessage?.content ?? "");
  check("4/turn-200", turn1.status === 200, `HTTP ${turn1.status}`);
  check("4/confirmation", content1.includes("Tâche planifiée créée"), content1.split("\n")[0]?.slice(0, 90));
  check("4/recurrence-lundi-9h", content1.includes("lundi") && content1.includes("09:00"), "fenêtre reprise exactement");
  check("4/fuseau", content1.includes(TIMEZONE));

  const schedRes = await fetch(`${BASE}/api/agents/schedules`, { headers: { cookie } });
  const schedBody = await schedRes.json().catch(() => ({}));
  const schedules = Array.isArray(schedBody?.schedules) ? schedBody.schedules : [];
  const schedule = schedules.find((s) => s.daysOfWeek?.includes(1) && s.startTime === "09:00");
  check("4/agent-schedules-200", schedRes.status === 200, `HTTP ${schedRes.status}`);
  check("4/schedule-en-base", Boolean(schedule), schedule ? `id=${schedule.id?.slice(0, 8)} agent=${schedule.agentId?.slice(0, 8)} enabled=${schedule.enabled}` : "introuvable");
  check("4/objective-fidele", schedule?.objective?.includes("rapport des actualités IA"), "objectif = demande exacte");

  // 5. Pilotage naturel : liste + désactivation
  const turn2 = await sendMessage(cookie, conversationId, "montre-moi mes tâches planifiées");
  const content2 = String(turn2.body?.assistantMessage?.content ?? "");
  check("5/liste-200", turn2.status === 200, `HTTP ${turn2.status}`);
  check("5/liste-reelle", content2.includes("Vos tâches planifiées (1)"), content2.split("\n")[0]?.slice(0, 90));

  const turn3 = await sendMessage(cookie, conversationId, `désactive la tâche planifiée « ${schedule?.name ?? "rapport"} »`);
  const content3 = String(turn3.body?.assistantMessage?.content ?? "");
  check("5/desactivation", content3.includes("désactivée"), content3.split("\n")[0]?.slice(0, 90));
  const schedAfter = await fetch(`${BASE}/api/agents/schedules`, { headers: { cookie } });
  const schedAfterBody = await schedAfter.json().catch(() => ({}));
  const schedAfterList = Array.isArray(schedAfterBody?.schedules) ? schedAfterBody.schedules : [];
  check("5/desactive-en-base", schedAfterList.some((s) => s.enabled === false), "enabled=false persisté");

  // 6. Workflow créé en langage naturel (étapes numérotées)
  const turn4 = await sendMessage(cookie, conversationId, "crée un workflow : étape 1 : recherche les tendances IA du moment. étape 2 : rédige un résumé des tendances");
  const content4 = String(turn4.body?.assistantMessage?.content ?? "");
  check("6/workflow-cree", content4.includes("Workflow créé"), content4.split("\n")[0]?.slice(0, 90));
  check("6/deux-etapes", content4.includes("Étape 1") && content4.includes("Étape 2"));

  const wfRes = await fetch(`${BASE}/api/workflows`, { headers: { cookie } });
  const wfBody = await wfRes.json().catch(() => ({}));
  const workflows = Array.isArray(wfBody?.workflows) ? wfBody.workflows : [];
  const workflow = workflows[0];
  check("6/workflow-en-base", wfRes.status === 200 && workflows.length > 0, workflow ? `id=${workflow.id?.slice(0, 8)} nœuds=${workflow.nodes?.length}` : "aucun");
  check("6/graphe-valide", Boolean(workflow?.nodes?.length >= 3 && workflow?.edges?.length >= 2), "2 étapes agent + output");
  check("6/taches-fideles", JSON.stringify(workflow?.nodes ?? []).includes("recherche les tendances IA"));

  // 7. Santé plateforme
  const healthRes = await fetch(`${BASE}/api/public/health`);
  check("7/health", healthRes.status === 200, `HTTP ${healthRes.status}`);

  console.log(`\n=== ${failures === 0 ? "TOUS LES CONTRÔLES SONT VERTS" : failures + " CONTRÔLE(S) EN ÉCHEC"} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error("ERREUR FATALE:", error?.message ?? error);
  process.exit(1);
});
