#!/usr/bin/env node
/** Vérification : la release production pointe sur un ruleset IDENTIQUE au repo. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { JWT } = require("google-auth-library");

const ROOT = new URL("..", import.meta.url).pathname;
const svc = JSON.parse(readFileSync(`${ROOT}/.fb_deploy_key.json`, "utf8"));
const PROJECT = svc.project_id;
const DB_ID = "gen3ia";

const authClient = new JWT({
  email: svc.client_email,
  key: svc.private_key,
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});
const { access_token: ACCESS } = await authClient.authorize();
const api = async (url) => {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${ACCESS}` } });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
};

const releases = await api(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases?pageSize=100`);
const release = (releases.releases ?? []).find((r) => r.name.split("/releases/")[1] === `cloud.firestore/${DB_ID}`);
console.log("Release :", release.name.split("/releases/")[1], "→", release.rulesetName.split("/rulesets/")[1], "maj:", release.updateTime);
const ruleset = await api(`https://firebaserules.googleapis.com/v1/${release.rulesetName}`);
const deployed = (ruleset.source?.files ?? []).map((f) => f.content).join("\n");
const repo = readFileSync(`${ROOT}/firestore.rules`, "utf8");
const normalize = (s) => s.replace(/\r\n/g, "\n").trim();
if (normalize(deployed) === normalize(repo)) {
  console.log("✔ Le ruleset déployé est IDENTIQUE à firestore.rules du repo");
} else {
  console.log("✘ DIFFÉRENCE entre le ruleset déployé et le repo !");
  process.exit(1);
}
