#!/usr/bin/env node
/**
 * E2E production Gen3ia — vague 17 : architecture Conversation-first.
 *
 * 1. Compte réel Firebase + cookie de session.
 * 2. Pages publiques : accueil 200, /dashboard (accueil léger), chat Gen.
 * 3. Redirections : /workspace → /workspace/conversations, /workspace/connectors → /studio/connections.
 * 4. CRUD conversations : création, détail, renommage, archivage.
 * 5. Conversation réelle : message → réponse assistant persistée (reprise persistante).
 * 6. Demande d'image : message → imageUrl réelle + artefact image.
 * 7. Plan réel avec outils : demande de recherche web → run exécuté (web.search) → timeline.
 * 8. Projets : création, instructions persistantes, rattachement de conversation, artefacts filtrés.
 * 9. Artefacts : liste + présence des livrables produits par les conversations.
 * 10. Non-régression : /studio 200, routes missions, Redis.
 */

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `e2e-wave17-${Date.now()}@gen3ia.test`;
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
  const headers = { "content-type": "application/json", cookie };
  log("1/auth", "compte + session OK");

  // 2. Pages publiques
  const home = await fetch(`${BASE}/`);
  check("2/accueil", home.status === 200, `HTTP ${home.status}`);
  const homeHtml = await home.text();
  check("2/accueil-gen", /gen/i.test(homeHtml), "widget Gen présent");
  const dashboard = await fetch(`${BASE}/dashboard`);
  check("2/dashboard", dashboard.status === 200, `HTTP ${dashboard.status}`);
  const dashboardHtml = await dashboard.text();
  check("2/dashboard-leger", /Nouvelle conversation|conversation/i.test(dashboardHtml), "accueil conversationnel présent");

  // 3. Redirections
  const workspaceRoot = await fetch(`${BASE}/workspace`, { redirect: "manual" });
  check("3/workspace-redirect", workspaceRoot.status >= 300 && workspaceRoot.status < 400 && (workspaceRoot.headers.get("location") ?? "").includes("/workspace/conversations"), `→ ${workspaceRoot.headers.get("location")}`);
  const connectors = await fetch(`${BASE}/workspace/connectors`, { redirect: "manual" });
  check("3/connectors-redirect", connectors.status >= 300 && connectors.status < 400 && (connectors.headers.get("location") ?? "").includes("/studio/connections"), `→ ${connectors.headers.get("location")}`);

  for (const route of ["/workspace/conversations", "/workspace/projects", "/workspace/files", "/workspace/bibliotheque", "/studio", "/studio/connections"]) {
    const res = await fetch(`${BASE}${route}`);
    check(`3/page ${route}`, res.status === 200, `HTTP ${res.status}`);
  }

  // 4. CRUD conversations
  const guard = await fetch(`${BASE}/api/workspace/conversations`);
  check("4/garde-auth", guard.status === 401, `HTTP ${guard.status} sans session`);
  const createRes = await fetch(`${BASE}/api/workspace/conversations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "E2E vague 17 — test conversationnel" }),
  });
  const created = await readJson(createRes, "create conversation");
  check("4/creation", createRes.status === 201 && !!created.conversation?.id, `id=${created.conversation?.id}`);
  const conversationId = created.conversation.id;

  const detailRes = await fetch(`${BASE}/api/workspace/conversations/${conversationId}`, { headers });
  const detail = await readJson(detailRes, "détail conversation");
  check("4/detail", detailRes.status === 200 && Array.isArray(detail.messages) && detail.messages.length === 0, "messages vides au départ");

  const renameRes = await fetch(`${BASE}/api/workspace/conversations/${conversationId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ title: "E2E 17 — renommée" }),
  });
  check("4/renommage", renameRes.status === 200);

  const archiveRes = await fetch(`${BASE}/api/workspace/conversations/${conversationId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "archived" }),
  });
  check("4/archivage", archiveRes.status === 200);
  await fetch(`${BASE}/api/workspace/conversations/${conversationId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "active" }),
  });

  // 5. Conversation réelle — réponse directe persistée
  log("5/turn-chat", "envoi d'un message conversationnel…");
  const chatRes = await fetch(`${BASE}/api/workspace/conversations/${conversationId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "Bonjour ! Réponds en une seule phrase : quel est ton rôle ?" }),
  });
  const chatTurn = await readJson(chatRes, "tour conversationnel chat");
  const chatOk =
    chatRes.status === 200 &&
    chatTurn.assistantMessage?.role === "assistant" &&
    typeof chatTurn.assistantMessage?.content === "string" &&
    chatTurn.assistantMessage.content.length > 2;
  check("5/reponse-directe", chatOk, `provider=${chatTurn.assistantMessage?.provider} len=${chatTurn.assistantMessage?.content?.length ?? 0}`);

  // 6. Demande d'image réelle
  log("6/turn-image", "demande d'image…");
  const imageRes = await fetch(`${BASE}/api/workspace/conversations/${conversationId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "Génère une image d'un renard minimaliste en style flat design" }),
  });
  const imageTurn = await readJson(imageRes, "tour image");
  const imageOk =
    imageRes.status === 200 &&
    !!(imageTurn.assistantMessage?.imageUrl || imageTurn.artifacts?.some((a) => a.type === "image"));
  const imageArtifact = imageTurn.artifacts?.find((a) => a.type === "image");
  check("6/image", imageOk, `imageUrl=${!!imageTurn.assistantMessage?.imageUrl} artifact=${imageArtifact?.id ?? "aucun"}`);

  // 7. Plan réel avec outil (recherche web — risque low, exécution directe)
  log("7/turn-plan", "demande nécessitant un plan avec outils…");
  const planRes = await fetch(`${BASE}/api/workspace/conversations/${conversationId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message: "Fais une recherche web sur les tendances de l'intelligence artificielle en Afrique en 2026 et résume-moi les trois points clés.",
    }),
  });
  const planTurn = await readJson(planRes, "tour plan");
  const run = planTurn.run;
  const planOk =
    planRes.status === 200 &&
    !!run &&
    Array.isArray(run.steps) &&
    run.steps.length >= 3 &&
    run.steps.some((s) => s.phase === "understanding") &&
    run.steps.some((s) => s.status === "done");
  check(
    "7/plan-timeline",
    planOk,
    `run=${run?.id ?? "aucun"} statut=${run?.status ?? "?"} étapes=${run?.steps?.length ?? 0}`,
  );
  const executedTool = run?.steps?.find((s) => s.toolName);
  check(
    "7/outil-reel",
    !!executedTool && executedTool.status === "done" && run.status === "completed",
    executedTool ? `outil=${executedTool.toolName} statut=${executedTool.status} run=${run.status}` : "aucun outil exécuté",
  );

  // 8. Projets
  const projectRes = await fetch(`${BASE}/api/workspace/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "E2E 17 — Projet test",
      description: "Projet de validation e2e",
      instructions: "Réponds toujours en français, de façon concise.",
      privacyRules: "Ne jamais citer de données personnelles.",
      authorizedConnectors: ["web"],
    }),
  });
  const project = await readJson(projectRes, "création projet");
  check("8/projet-creation", projectRes.status === 201 && !!project.project?.id, `id=${project.project?.id}`);

  const convInProjectRes = await fetch(`${BASE}/api/workspace/conversations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Conversation projet", projectId: project.project.id }),
  });
  const convInProject = await readJson(convInProjectRes, "conversation projet");
  check("8/conversation-projet", convInProjectRes.status === 201 && convInProject.conversation?.projectId === project.project.id);

  const projectConversationsRes = await fetch(
    `${BASE}/api/workspace/conversations?projectId=${project.project.id}`,
    { headers },
  );
  const projectConversations = await readJson(projectConversationsRes, "conversations projet");
  check(
    "8/liste-projet",
    projectConversationsRes.status === 200 &&
      projectConversations.conversations.some((c) => c.id === convInProject.conversation.id),
    `${projectConversations.conversations.length} conversation(s) rattachée(s)`,
  );

  const projectDetailRes = await fetch(`${BASE}/api/workspace/projects/${project.project.id}`, { headers });
  const projectDetail = await readJson(projectDetailRes, "détail projet");
  check(
    "8/projet-detail",
    projectDetailRes.status === 200 &&
      projectDetail.project.instructions?.includes("français") &&
      Array.isArray(projectDetail.project.authorizedConnectors),
  );

  // 9. Artefacts
  const artifactsRes = await fetch(`${BASE}/api/workspace/artifacts?conversationId=${conversationId}`, { headers });
  const artifactsData = await readJson(artifactsRes, "artefacts conversation");
  const hasImageArtifact = artifactsData.artifacts.some((a) => a.type === "image");
  check("9/artefacts-liste", artifactsRes.status === 200 && Array.isArray(artifactsData.artifacts), `${artifactsData.artifacts.length} artefact(s)`);
  check("9/artefact-image", hasImageArtifact, "artefact image produit par la conversation");
  const runsInConversation = await fetch(`${BASE}/api/workspace/conversations/${conversationId}`, { headers });
  const fullDetail = await readJson(runsInConversation, "détail complet");
  check(
    "9/persistance-complete",
    fullDetail.messages.length >= 6 && fullDetail.runs.length >= 1 && fullDetail.conversation.messageCount >= 6,
    `messages=${fullDetail.messages.length} runs=${fullDetail.runs.length}`,
  );

  // 10. Non-régression
  const healthRes = await fetch(`${BASE}/api/health/infra`, { headers });
  check("10/infra-health", healthRes.status === 200, `HTTP ${healthRes.status}`);
  const missionsRes = await fetch(`${BASE}/api/workspace/tasks`, { headers });
  check("10/missions-api", missionsRes.status === 200, `HTTP ${missionsRes.status}`);

  console.log(failures === 0 ? "\n✅ TOUS LES TESTS E2E VAGUE 17 SONT VERTS" : `\n❌ ${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("ERREUR FATALE :", error.message);
  process.exit(1);
});
