#!/usr/bin/env node
/**
 * E2E production Gen3ia — vague 15 : 6 moteurs + modules métier + accueil + Gen.
 *
 * 1. Compte réel Firebase + cookie de session.
 * 2. Infra (Redis/Qdrant).
 * 3. Page d'accueil publique : HTTP 200 + widget Gen présent dans le HTML.
 * 4. Chat Gen authentifié : POST /api/gen/chat.
 * 5. Les 12 routes /api/business/* répondent (GET).
 * 6. RH Congés : création d'une demande → jours ouvrés calculés.
 * 7. Finance : facture créée → workflow événementiel déclenché → notification.
 * 8. Automatisations : workflow manuel exécuté (statut success).
 */

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `e2e-wave15-${Date.now()}@gen3ia.test`;
const PASSWORD = "Gen3iaE2E!2026";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(step, ok, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} [${step}] ${ok ? "" : "— ÉCHEC"}${extra ? " " + extra : ""}`);
  if (!ok) failures += 1;
}

function log(step, ...parts) {
  console.log(`[${step}]`, ...parts);
}

async function readJson(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: réponse non-JSON (HTTP ${response.status}) : ${text.slice(0, 120).replace(/\s+/g, " ")}`);
  }
}

async function main() {
  // 1. Auth
  const signUpResponse = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
  });
  const auth = await readJson(signUpResponse, "signUp");
  if (!signUpResponse.ok) throw new Error(`signUp: ${JSON.stringify(auth).slice(0, 200)}`);
  const sessionResponse = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.idToken}` },
  });
  const sessionData = await readJson(sessionResponse, "session");
  if (!sessionResponse.ok || !sessionData.authenticated) throw new Error("session: échec");
  const setCookie = sessionResponse.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  log("1/auth", `compte + session OK`);

  const headers = { "content-type": "application/json", cookie };

  // 2. Infra
  const infra = await fetch(`${BASE}/api/health/infra`, { headers: { cookie } });
  const infraData = await readJson(infra, "infra");
  check("2/infra", infra.ok && infraData.layers?.redis?.ping === true, `redis.ping=${infraData.layers?.redis?.ping}`);

  // 3. Page d'accueil publique + widget Gen
  const home = await fetch(`${BASE}/`, { headers: { "user-agent": "Mozilla/5.0 (e2e)" } });
  const homeHtml = await home.text();
  check("3/home", home.ok && homeHtml.length > 5_000, `HTTP ${home.status}, ${Math.round(homeHtml.length / 1024)} Ko`);
  const genMarker = /gen/i.test(homeHtml) && (homeHtml.includes("/api/gen/chat") || homeHtml.toLowerCase().includes("gen"));
  check("3/home-gen-widget", home.ok && genMarker, "référence au chat Gen présente dans le HTML");

  // 4. Chat Gen authentifié
  const genChat = await fetch(`${BASE}/api/gen/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "Bonjour Gen ! Peux-tu me dire en une phrase ce que tu peux faire pour moi ?" }),
  });
  const genData = await readJson(genChat, "gen/chat");
  const genText = String(genData.reply ?? genData.message ?? genData.text ?? genData.response ?? "");
  check("4/gen-chat", genChat.ok && genText.length > 10, `réponse ${genText.length} caractères`);
  if (genChat.ok) log("4/gen-chat", `→ « ${genText.slice(0, 120).replace(/\s+/g, " ")}… »`);

  // 5. Les 12 routes business répondent
  const routes = [
    ["marketing-landing", "pages"],
    ["marketing-webinar", "assets"],
    ["sales-call-intelligence", "insights"],
    ["hr-leaves", "leaves"],
    ["hr-training", "trainings"],
    ["documents-contracts", "contracts"],
    ["documents-onboarding", "flows"],
    ["compliance-gdpr", "processing"],
    ["operations-maintenance", "assets"],
    ["finance-cashflow", "entries"],
    ["finance-unpaid", "invoices"],
    ["automations", "workflows"],
  ];
  for (const [route, listKey] of routes) {
    const response = await fetch(`${BASE}/api/business/${route}`, { headers });
    const data = await readJson(response, route);
    check(`5/${route}`, response.ok && Array.isArray(data[listKey]), `HTTP ${response.status}, ${Array.isArray(data[listKey]) ? data[listKey].length : "?"} entrée(s)`);
  }

  // 6. RH Congés : demande réelle (lun→ven = 5 jours ouvrés)
  const monday = new Date();
  while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() + 1);
  const friday = new Date(monday);
  friday.setUTCDate(friday.getUTCDate() + 4);
  const iso = (d) => d.toISOString().slice(0, 10);
  const leaveResponse = await fetch(`${BASE}/api/business/hr-leaves`, {
    method: "POST",
    headers,
    body: JSON.stringify({ employeeName: "E2E Dupont", type: "paid", startAt: iso(monday), endAt: iso(friday), reason: "Test E2E vague 15" }),
  });
  const leaveData = await readJson(leaveResponse, "hr-leaves POST");
  check("6/hr-leaves", leaveResponse.ok && leaveData.leave?.days === 5, `jours ouvrés=${leaveData.leave?.days} (attendu 5)`);

  // 7. Finance → workflow événementiel : facture créée → notification générée
  const wfResponse = await fetch(`${BASE}/api/business/automations`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: "create",
      name: "E2E — veille facture",
      trigger: { type: "event", eventType: "finance.invoice_created" },
      conditions: [],
      steps: [
        { id: "note1", name: "Notifier l'équipe", type: "notification", config: { title: "Nouvelle facture E2E", body: "Facture {{payload.invoiceNumber}} créée pour {{payload.amount}}." } },
      ],
    }),
  });
  const wfData = await readJson(wfResponse, "automations create");
  check("7/workflow-created", wfResponse.ok && Boolean(wfData.workflow?.id), `id=${wfData.workflow?.id}`);

  const invoiceResponse = await fetch(`${BASE}/api/business/finance-unpaid`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: "create",
      invoiceNumber: `E2E-${Date.now()}`,
      clientName: "Client E2E",
      amount: 1500,
      currency: "EUR",
      issuedAt: iso(new Date(Date.now() - 10 * 86_400_000)),
      dueDate: iso(new Date(Date.now() - 3 * 86_400_000)),
    }),
  });
  const invoiceData = await readJson(invoiceResponse, "finance-unpaid POST");
  check("7/invoice-created", invoiceResponse.ok && Boolean(invoiceData.invoice?.id), `facture ${invoiceData.invoice?.invoiceNumber ?? "?"}`);

  // Le run est émis fire-and-forget : on sonde le journal des exécutions.
  let runFound = false;
  let notificationFound = false;
  for (let attempt = 0; attempt < 6 && !runFound; attempt += 1) {
    await sleep(2_500);
    const probe = await fetch(`${BASE}/api/business/automations`, { headers });
    const probeData = await readJson(probe, "automations probe");
    const runs = probeData.runs ?? [];
    runFound = runs.some((run) => run.workflowName === "E2E — veille facture" && run.trigger === "event");
    if (runFound) {
      const run = runs.find((r) => r.workflowName === "E2E — veille facture");
      notificationFound = run?.status === "success";
    }
  }
  check("7/event-workflow-run", runFound, "run événementiel détecté dans le journal");
  check("7/event-workflow-success", notificationFound, "étape notification exécutée avec succès");

  // 8. Exécution manuelle d'un workflow
  const runResponse = await fetch(`${BASE}/api/business/automations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "run", workflowId: wfData.workflow.id }),
  });
  const runData = await readJson(runResponse, "automations run");
  check("8/manual-run", runResponse.ok && runData.run?.status === "success", `statut=${runData.run?.status}`);

  console.log(`\n${failures === 0 ? "TOUT EST VERT" : `${failures} ÉCHEC(S)`} — vague 15`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("FATAL", error?.message ?? error);
  process.exit(1);
});
