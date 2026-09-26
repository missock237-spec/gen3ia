#!/usr/bin/env node
/**
 * Vérification e2e production — commit 351e4e4 (Tâche 34-J : ARTEFACTS).
 * Mission : « Assure-toi que tout ça est bien implémenté dans le projet et
 * que les agents IA puissent très bien le réaliser selon la conversation ou
 * la demande de l'utilisateur » — AI Slides, Full-Stack (page web React),
 * Analyse de données (graphique réel), et la fonctionnalité ARTEFACTS :
 * un lien web qui rend le code directement dans le navigateur.
 *
 * 1. signUp Firebase + session                                   : compte réel.
 * 2. Santé /api/public/health                                    : plateforme OK.
 * 3. ARTEFACT APP — « agent ia, aidez-moi à créer une page web de
 *    liste de tâches en mode sombre, écrite en React. »          : artefact
 *    code/html créé + LIEN WEB /preview/<id> dans la réponse.
 * 4. GET /preview/<id> (avec session)                            : page 200,
 *    rendu iframe sandboxé srcDoc + barre Gen3ia.
 * 5. GET /preview/<id> SANS session                              : page 200
 *    « Connexion requise » (l'aperçu reste privé).
 * 6. ANALYSE DE DONNÉES — « génère un graphique en barres : Ventes: 120,
 *    Marketing: 80, Développement: 150 »                         : artefact
 *    graphique + lien /preview + export PNG/JPG + conclusions.
 * 7. AI SLIDES — « Crée une présentation PowerPoint de lancement produit »
 *    : étape artifact.create=done + livrable pptx dans les artefacts.
 * 8. Non-régression : aucune règle "dashed" dans les CSS servis.
 * 9. Non-régression : publicités toujours diffusées (3 annonces).
 */

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `e2e-artefact-${Date.now()}@gen3ia.test`;
const PASSWORD = "Gen3iaE2E!2026";

let failures = 0;
function check(step, ok, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} [${step}]${extra ? " " + extra : ""}`);
  if (!ok) failures += 1;
}

async function consumeStream(cookie, conversationId, message, extraBody = {}) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/workspace/conversations/${conversationId}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ message, ...extraBody }),
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

function finalMessage(events) {
  const complete = [...events].reverse().find((e) => e.type === "message_complete")?.message;
  return complete?.content ?? "";
}

function artifactsFrom(events) {
  return events.filter((e) => e.type === "artifact_created").map((e) => e.artifact);
}

function runSteps(events) {
  const latest = new Map();
  for (const e of events.filter((e) => e.type === "step_update")) {
    if (e.step?.id) latest.set(e.step.id, e.step);
  }
  return [...latest.values()];
}

async function newConversation(cookie) {
  const res = await fetch(`${BASE}/api/workspace/conversations`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  return data.conversation?.id;
}

async function main() {
  console.log("=== VÉRIFICATION ARTEFACTS + AI SLIDES + ANALYSE DE DONNÉES —", BASE, "===");

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

  // 2. Santé
  const healthRes = await fetch(`${BASE}/api/public/health`, { cache: "no-store" });
  check("2/health", healthRes.ok, `HTTP ${healthRes.status}`);

  // 3. ARTEFACT APP — l'exemple exact de la demande utilisateur
  const c3 = await newConversation(cookie);
  const r3 = await consumeStream(cookie, c3, "agent ia, aidez-moi à créer une page web de liste de tâches en mode sombre, écrite en React.");
  const msg3 = finalMessage(r3.events);
  const artifacts3 = artifactsFrom(r3.events);
  const app = artifacts3.find((a) => a.type === "code" && (a.language === "html" || /\.html$/i.test(a.filename ?? "")));
  const previewLink = msg3.match(/\/preview\/([a-zA-Z0-9-]+)/);
  check("3/artefact-app", r3.status === 200 && Boolean(app) && Boolean(previewLink),
    r3.status === 200
      ? `artefact=${app ? `${app.id} (${app.filename ?? "?"})` : "ABSENT"} · lien=${previewLink ? previewLink[0] : "ABSENT"} · ${r3.ms} ms`
      : `HTTP ${r3.status} · ${r3.error ?? ""}`);
  const appId = app?.id ?? previewLink?.[1];

  // 4. Rendu du lien web AVEC session
  if (appId) {
    const pv = await fetch(`${BASE}/preview/${appId}`, { headers: { cookie }, redirect: "manual" });
    const html = await pv.text();
    // Le rendu serveur sérialise la prop srcDoc en attribut srcdoc — le
    // contenu de l'application est donc présent dans la page.
    const rendersApp = pv.ok
      && /sandbox="allow-scripts/i.test(html)
      && /srcdoc="&lt;!DOCTYPE html|srcdoc="<!DOCTYPE html/i.test(html)
      && /rendu en direct/i.test(html);
    check("4/preview-rendu", rendersApp,
      rendersApp ? `HTTP ${pv.status} · iframe sandboxé + document rendu + barre Gen3ia présents` : `HTTP ${pv.status} · iframe=${/<iframe/i.test(html)} · sandbox=${/sandbox="/i.test(html)} · srcdoc=${/srcdoc=/i.test(html)} · contenu=${html.slice(0, 150).replace(/\s+/g, " ")}`);
  } else {
    check("4/preview-rendu", false, "pas d'artefact app à prévisualiser");
  }

  // 5. Rendu SANS session → « Connexion requise » (privé, pas de fuite)
  if (appId) {
    const pvAnon = await fetch(`${BASE}/preview/${appId}`, { redirect: "manual" });
    const anonHtml = await pvAnon.text();
    const gated = pvAnon.ok && /Connexion requise/i.test(anonHtml) && !/srcDoc/i.test(anonHtml);
    check("5/preview-prive", gated,
      gated ? `HTTP ${pvAnon.status} · page de connexion affichée, contenu jamais servi` : `HTTP ${pvAnon.status} · gated=${/Connexion requise/i.test(anonHtml)}`);
  } else {
    check("5/preview-prive", false, "pas d'artefact app à tester");
  }

  // 6. ANALYSE DE DONNÉES — graphique réel depuis des valeurs énoncées
  const c6 = await newConversation(cookie);
  const r6 = await consumeStream(cookie, c6, "Génère un graphique en barres à partir de ces données : Ventes: 120, Marketing: 80, Développement: 150.");
  const msg6 = finalMessage(r6.events);
  const artifacts6 = artifactsFrom(r6.events);
  const chart = artifacts6.find((a) => a.type === "code" && /graphique/i.test(a.title ?? ""));
  const chartLink = msg6.match(/\/preview\/([a-zA-Z0-9-]+)/);
  const chartHtmlOk = chart ? (chart.content ?? "").includes("echarts") && (chart.content ?? "").includes("Télécharger PNG") : false;
  const conclusionsOk = /Analyse\s*:/i.test(msg6) || /Total\s*:/i.test(msg6);
  check("6/analyse-donnees", r6.status === 200 && Boolean(chart) && Boolean(chartLink) && chartHtmlOk && conclusionsOk,
    r6.status === 200
      ? `artefact=${chart ? chart.id : "ABSENT"} · lien=${chartLink ? chartLink[0] : "ABSENT"} · echarts+export=${chartHtmlOk} · conclusions=${conclusionsOk}`
      : `HTTP ${r6.status}`);

  // 7. AI SLIDES — présentation PowerPoint professionnelle
  const c7 = await newConversation(cookie);
  const r7 = await consumeStream(cookie, c7, "Crée une présentation PowerPoint de lancement produit pour notre application mobile.");
  const steps7 = runSteps(r7.events);
  const docStep = steps7.find((s) => s.toolName === "artifact.create" && String(s.toolInput?.format ?? "") === "pptx");
  const artifacts7 = artifactsFrom(r7.events);
  check("7/ai-slides", r7.status === 200 && docStep?.status === "done" && artifacts7.length >= 1,
    r7.status === 200
      ? `étape artifact.create(pptx)=${docStep?.status ?? "ABSENTE"} · artefacts=${artifacts7.length} · sortie=${String(docStep?.output ?? "").slice(0, 90).replace(/\s+/g, " ")}`
      : `HTTP ${r7.status}`);

  // 8. Non-régression délimitations : aucun style "dashed" servi
  for (const path of ["/", "/login"]) {
    const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
    const html = await res.text();
    const cssUrls = [...html.matchAll(/href="([^"]+\.css[^"]*)"/g)].map((m) => m[1]);
    let dashed = 0;
    for (const url of cssUrls) {
      const cssRes = await fetch(url.startsWith("http") ? url : `${BASE}${url}`, { cache: "no-store" });
      if (cssRes.ok) {
        const css = await cssRes.text();
        dashed += (css.match(/dashed/g) ?? []).length;
      }
    }
    check(`8/sans-delimitation${path.replaceAll("/", "-")}`, res.ok && dashed === 0, `${cssUrls.length} CSS · occurrences dashed=${dashed}`);
  }

  // 9. Non-régression publicité
  const adRes = await fetch(`${BASE}/api/ads/placement?placement=settings&mode=all`, { headers: { cookie }, cache: "no-store" });
  const adData = await adRes.json().catch(() => ({}));
  const adCount = Array.isArray(adData?.ads) ? adData.ads.length : 0;
  check("9/pub-toujours-la", adRes.ok && adCount >= 1, `${adCount} annonce(s) diffusée(s)`);

  console.log(`\n=== RÉSULTAT : ${failures === 0 ? "TOUS VERTS ✓" : `${failures} ÉCHEC(S) ✗`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("ERREUR SCRIPT:", error);
  process.exit(1);
});
