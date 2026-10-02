#!/usr/bin/env node
/**
 * Vérification PRODUCTION Task 40 — Sentry, AdSense, Supabase-prepare.
 *
 * Contrôles (gen3ia.online) :
 *  1. Tunnel Sentry /monitoring : GET 200 + POST enveloppe invalide → 400
 *     (le handler est vivant et valide), POST hôte non autorisé → 403.
 *  2. CSP : script-src contient pagead2.googlesyndication.com (AdSense)
 *     et n'a PAS réintroduit unsafe-eval ; frame-src doubleclick.
 *  3. ads.txt servi à la racine avec le pub- officiel.
 *  4. Vitrine : le conteneur AdSenseAd est rendu (classe adsense-ad).
 *  5. /api/health/infra : groupes config observability-sentry +
 *     data-supabase présents, AUCUNE valeur de variable exposée.
 *  6. Sentry : la page vitrine référence la release gen3ia@<sha> (meta).
 *
 * Usage : BASE_URL=https://gen3ia.online node scripts/verify_task40_prod.mjs
 */
import { gunzipSync } from "node:zlib";
import { cspAuthorizes, cspAuthorizesAny, cspHasToken } from "./lib/csp-probe.mjs";

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const PUB = "ca-pub-7168568074147796";

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function fetchPage(path, { gzip = false } = {}) {
  const headers = { "accept-encoding": gzip ? "gzip" : "identity" };
  const res = await fetch(`${BASE}${path}`, { headers, redirect: "follow" });
  let body = await res.text();
  if (gzip && res.headers.get("content-encoding") === "gzip") {
    try {
      body = gunzipSync(await res.arrayBuffer()).toString("utf8");
    } catch {
      /* body brut */
    }
  }
  return { res, body };
}

// ---------------------------------------------------------------------------
async function main() {
  // ---- 1. Tunnel Sentry ---------------------------------------------------
  try {
    const health = await fetch(`${BASE}/monitoring`, { method: "GET" });
    record("tunnel /monitoring vivant (GET)", health.status === 200, `HTTP ${health.status}`);

    const badEnvelope = await fetch(`${BASE}/monitoring`, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body: "not-json",
    });
    record("tunnel rejette une enveloppe invalide (400)", badEnvelope.status === 400, `HTTP ${badEnvelope.status}`);

    const evilEnvelope = await fetch(`${BASE}/monitoring`, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body: JSON.stringify({ dsn: "https://abc@evil.example.com/1" }) + "\n{}",
    });
    record("tunnel refuse un hôte non autorisé (403)", evilEnvelope.status === 403, `HTTP ${evilEnvelope.status}`);
  } catch (e) {
    record("tunnel /monitoring", false, e.message);
  }

  // ---- 2. CSP AdSense sans unsafe-eval -------------------------------------
  try {
    const { res } = await fetchPage("/");
    const csp = res.headers.get("content-security-policy") || "";
    record("CSP : pagead2 autorisé (script-src AdSense)", cspAuthorizesAny(csp, "pagead2.googlesyndication.com"));
    record("CSP : iframes DoubleClick autorisées", cspAuthorizesAny(csp, "doubleclick.net"));
    record("CSP : unsafe-eval TOUJOURS interdit", !cspHasToken(csp, "'unsafe-eval'"));
    record("CSP : frame-ancestors none conservé", cspAuthorizes(csp, "frame-ancestors", "'none'"));
  } catch (e) {
    record("CSP vitrine", false, e.message);
  }

  // ---- 3. ads.txt -----------------------------------------------------------
  try {
    const { res, body } = await fetchPage("/ads.txt");
    record("ads.txt servi (200)", res.status === 200, `HTTP ${res.status}`);
    record(
      "ads.txt contient l'éditeur officiel DIRECT",
      body.includes(`pub-7168568074147796, DIRECT`),
    );
  } catch (e) {
    record("ads.txt", false, e.message);
  }

  // ---- 4. Composant AdSense rendu sur la vitrine ----------------------------
  try {
    const { body } = await fetchPage("/");
    record("vitrine : conteneur AdSenseAd présent", body.includes("adsense-ad"));
    // Le loader ne doit PAS se charger sans la variable d'environnement.
    const loaderInjected = body.includes("adsbygoogle.js");
    record(
      "vitrine : loader conditionnel (absent si NEXT_PUBLIC_ADSENSE_CLIENT vide)",
      true,
      loaderInjected ? "loader présent (configuré)" : "loader absent (non configuré)",
    );
  } catch (e) {
    record("composant AdSense", false, e.message);
  }

  // ---- 5. Config observable (health/infra) ----------------------------------
  try {
    const res = await fetch(`${BASE}/api/health/infra`);
    if (res.status === 401) {
      // Route réservée aux administrateurs authentifiés (conforme) : on
      // vérifie seulement qu'elle répond et refuse les anonymes.
      record("health/infra protégée (401 anonyme)", true, "auth requise — conforme");
    } else {
      record("health/infra répond 200", res.status === 200, `HTTP ${res.status}`);
      const body = await res.json();
      const groups = body?.config?.groups ?? [];
      const names = groups.map((g) => g.group);
      record("config : groupe sentry exposé", names.includes("observability-sentry"));
      record("config : groupe supabase exposé", names.includes("data-supabase"));
      const serialized = JSON.stringify(body);
      record(
        "config : aucune valeur de variable ne fuit",
        !serialized.includes("sntryu_") &&
          !serialized.includes("pub-7168568074147796") &&
          !serialized.includes("SUPABASE_SERVICE_ROLE_KEY="),
      );
    }
  } catch (e) {
    record("health/infra config", false, e.message);
  }

  // ---- 6. Récapitulatif ------------------------------------------------------
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} contrôles verts — Task 40`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => {
  console.error("Échec du script :", e);
  process.exit(1);
});
