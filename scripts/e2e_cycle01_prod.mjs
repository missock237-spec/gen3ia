#!/usr/bin/env node
/**
 * CYCLE 1/10 — Test production : fondations & disponibilité.
 * Cible : https://gen3ia.online
 *  - pages publiques (accueil, login) ;
 *  - pages workspace (200 ou redirection auth) ;
 *  - endpoints santé ;
 *  - headers de sécurité ;
 *  - surface API protégée (401 sans session, jamais 404/500).
 */
const BASE = "https://gen3ia.online";
let passed = 0, failed = 0;
const results = [];
function check(name, ok, detail = "") {
  if (ok) { passed++; results.push(`OK ${name}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; results.push(`KO ${name}${detail ? ` — ${detail}` : ""}`); }
}
const timed = async (label, fn) => {
  const t0 = Date.now();
  try { await fn(); } catch (e) { check(label, false, `EXCEPTION ${e.message}`); }
};

await timed("accueil", async () => {
  const r = await fetch(BASE + "/", { redirect: "manual" });
  check("accueil 200", r.status === 200, String(r.status));
  const html = await r.text();
  check("accueil contient app Gen3ia", /gen3ia/i.test(html), `${html.length} octets`);
  check("accueil pas d'erreur Next", !/application error|__next_error__/i.test(html));
});
await timed("login", async () => {
  const r = await fetch(BASE + "/login");
  check("login 200", r.status === 200, String(r.status));
});
await timed("headers", async () => {
  const r = await fetch(BASE + "/");
  check("HSTS", /^max-age=\d+/.test(r.headers.get("strict-transport-security") ?? ""), r.headers.get("strict-transport-security") ?? "absent");
  check("X-Content-Type-Options nosniff", r.headers.get("x-content-type-options") === "nosniff");
  check("X-Frame-Options DENY", ["DENY", "SAMEORIGIN"].includes(r.headers.get("x-frame-options") ?? ""), r.headers.get("x-frame-options") ?? "absent");
  check("COOP", r.headers.get("cross-origin-opener-policy") === "same-origin-allow-popups", r.headers.get("cross-origin-opener-policy") ?? "absent");
  check("CORP", r.headers.get("cross-origin-resource-policy") === "same-origin", r.headers.get("cross-origin-resource-policy") ?? "absent");
  check("Referrer-Policy", !!r.headers.get("referrer-policy"), r.headers.get("referrer-policy") ?? "absent");
  check("Permissions-Policy", !!r.headers.get("permissions-policy"), r.headers.get("permissions-policy") ?? "absent");
});
await timed("pages workspace", async () => {
  for (const p of ["/workspace/conversations", "/workspace/conversations/abc", "/workspace/projects", "/workspace/files", "/workspace/bibliotheque", "/settings", "/studio", "/team", "/billing"]) {
    const r = await fetch(BASE + p, { redirect: "manual" });
    check(`page ${p}`, [200, 307, 308].includes(r.status), String(r.status));
  }
});
await timed("santé", async () => {
  const h = await fetch(BASE + "/api/health");
  check("GET /api/health", h.status === 200, String(h.status));
  const body = await h.json().catch(() => ({}));
  check("health status ok", body.status === "ok", JSON.stringify(body).slice(0, 120));
  const i = await fetch(BASE + "/api/health/infra");
  check("GET /api/health/infra", [200, 401].includes(i.status), String(i.status));
});
await timed("API protégée (sans session)", async () => {
  const probes = [
    ["GET", "/api/workspace/conversations"],
    ["GET", "/api/workspace/projects"],
    ["GET", "/api/workspace/artifacts"],
    ["GET", "/api/workspace/approvals/appr-test-id"],
    ["GET", "/api/workspace/tasks"],
    ["GET", "/api/files/workspaces"],
    ["GET", "/api/memory"],
    ["GET", "/api/integrations/catalog"],
    ["GET", "/api/agents"],
    ["GET", "/api/skills"],
    ["POST", "/api/tools/execute"],
    ["GET", "/api/teams"],
    ["GET", "/api/organizations"],
    ["GET", "/api/billing/wallet"],
    ["GET", "/api/billing/transactions"],
    ["GET", "/api/ai/image"],
    ["GET", "/api/live/sessions"],
    ["GET", "/api/voice/calls"],
    ["GET", "/api/voice/numbers"],
    ["GET", "/api/commercial"],
    ["GET", "/api/admin/platform"],
    ["GET", "/api/admin/users"],
    ["GET", "/api/observability/overview"],
    ["GET", "/api/security/emergency-stop"],
  ];
  for (const [method, path] of probes) {
    const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", Origin: BASE } });
    check(`${method} ${path} protégé`, [401, 403, 405, 400].includes(r.status), String(r.status));
  }
});

for (const line of results) console.log(line);
console.log(`\nCYCLE 1 : ${passed} VERTS / ${failed} ROUGES`);
process.exit(failed > 0 ? 1 : 0);
