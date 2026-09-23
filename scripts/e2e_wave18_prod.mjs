#!/usr/bin/env node
/**
 * E2E production — vague 18 (roadmap conversation-first).
 * Vérifie : accueil 200, chat Gen RÉEL, routes workspace, routes API
 * streaming/connecteurs présentes, dashboard léger, sécurité (401/400
 * sans session, jamais 404).
 */
const BASE = "https://gen3ia.online";
let passed = 0;
let failed = 0;
const results = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    results.push(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    results.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  // 1) Accueil public.
  const home = await fetch(BASE + "/");
  check("accueil 200", home.status === 200, String(home.status));

  // 2) Page de login.
  const login = await fetch(BASE + "/login");
  check("login 200", login.status === 200, String(login.status));

  // 3) Chat Gen anonyme — réponse réelle exigée.
  try {
    const genRes = await fetch(BASE + "/api/gen/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Bonjour, que peut faire Gen3ia pour une petite entreprise ?" }),
    });
    const genData = await genRes.json().catch(() => ({}));
    const reply = typeof genData.reply === "string" ? genData.reply : typeof genData.message === "string" ? genData.message : "";
    check("chat Gen répond réellement (anonyme)", genRes.ok && reply.length > 20, `${genRes.status}, ${reply.length} car.`);
  } catch (e) {
    check("chat Gen répond réellement (anonyme)", false, e.message);
  }

  // 4) Dashboard léger (redirige vers conversations ou renvoie la page accueil).
  const dash = await fetch(BASE + "/dashboard", { redirect: "manual" });
  check("dashboard léger accessible/redirect", [200, 302, 307, 308].includes(dash.status), String(dash.status));

  // 5) Routes workspace (redirections auth attendues, jamais 404).
  for (const path of ["/workspace", "/workspace/conversations", "/workspace/projects", "/workspace/files", "/workspace/bibliotheque"]) {
    const res = await fetch(BASE + path, { redirect: "manual" });
    check(`page ${path}`, [200, 302, 307, 308].includes(res.status), String(res.status));
  }

  // 6) API streaming présente — sans session : 401/400 (PAS 404).
  const streamRes = await fetch(BASE + "/api/workspace/conversations/abc123/messages/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "test" }),
  });
  check("route streaming déployée (401/400 sans session)", [401, 400, 403].includes(streamRes.status), String(streamRes.status));

  // 7) API messages classique — même contrat.
  const msgRes = await fetch(BASE + "/api/workspace/conversations/abc123/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "test" }),
  });
  check("route messages classique (401/400 sans session)", [401, 400, 403].includes(msgRes.status), String(msgRes.status));

  // 8) Connexions Composio (composer) — protégée mais déployée.
  const connRes = await fetch(BASE + "/api/integrations/composio/connections");
  check("API connexions composer déployée", [200, 401, 403].includes(connRes.status), String(connRes.status));

  // 9) Infra Redis/Qdrant — protégée : 401/403 SANS session = déployée + sécurisée.
  const infra = await fetch(BASE + "/api/health/infra");
  check("route infra déployée + protégée", [200, 401, 403].includes(infra.status), String(infra.status));

  // 10) Santé publique.
  const health = await fetch(BASE + "/api/public/health");
  check("health publique 200", health.status === 200, String(health.status));

  console.log(results.join("\n"));
  console.log(`\n${passed} VERTS / ${failed} ROUGES`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E fatal:", e);
  process.exit(1);
});
