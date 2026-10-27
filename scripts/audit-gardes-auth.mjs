#!/usr/bin/env node
/**
 * Audit des gardes d'authentification sur toutes les routes API gen3ia.
 *
 * Catégories :
 *   - GARDEE         : un pattern de garde est détecté dans le fichier
 *   - PUBLIQUE-OK    : route publique par conception (health, version, webhooks
 *                      à signature, cron à secret, metrics à token, docs…)
 *   - NUE-MUTATION   : POST/PUT/PATCH/DELETE sans garde détectée  ← P0
 *   - NUE-LECTURE    : GET/HEAD seulement sans garde                ← à trier
 *
 * Usage : node scripts/audit-gardes-auth.mjs [--json <fichier>]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(process.cwd(), "app", "api");

// Routes publiques par conception (aucune donnée métier, protection autre que
// l'auth utilisateur : signature webhook, secret cron, token metrics, HMAC de
// lien, aucune donnée sensible).
const PUBLIQUES_PAR_DESIGN = [
  "app/api/health",
  "app/api/deploy-info",
  "app/api/version",
  "app/api/public",
  "app/api/webhooks",            // signature HMAC Chariow / token trigger
  "app/api/integrations/webhooks",
  "app/api/cron",                // CRON_SECRET vérifié dans la route
  "app/api/metrics",             // METRICS_TOKEN (gate feature flag)
  "app/api/capabilities",
  "app/api/ia/status",
  // Stats publiques documentées (PUBLIC_API_EXACT de user-access.ts)
  "app/api/neural/public-stats",
  "app/api/status",
  // Flux d'authentification publics (rate-limités par IP) :
  "app/api/auth/r2/password-reset",
  // Approbation distante WhatsApp/Telegram : token HMAC du lien + rate limit
  "app/api/integrations/messaging/approvals",
  // Maillage ondes : salles publiques bornées et volatiles, salles privées
  // à clé (mesh-prive) — par conception
  "app/api/ondes/signaling",
  // Stats publiques volatiles
  "app/api/monde/stats",
  // Callback OAuth public (state validé)
  "app/api/ads/callback",
  // État d'accès de la session courante (anonyme = réponse publique)
  "app/api/auth/access",
  // API publique v1 : auth par clé g3a_ via franchirPorteV1 (HMAC)
  "app/api/v1",
];

const GARDES = [
  "verifyFirebaseRequest",
  "verifyFirebaseAuth",
  "verifyFirebaseToken",
  "requireAdmin",
  "requireAdminAccess",
  "requireUser",
  "requireDeveloperAccess",
  "requireAgentSystemAccess",
  "requireCodeAgentOwner",      // garde IDE/terminal développeur (code agent)
  "requireSystemAccess",        // garde _internal/system-only (training)
  "franchirPorteV1",            // porte clé API g3a_ (HMAC) des routes v1
  "requirePlatformRole",
  "protectRoute",             // garde centralisée lib/security/route-guard.ts
  "requireServiceAuth",
  "verifyServiceSignature",
  "verifyTickRequest",        // signature interne + bearer CRON_SECRET
  "assertStrongAuth",
  "assertLiveSessionOwner",
  "getServerSession",
  "readSessionCookie",
  "requireCronSecret",
  "CRON_SECRET",
  "METRICS_TOKEN",
  "GEN3IA_SERVICE_TOKENS",
  "authenticateDeveloper",    // clé API g3a_ (porte-v1)
  "timingSafeEqual",          // comparaison de token/secret manuelle
  "verifySignature",
  "verifyChariowSignature",
];

function listRouteFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listRouteFiles(p));
    else if (entry === "route.ts") out.push(p);
  }
  return out;
}

function methodsOf(src) {
  const methods = [];
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(src)) methods.push(m);
  }
  return methods;
}

const MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const routes = listRouteFiles(ROOT).map((f) => {
  const rel = relative(process.cwd(), f).split(sep).join("/");
  const src = readFileSync(f, "utf8");
  const methods = methodsOf(src);
  const gardee = GARDES.some((g) => src.includes(g));
  const publique = PUBLIQUES_PAR_DESIGN.some((p) => rel.startsWith(p));
  let categorie;
  if (gardee) categorie = "GARDEE";
  else if (publique) categorie = "PUBLIQUE-OK";
  else if (methods.some((m) => MUTATIONS.has(m))) categorie = "NUE-MUTATION";
  else categorie = "NUE-LECTURE";
  return { route: rel, methods, categorie };
});

const groupes = {
  "GARDEE": [],
  "PUBLIQUE-OK": [],
  "NUE-MUTATION": [],
  "NUE-LECTURE": [],
};
for (const r of routes) groupes[r.categorie].push(r);

const jsonIdx = process.argv.indexOf("--json");
if (jsonIdx > -1 && process.argv[jsonIdx + 1]) {
  writeFileSync(process.argv[jsonIdx + 1], JSON.stringify(routes, null, 2));
}

console.log(`Total routes analysées : ${routes.length}`);
for (const [cat, list] of Object.entries(groupes)) {
  console.log(`\n=== ${cat} : ${list.length} ===`);
  for (const r of list.slice(0, cat === "GARDEE" ? 0 : 200)) {
    console.log(`  [${r.methods.join(",") || "?"}] ${r.route}`);
  }
}
