#!/usr/bin/env node
/** Sauvegarde des règles Firestore actuellement déployées (rollback de sécurité). */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { JWT } = require("google-auth-library");

const ROOT = new URL("..", import.meta.url).pathname;
const svc = JSON.parse(readFileSync(`${ROOT}/.fb_deploy_key.json`, "utf8"));
const PROJECT = svc.project_id;
const DB_ID = process.env.FIREBASE_FIRESTORE_DATABASE_ID ?? "gen3ia";

const authClient = new JWT({
  email: svc.client_email,
  key: svc.private_key,
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});
const { access_token: ACCESS } = await authClient.authorize();
const api = async (url) => {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${ACCESS}` } });
  const body = await res.text();
  if (!res.ok) throw new Error(`API ${res.status}: ${body.slice(0, 400)}`);
  return JSON.parse(body);
};

// Lister les releases et trouver celle de la base cible (nom pris TEL QUEL
// dans la réponse — la reconstruction manuelle du path donne des 400).
const expected = `cloud.firestore/${DB_ID}`;
const releases = await api(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases?pageSize=100`);
const release = (releases.releases ?? []).find((r) => r.name.split("/releases/")[1] === expected);
if (!release) {
  console.log(`Aucune release « ${expected} » — le déploiement en créera une.`);
  process.exit(0);
}
console.log("Release actuelle →", release.rulesetName);
const ruleset = await api(`https://firebaserules.googleapis.com/v1/${release.rulesetName}`);
const content = (ruleset.source?.files ?? []).map((f) => f.content).join("\n\n");
writeFileSync(`${ROOT}/.rules_backup_before_deploy.rules`, content ?? "");
console.log(`Règles actuelles sauvegardées (${content?.length ?? 0} octets) → .rules_backup_before_deploy.rules`);
