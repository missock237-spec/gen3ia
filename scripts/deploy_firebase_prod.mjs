#!/usr/bin/env node
/**
 * Déploiement Firebase en production (projet `gen3ia`) via l'API REST Google :
 *  - 1. Liste les bases Firestore du projet (diagnostic).
 *  - 2. Compile le ruleset depuis firestore.rules et le publie sur CHAQUE base
 *       (release `firestore/<database_id>`), comme `firebase deploy --only firestore:rules`
 *       mais sans CLI login (jeton OAuth2 court dérivé du service account).
 *  - 3. Synchronise les index composites (firestore.indexes.json) sur la base cible.
 * Usage : node scripts/deploy_firebase_prod.mjs [--rules-only] [--indexes-only] [--check]
 * Env : GOOGLE_APPLICATION_CREDENTIALS ou .fb_deploy_key.json à la racine.
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

// google-auth-library (dépendance transitive de firebase-admin) : JWT RS256
// battle-tested — le JWT manuel échoue sur des subtilités d'encodage.
const require = createRequire(import.meta.url);
const { JWT } = require("google-auth-library");

const ROOT = new URL("..", import.meta.url).pathname;
const KEY_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ?? `${ROOT}/.fb_deploy_key.json`;

if (!existsSync(KEY_PATH)) {
  console.error(`Service account introuvable : ${KEY_PATH}`);
  process.exit(2);
}
const svc = JSON.parse(readFileSync(KEY_PATH, "utf8"));
const PROJECT = svc.project_id;
console.log(`Projet Firebase : ${PROJECT}`);

// ── OAuth2 : service account → access token (1 h) ──────────────────────────
const SCOPE =
  "https://www.googleapis.com/auth/cloud-platform " +
  "https://www.googleapis.com/auth/firebase " +
  "https://www.googleapis.com/auth/datastore";
const authClient = new JWT({
  email: svc.client_email,
  key: svc.private_key,
  scopes: SCOPE.split(" "),
});
let ACCESS;
try {
  const tokens = await authClient.authorize();
  ACCESS = tokens.access_token;
} catch (e) {
  console.error("Échec OAuth2 :", e.response?.status, JSON.stringify(e.response?.data ?? e.message).slice(0, 300));
  process.exit(2);
}
if (!ACCESS) {
  console.error("Échec OAuth2 : aucun access token reçu");
  process.exit(2);
}
const AUTH = { Authorization: `Bearer ${ACCESS}` };
const api = async (url, init = {}) => {
  const res = await fetch(url, { ...init, headers: { ...AUTH, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    throw new Error(`API ${res.status} sur ${url}\n${typeof body === "string" ? body : JSON.stringify(body).slice(0, 800)}`);
  }
  return body;
};

// ── 1. Diagnostic : bases du projet ─────────────────────────────────────────
const dbs = await api(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases`);
console.log("Bases Firestore :");
for (const db of dbs.databases ?? []) {
  console.log(`  - ${db.name.split("/databases/")[1]} (type=${db.type})`);
}
const databaseIds = (dbs.databases ?? []).map((d) => d.name.split("/databases/")[1]);
if (databaseIds.length === 0) throw new Error("Aucune base Firestore trouvée");

const args = process.argv.slice(2);
const DO_RULES = !args.includes("--indexes-only");
const DO_INDEXES = !args.includes("--rules-only");
const CHECK_ONLY = args.includes("--check");
if (CHECK_ONLY) process.exit(0);

// ── 2. Rules : un ruleset partagé, publié sur chaque base ──────────────────
if (DO_RULES) {
  const content = readFileSync(`${ROOT}/firestore.rules`, "utf8");
  const ruleset = await api(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/rulesets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: { files: [{ name: "firestore.rules", content }] },
    }),
  });
  console.log(`Ruleset créé : ${ruleset.name}`);
  // Le nom de release Firestore est « cloud.firestore/<base> » ; on le prend
  // TEL QUEL dans la réponse du list (la reconstruction manuelle donne des 400).
  const releases = await api(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases?pageSize=100`);
  const known = new Map((releases.releases ?? []).map((r) => [r.name.split("/releases/")[1], r.name]));
  for (const dbId of databaseIds) {
    const releaseId = `cloud.firestore/${dbId}`;
    const existingName = known.get(releaseId);
    if (existingName) {
      // PATCH exige l'ID encodé dans l'URL ET le nom complet de la ressource
      // dans le corps (sinon 400 INVALID_ARGUMENT).
      await api(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases/${encodeURIComponent(releaseId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          release: { name: `projects/${PROJECT}/releases/${releaseId}`, rulesetName: ruleset.name },
        }),
      });
    } else {
      await api(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: releaseId, rulesetName: ruleset.name }),
      });
    }
    console.log(`Règles publiées sur la base « ${dbId} » ✔`);
  }
}

// ── 3. Indexes : synchroniser firestore.indexes.json sur la base applicative
if (DO_INDEXES) {
  const desired = JSON.parse(readFileSync(`${ROOT}/firestore.indexes.json`, "utf8"));
  const appDb = process.env.FIREBASE_FIRESTORE_DATABASE_ID ?? "gen3ia";
  if (!databaseIds.includes(appDb)) {
    console.log(`Base applicative « ${appDb} » absente du projet — index ignorés`);
  } else {
    const base = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${appDb}/collectionGroups`;
    // Index existants (le champ "name" est renvoyé par l'API serveur)
    const existing = new Set();
    for (const idx of desired.indexes ?? []) {
      const col = idx.collectionGroup;
      const list = await api(`${base}/${col}/indexes?pageSize=100`).catch(() => ({ indexes: [] }));
      for (const cur of list.indexes ?? []) {
        existing.add(JSON.stringify({
          collectionGroup: col,
          queryScope: cur.queryScope ?? "COLLECTION",
          fields: (cur.fields ?? []).map((f) => ({ fieldPath: f.fieldPath, order: f.order, arrayConfig: f.arrayConfig })),
        }));
      }
    }
    let created = 0, present = 0;
    for (const idx of desired.indexes ?? []) {
      const spec = {
        queryScope: idx.queryScope ?? "COLLECTION",
        fields: idx.fields.map((f) => ({
          fieldPath: f.fieldPath,
          ...(f.order ? { order: f.order } : {}),
          ...(f.arrayConfig ? { arrayConfig: f.arrayConfig } : {}),
        })),
      };
      const key = JSON.stringify({ collectionGroup: idx.collectionGroup, queryScope: spec.queryScope, fields: spec.fields });
      if (existing.has(key)) { present++; continue; }
      await api(`${base}/${idx.collectionGroup}/indexes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(spec),
      });
      created++;
      console.log(`Index créé : ${idx.collectionGroup} (${idx.fields.map((f) => f.fieldPath).join(",")})`);
    }
    console.log(`Index : ${created} créés, ${present} déjà présents, ${desired.indexes?.length ?? 0} déclarés.`);
  }
}

console.log("Déploiement Firebase production terminé ✔");
