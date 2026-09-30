#!/usr/bin/env node
/**
 * Vérification PRODUCTION Task 47 — Étape 8 : édition d'images réelle
 * (image-to-image Agnes) pour les images importées OU générées.
 *
 * Contrôles (gen3ia.online) :
 *  1. Disponibilité : / 200, /api/health 200.
 *  2. POST /api/ai/image sans session → 401 structuré (contrat inchangé).
 *  3. Import anonyme → 401 (le binaire des images ne devient jamais public).
 *  4. Déploiement vivant : x-vercel-id présent.
 *
 * Usage : node scripts/verify_task47_step8_edit_prod.mjs
 */
const BASE = process.env.BASE_URL || "https://gen3ia.online";

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function jsonProbe(path, init) {
  const response = await fetch(`${BASE}${path}`, init);
  let body = null;
  try { body = await response.json(); } catch { /* HTML */ }
  return { response, body };
}

async function main() {
  const home = await fetch(`${BASE}/`, { redirect: "follow" });
  record("Vitrine / joignable", home.status === 200, `status ${home.status}`);

  const health = await fetch(`${BASE}/api/health`);
  record("Sonde /api/health", health.status === 200, `status ${health.status}`);

  const image = await jsonProbe("/api/ai/image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Sonde anonyme étape 8", images: ["data:image/png;base64,iVBORw0KGgo="] }),
  });
  record(
    "POST /api/ai/image (édition) anonyme → 401 structuré",
    image.response.status === 401 && image.body && typeof image.body.error === "string",
    `status ${image.response.status}, error=${image.body?.error ?? "(absent)"}`,
  );

  const imported = await fetch(`${BASE}/api/files/import`, { method: "POST" });
  record("POST /api/files/import anonyme → refus auth", [401, 403].includes(imported.status), `status ${imported.status}`);

  const vercelId = home.headers.get("x-vercel-id");
  record("Réponse portée par Vercel (build vivant)", Boolean(vercelId), `x-vercel-id=${vercelId ?? "(absent)"}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "🟢 SUCCÈS" : "🔴 ÉCHEC"} — ${results.length - failed.length}/${results.length} sondes vertes`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("❌ Sonde interrompue :", error?.message ?? error);
  process.exit(1);
});
