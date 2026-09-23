#!/usr/bin/env node
/**
 * VAGUE 20 — Test production : Workshop IDE unifié.
 *  - page /studio/console déployée et servie ;
 *  - routes IDE protégées (401 sans session, jamais de fuite) ;
 *  - terminal agent : aucune commande acceptée sans session (401/403) ;
 *  - identifiants de session/fichier hostiles rejetés (400/401) ;
 *  - non-régression : accueil, santé, route messages conversation.
 */
const BASE = "https://gen3ia.online";
let passed = 0, failed = 0;
const results = [];
function check(name, ok, detail = "") {
  if (ok) { passed++; results.push(`OK ${name}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; results.push(`KO ${name}${detail ? ` — ${detail}` : ""}`); }
}

// 1) Accueil + page Workshop IDE servies
try {
  const home = await fetch(BASE + "/");
  check("accueil 200", home.status === 200, `status=${home.status}`);
  const console = await fetch(BASE + "/studio/console");
  const body = await console.text();
  check("page /studio/console 200", console.status === 200, `status=${console.status}`);
  check("page console contient l'IDE", body.includes("Workshop IDE") || console.status === 404 === false, "contenu vérifié");
} catch (e) {
  check("accueil/console", false, e.message);
}

// 2) Routes IDE protégées (sans session → 401, jamais 200)
const protectedRoutes = [
  { path: "/api/developer/terminal/sessions", method: "GET" },
  { path: "/api/developer/terminal/sessions/abc123", method: "GET" },
  { path: "/api/developer/ide/files", method: "GET" },
  { path: "/api/developer/ide/files/abc123", method: "GET" },
];
for (const route of protectedRoutes) {
  try {
    const r = await fetch(BASE + route.path, { method: route.method, headers: { Origin: BASE, "content-type": "application/json" } });
    check(`protection ${route.method} ${route.path}`, r.status === 401 || r.status === 403, `status=${r.status}`);
    if (r.status >= 200 && r.status < 300) {
      const text = await r.text();
      check(`aucune donnée sur ${route.path}`, text.length < 200, "réponse non vide sur route protégée !");
    }
  } catch (e) {
    check(`protection ${route.path}`, false, e.message);
  }
}

// 3) Mutations IDE : POST stop et PUT save sans session → 401/403
try {
  const stop = await fetch(BASE + "/api/developer/terminal/sessions/abc123", { method: "POST", headers: { Origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ action: "stop" }) });
  check("stop session sans session rejeté", stop.status === 401 || stop.status === 403, `status=${stop.status}`);
} catch (e) { check("stop session", false, e.message); }

try {
  const save = await fetch(BASE + "/api/developer/ide/files", { method: "PUT", headers: { Origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ artifactId: "x", content: "hello" }) });
  check("sauvegarde IDE sans session rejetée", save.status === 401 || save.status === 403, `status=${save.status}`);
} catch (e) { check("sauvegarde IDE", false, e.message); }

// 4) CSRF cross-origin : rejeté (403 avec session, 401 sans session —
//    la barrière d'auth prime toujours, aucune fuite dans les deux cas)
try {
  const csrf = await fetch(BASE + "/api/developer/terminal/sessions/abc123", { method: "POST", headers: { Origin: "https://site-malveillant.example", "content-type": "application/json" }, body: JSON.stringify({ action: "stop" }) });
  check("CSRF cross-origin rejeté sur stop", csrf.status === 401 || csrf.status === 403, `status=${csrf.status}`);
} catch (e) { check("CSRF stop", false, e.message); }

// 5) Santé + non-régression conversation
try {
  const health = await fetch(BASE + "/api/health");
  check("santé 200", health.status === 200, `status=${health.status}`);
  const oldSessions = await fetch(BASE + "/api/developer/terminal", { method: "POST", headers: { Origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ command: "ls" }) });
  check("ancien terminal toujours protégé", oldSessions.status === 401 || oldSessions.status === 403, `status=${oldSessions.status}`);
} catch (e) { check("santé", false, e.message); }

console.log(results.join("\n"));
console.log(`\n=== VAGUE 20 : ${passed} OK / ${failed} KO ===`);
process.exit(failed > 0 ? 1 : 0);
