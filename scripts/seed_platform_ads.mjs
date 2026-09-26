#!/usr/bin/env node
/**
 * Seed de l'inventaire publicitaire Gen3ia (Firestore `platformAds`).
 *
 * Insère les annonces « house » de la plateforme sur le placement `settings`
 * afin que chaque utilisateur voie de vraies campagnes dans
 * Paramètres › Publicité (galerie) et dans l'espace publicitaire des
 * paramètres. Les annonces existantes (même id) sont mises à jour.
 *
 * Prérequis : .env.seed généré via `vercel env pull` (FIREBASE_* admin).
 * Usage : node scripts/seed_platform_ads.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?(.*?)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = { ...loadEnvFile(".env.seed"), ...process.env };
const projectId = env.FIREBASE_PROJECT_ID;
const clientEmail = env.FIREBASE_CLIENT_EMAIL;
let privateKey = env.FIREBASE_PRIVATE_KEY ?? "";
if (privateKey.includes("\\n")) privateKey = privateKey.replaceAll("\\n", "\n");

if (!projectId || !clientEmail || !privateKey) {
  console.error("FATAL : credentials Firebase admin absents (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY).");
  process.exit(1);
}

if (!getApps().length) {
  initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
}
// Base Firestore NOMMÉE (comme lib/firebase/admin.ts : getFirestore(app, databaseId)).
const databaseId = (env.FIREBASE_FIRESTORE_DATABASE_ID || "gen3ia").trim();
const db = getFirestore(undefined, databaseId);

const BASE = "https://gen3ia.online";
const now = Date.now();

const HOUSE_ADS = [
  {
    placement: "settings",
    format: "link",
    title: "La Marketplace Gen3ia",
    advertiser: "Gen3ia",
    description: "Agents prêts à l'emploi, extensions et compétences créées par la communauté. Installez en un clic et étendez ce que vos agents savent faire.",
    text: "Marketplace Gen3ia",
    targetUrl: `${BASE}/marketplace`,
    ctaLabel: "Explorer la Marketplace",
    enabled: true,
    priority: 50,
  },
  {
    placement: "settings",
    format: "link",
    title: "Agent Live — donnez un vrai poste à vos agents",
    advertiser: "Gen3ia",
    description: "Vos agents pilotent un environnement de travail réel : navigateur, fichiers, applications. Vous gardez le contrôle de chaque action.",
    text: "Agent Live",
    targetUrl: `${BASE}/live`,
    ctaLabel: "Découvrir Agent Live",
    enabled: true,
    priority: 40,
  },
  {
    placement: "settings",
    format: "link",
    title: "Wallet intégré — ne payez que ce que vos agents exécutent",
    advertiser: "Gen3ia",
    description: "Créditez votre wallet, suivez chaque consommation à l'euro près et rechargez en quelques secondes. Aucun abonnement caché.",
    text: "Facturation & Wallet",
    targetUrl: `${BASE}/billing`,
    ctaLabel: "Voir mon wallet",
    enabled: true,
    priority: 30,
  },
];

let upserts = 0;
for (const ad of HOUSE_ADS) {
  const query = await db.collection("platformAds")
    .where("placement", "==", ad.placement)
    .where("title", "==", ad.title)
    .limit(1)
    .get();
  if (!query.empty) {
    await query.docs[0].ref.update({ ...ad, updatedAtMs: now });
    console.log(`OK  update : « ${ad.title} » (${query.docs[0].id})`);
  } else {
    const ref = db.collection("platformAds").doc();
    await ref.set({ ...ad, createdAtMs: now, updatedAtMs: now });
    console.log(`OK  création : « ${ad.title} » (${ref.id})`);
  }
  upserts += 1;
}

const finalCount = (await db.collection("platformAds").where("placement", "==", "settings").count().get()).data().count;
console.log(`\n✅ ${upserts} annonce(s) maison en place — inventaire « settings » : ${finalCount} annonce(s) active(s) au total.`);
