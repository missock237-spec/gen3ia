#!/usr/bin/env node
/**
 * Vérification e2e production — commit c5750e9 (Tâche 34).
 * Mission : « pendant une tâche d'exécution des agents ia les utilisateurs
 * peuvent arrêter à tout moment les agents une fois qui sont en train de
 * travailler sur une tâche » + « enlève dans tout le projet la délimitation
 * d'espace paddé qu'il existe ».
 *
 * 1. signUp Firebase + session                                  : compte réel.
 * 2. GET /api/public/health                                     : site vivant.
 * 3. CSS des pages app (login + vitrine) : AUCUNE règle "dashed" restante
 *    → les délimitations d'espace (cadres pointillés) ont DISPARU de tout
 *    le projet (globals.css + classes Tailwind compilées).
 * 4. Tâche workspace réelle : création (plan LLM) → approbation →
 *    exécution en arrière-plan → ARRÊT en cours d'exécution
 *    (POST /api/workspace/tasks/{id}/stop) → statut "cancelled" EN BASE,
 *    l'exécution s'arrête proprement (jamais "failed").
 * 5. Arrêt depuis la pause : pause d'une 2e tâche puis stop → "cancelled".
 * 6. Régressions : provider email actif + publicités toujours diffusées.
 */

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `e2e-stop-${Date.now()}@gen3ia.test`;
const PASSWORD = "Gen3iaE2E!2026";

let failures = 0;
function check(step, ok, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} [${step}]${extra ? " " + extra : ""}`);
  if (!ok) failures += 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTask(cookie, id) {
  const res = await fetch(`${BASE}/api/workspace/tasks/${id}`, { headers: { cookie }, cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  return { res, task: data.task ?? null };
}

async function waitStatus(cookie, id, wanted, maxMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const { task } = await getTask(cookie, id);
    if (task && task.status === wanted) return task;
    if (task && ["completed", "failed", "cancelled"].includes(task.status) && !wanted.includes(task.status)) return task;
    await sleep(3000);
  }
  return null;
}

const TERMINAL = ["completed", "failed", "cancelled"];

/**
 * Arrêt avec relances : la demande part tôt et est relancée tant que la
 * tâche est toujours active — l'arrêt doit être possible À TOUT MOMENT,
 * y compris pendant le lot d'étapes en cours.
 */
async function stopWithRetry(cookie, id, reason) {
  const t0 = Date.now();
  while (Date.now() - t0 < 45_000) {
    const { task } = await getTask(cookie, id);
    if (task && TERMINAL.includes(task.status)) return { status: task.status, attempts: -1 };
    const res = await fetch(`${BASE}/api/workspace/tasks/${id}/stop`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ reason }),
    });
    if (res.ok) return { status: (await res.json().catch(() => ({})))?.task?.status ?? "cancelled", attempts: 1 };
    await sleep(2500);
  }
  return { status: null, attempts: 0 };
}

async function pauseWithRetry(cookie, id) {
  const t0 = Date.now();
  while (Date.now() - t0 < 45_000) {
    const { task } = await getTask(cookie, id);
    if (task && TERMINAL.includes(task.status)) return { status: task.status };
    const res = await fetch(`${BASE}/api/workspace/tasks/${id}/pause`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ reason: "e2e pause" }),
    });
    if (res.ok) return { status: (await res.json().catch(() => ({})))?.task?.status ?? "paused" };
    await sleep(2500);
  }
  return { status: null };
}

async function main() {
  console.log("=== ARRÊT DES AGENTS À TOUT MOMENT + DÉLIMITATIONS SUPPRIMÉES —", BASE, "===");

  // 1. Compte réel + session
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

  // 2. Site vivant
  const healthRes = await fetch(`${BASE}/api/public/health`, { cache: "no-store" });
  check("2/health", healthRes.ok, `HTTP ${healthRes.status}`);

  // 3. Délimitations d'espace (cadres pointillés) SUPPRIMÉES de tout le projet
  let cssOk = true;
  let cssDetail = "";
  for (const page of ["/", "/login"]) {
    const html = await fetch(`${BASE}${page}`, { cache: "no-store" }).then((r) => r.text());
    const hrefs = [...html.matchAll(/href="([^"]+\.css[^"]*)"/g)].map((m) => (m[1].startsWith("http") ? m[1] : `${BASE}${m[1]}`));
    const cssTexts = await Promise.all(hrefs.map((href) => fetch(href, { cache: "no-store" }).then((r) => r.text())));
    const dashed = cssTexts.filter((css) => css.includes("dashed")).length;
    if (dashed > 0) { cssOk = false; cssDetail += ` ${page}:${dashed}css(dashed)`; }
  }
  check("3/delimitations-supprimees", cssOk, `aucune règle "dashed" dans les CSS servis${cssDetail}`);

  // 4. Tâche réelle : création → approbation → exécution → ARRÊT en cours
  const createRes = await fetch(`${BASE}/api/workspace/tasks`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ objective: "Rédige un rapport détaillé en trois sections (marché, technique, risques) de 250 mots chacune, puis conclus par un plan d'action en cinq points numérotés." }),
  });
  const created = await createRes.json().catch(() => ({}));
  const taskId = created.task?.id;
  check("4/create-task", createRes.ok && Boolean(taskId), `HTTP ${createRes.status} id=${taskId ?? "?"}`);
  if (taskId) {
    const approveRes = await fetch(`${BASE}/api/workspace/tasks/${taskId}/approve`, { method: "POST", headers: { "content-type": "application/json", cookie } });
    const approvedTask = (await approveRes.json().catch(() => ({})))?.task;
    check("4b/approve", approveRes.ok && approvedTask?.status === "approved", `HTTP ${approveRes.status} status=${approvedTask?.status ?? "?"}`);

    // Exécution en arrière-plan (bloquante côté serveur, volontairement
    // non attendue : l'arrêt doit intervenir PENDANT l'exécution).
    const executePromise = fetch(`${BASE}/api/workspace/tasks/${taskId}/execute`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({}),
    }).then((r) => r.json().catch(() => ({}))).catch(() => ({}));

    // Arrêt À TOUT MOMENT : demandé tôt, relancé tant que la tâche est active.
    await sleep(3000);
    const stop = await stopWithRetry(cookie, taskId, "e2e : arrêt à tout moment");
    check("4c/stop-en-cours", stop.status === "cancelled", `status=${stop.status}`);

    // Le runtime en cours doit terminer à l'état cancelled (jamais failed).
    const settled = await waitStatus(cookie, taskId, ["cancelled"], 90_000);
    const execResult = await executePromise;
    const execStatus = execResult?.status ?? "?";
    check("4d/runtime-arrete-propre", settled?.status === "cancelled" && (execStatus === "cancelled" || execStatus === "?"), `task=${settled?.status ?? "timeout"} execute=${execStatus}`);
    const stillCancelled = (await getTask(cookie, taskId)).task?.status;
    check("4e/etat-final-stable", stillCancelled === "cancelled", `status=${stillCancelled}`);
  }

  // 5. Arrêt depuis la pause (tâche 2 : pause pendant l'exécution puis stop)
  const create2 = await fetch(`${BASE}/api/workspace/tasks`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ objective: "Rédige trois briefs détaillés (400 mots chacun) de newsletters IA : pour chaque brief, un titre, une accroche et trois sections développées." }),
  });
  const created2 = await create2.json().catch(() => ({}));
  const taskId2 = created2.task?.id;
  if (taskId2) {
    await fetch(`${BASE}/api/workspace/tasks/${taskId2}/approve`, { method: "POST", headers: { "content-type": "application/json", cookie } });
    const executePromise2 = fetch(`${BASE}/api/workspace/tasks/${taskId2}/execute`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({}),
    }).then((r) => r.json().catch(() => ({}))).catch(() => ({}));
    await sleep(3000);
    const pauseRes = await fetch(`${BASE}/api/workspace/tasks/${taskId2}/pause`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ reason: "e2e pause" }),
    });
    // La pause est une DEMANDE (le statut bascule "paused" à la prochaine
    // consultation du runtime) ; l'arrêt qui suit doit gagner immédiatement.
    const pauseAccepted = pauseRes.ok;
    const stop2 = await stopWithRetry(cookie, taskId2, "e2e : arrêt depuis la pause");
    check("5/stop-depuis-pause", pauseAccepted && stop2.status === "cancelled", `pause200=${pauseAccepted} stop=${stop2.status}`);
    await executePromise2;
    const final2 = (await getTask(cookie, taskId2)).task?.status;
    check("5b/etat-final-pause-stop", final2 === "cancelled", `status=${final2}`);
  } else {
    check("5/stop-depuis-pause", false, "tâche 2 non créée");
  }

  // 6. Régressions : email + publicités
  const statusRes = await fetch(`${BASE}/api/integrations/status`, { headers: { cookie }, cache: "no-store" });
  const statusData = await statusRes.json().catch(() => ({}));
  check("6/email-provider", statusRes.ok && statusData?.email === true, `email=${statusData?.email}`);
  const adsRes = await fetch(`${BASE}/api/ads/placement?placement=settings&mode=all`, { headers: { cookie }, cache: "no-store" });
  const adsData = await adsRes.json().catch(() => ({}));
  const adsCount = Array.isArray(adsData?.ads) ? adsData.ads.length : adsData?.ad ? 1 : 0;
  check("6b/publicites", adsRes.ok && adsCount >= 1, `${adsCount} annonce(s)`);

  console.log(failures === 0 ? "\n✅ TOUS LES CONTRÔLES VERTS" : `\n❌ ${failures} CONTRÔLE(S) EN ÉCHEC`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
