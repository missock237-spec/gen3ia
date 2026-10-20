#!/usr/bin/env node
/**
 * Diagnostic de la configuration Chariow de la grille tarifaire Gen3ia.
 *
 * Vérifie, avec la clé API fournie par l'environnement (CHARIOW_API_KEY) :
 *  1. validité de la clé + boutique accessible ;
 *  2. produits Chariow existants et leur statut (draft/published) ;
 *  3. mappage offres Gen3ia → produits (variables CHARIOW_PLAN_*_PRODUCT_ID) ;
 *  4. webhooks Pulse configurés sur la boutique (activation automatique).
 *
 * Usage : CHARIOW_API_KEY=sk_… node scripts/chariow_plans_status.mjs
 * Aucun secret n'est imprimé : la clé est lue depuis l'environnement.
 */

const BASE_URL = (process.env.CHARIOW_API_BASE_URL ?? "https://api.chariow.com/v1").replace(/\/+$/, "");

const PLAN_ENVS = [
  { plan: "pro", env: "CHARIOW_PLAN_PRO_PRODUCT_ID", fallback: "prd_svqonju7", tarif: "15 € / mois (9 750 FCFA)" },
  { plan: "entreprise", env: "CHARIOW_PLAN_ENTREPRISE_PRODUCT_ID", fallback: "prd_v76f5kjl", tarif: "≈ 495 € / mois (325 000 FCFA)" },
  { plan: "modele-sur-mesure", env: "CHARIOW_PLAN_SUR_MESURE_PRODUCT_ID", fallback: "prd_646qpmge", tarif: "≈ 1 517 € / modèle (995 000 FCFA)" },
];

const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", RESET = "\x1b[0m";
const ok = (msg) => console.log(`${GREEN}✔${RESET} ${msg}`);
const warn = (msg) => console.log(`${YELLOW}▲${RESET} ${msg}`);
const fail = (msg) => console.log(`${RED}✘${RESET} ${msg}`);

async function chariowGet(path) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${process.env.CHARIOW_API_KEY}`, Accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

async function main() {
  const apiKey = process.env.CHARIOW_API_KEY?.trim();
  if (!apiKey) {
    fail("CHARIOW_API_KEY absent de l'environnement.");
    process.exit(1);
  }

  console.log("=== Boutique Chariow ===");
  const store = await chariowGet("/store");
  if (store.status !== 200) {
    fail(`Clé API invalide ou boutique inaccessible (HTTP ${store.status}).`);
    process.exit(1);
  }
  const storeData = store.payload?.data ?? {};
  ok(`Boutique « ${storeData.name} » (${storeData.id})`);
  console.log(`  URL publique : ${storeData.url}`);
  console.log(`  Statut : ${storeData.status}`);

  console.log("\n=== Produits Chariow ===");
  const products = await chariowGet("/products?per_page=50");
  const list = products.payload?.data ?? [];
  if (list.length === 0) warn("Aucun produit dans la boutique.");
  const productByEnv = new Map();
  for (const product of list) {
    const price = product.pricing?.current_price ?? {};
    ok(`${product.id} — « ${product.name} » : ${price.formatted ?? "?"} [${product.type}] ${product.status === "published" ? "publié" : `statut=${product.status}`}`);
    productByEnv.set(product.id, product);
  }

  console.log("\n=== Mappage des offres Gen3ia ===");
  for (const { plan, env, fallback, tarif } of PLAN_ENVS) {
    const configured = process.env[env]?.trim() || fallback;
    if (!configured) {
      warn(`${plan} (${tarif}) : produit non configuré — l'offre est masquée côté paiement.`);
      console.log(`  → Créer le produit « license » dans le dashboard Chariow puis définir ${env}=prd_…`);
      continue;
    }
    const product = productByEnv.get(configured);
    if (!product) {
      fail(`${plan} (${tarif}) : ${configured} introuvable dans la boutique.`);
      continue;
    }
    if (product.status !== "published") {
      warn(`${plan} (${tarif}) : produit ${configured} en statut « ${product.status} » — le publier dans le dashboard pour l'ouvrir au paiement.`);
      continue;
    }
    ok(`${plan} (${tarif}) : prêt via ${configured}`);
  }

  console.log("\n=== Webhooks Pulse (activation automatique des abonnements) ===");
  const pulses = await chariowGet("/pulses");
  const pulsesData = pulses.payload?.data ?? [];
  if (pulsesData.length === 0) {
    warn("Aucun webhook Pulse configuré sur la boutique.");
    console.log(`  → Dashboard Chariow → Développeur → Pulse : créer un webhook vers`);
    console.log(`    https://<votre-domaine>/api/webhooks/chariow  (événement successful.sale)`);
    console.log(`    puis reporter le secret de signature dans CHARIOW_PULSE_SECRET (VPS).`);
  } else {
    for (const pulse of pulsesData) {
      ok(`Pulse ${pulse.id ?? "?"} — ${pulse.url ?? pulse.target_url ?? "?"}`);
    }
  }

  console.log("\n=== Conclusion ===");
  console.log("Chaque visite de paiement créée par la plateforme est taguée");
  console.log("gen3ia_product=plan_subscription + plan_id + user_id et redirige vers /billing :");
  console.log("Chariow sait que la session provient de Gen3ia et le webhook active l'offre.");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
