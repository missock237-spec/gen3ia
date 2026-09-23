#!/usr/bin/env node
/**
 * E2E production — vague 19 (sécurité renforcée + recherche sémantique + UX).
 * Vérifie sur https://gen3ia.online :
 *  - headers de sécurité nouveaux (COOP, CORP, X-DNS-Prefetch-Control) ;
 *  - route de recherche sémantique déployée et protégée (401 sans session) ;
 *  - défense CSRF : POST cross-origin avec Origin hostile → 403 ;
 *  - POST same-origin sans session → 401 (pas de 403 : l'origine est OK) ;
 *  - rate-limit en production (31 POST /api/auth/session → 429 au 31e) ;
 *  - non-régression : accueil, login, chat Gen réel, pages workspace.
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
  // 1) Headers de sécurité sur l'accueil.
  const home = await fetch(BASE + "/");
  check("accueil 200", home.status === 200, String(home.status));
  const headers = home.headers;
  check("COOP same-origin-allow-popups", headers.get("cross-origin-opener-policy") === "same-origin-allow-popups", headers.get("cross-origin-opener-policy") ?? "absent");
  check("CORP same-origin", headers.get("cross-origin-resource-policy") === "same-origin", headers.get("cross-origin-resource-policy") ?? "absent");
  check("X-DNS-Prefetch-Control off", headers.get("x-dns-prefetch-control") === "off", headers.get("x-dns-prefetch-control") ?? "absent");
  check("HSTS actif", /^max-age=\d+/.test(headers.get("strict-transport-security") ?? ""), headers.get("strict-transport-security") ?? "absent");

  // 2) Recherche sémantique déployée : protégée (401 sans session) —
  //    un 404 signifierait que la route n'est pas déployée.
  const search = await fetch(`${BASE}/api/workspace/conversations/search?q=promouvoir%20mes%20produits`);
  check("route recherche sémantique déployée + protégée", search.status === 401, String(search.status));

  // 3) CSRF : POST cross-origin (Origin hostile) → refus 403 AVANT même
  //    l'authentification. Un 401 ou 200 signifierait la validation absente.
  const csrf = await fetch(`${BASE}/api/workspace/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://site-hostile.example" },
    body: JSON.stringify({ title: "csrf" }),
  });
  check("CSRF cross-origin refusé (403)", csrf.status === 403, String(csrf.status));

  // 4) POST same-origin sans session → 401 attendu (l'origine ne bloque pas).
  const sameOrigin = await fetch(`${BASE}/api/workspace/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ title: "test" }),
  });
  check("POST same-origin sans session → 401", sameOrigin.status === 401, String(sameOrigin.status));

  // 5) Rate limit production : 30 sessions/5 min par IP. Le réseau de
  //    test peut faire tourner son IP de sortie : on envoie 90 requêtes et
  //    on attend AU MOINS UN 429 (preuve que la limite mord en production,
  //    décision Redis partagée entre instances serverless).
  let rateLimited = 0;
  for (let i = 0; i < 90; i++) {
    const response = await fetch(`${BASE}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE },
      body: "{}",
    });
    if (response.status === 429) rateLimited += 1;
  }
  check("rate-limit session actif (≥1× 429 sur 90 requêtes)", rateLimited > 0, `${rateLimited} × 429`);

  // 6) Non-régression : chat Gen réel.
  const chat = await fetch(`${BASE}/api/gen/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Réponds en un seul mot : test ?" }),
  });
  const chatBody = await chat.json().catch(() => ({}));
  check("chat Gen répond réellement", chat.status === 200 && typeof chatBody.reply === "string" && chatBody.reply.length > 0, `${chat.status}, ${String(chatBody.reply ?? "").length} car.`);

  // 7) Non-régression : pages workspace publiques (sans session → rendu ou
  //    redirection, jamais 404/500).
  for (const path of ["/workspace/conversations", "/workspace/projects", "/workspace/files", "/workspace/bibliotheque"]) {
    const response = await fetch(BASE + path);
    check(`page ${path}`, response.status === 200 || response.status === 307, String(response.status));
  }

  // Rapport.
  for (const line of results) console.log(line);
  console.log(`\n${passed} VERTS / ${failed} ROUGES`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("FATAL:", error);
  process.exit(1);
});
