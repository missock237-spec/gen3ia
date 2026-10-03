#!/usr/bin/env node
/** Liste les releases + rulesets de règles du projet (diagnostic). */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { JWT } = require("google-auth-library");

const ROOT = new URL("..", import.meta.url).pathname;
const svc = JSON.parse(readFileSync(`${ROOT}/.fb_deploy_key.json`, "utf8"));
const PROJECT = svc.project_id;

const authClient = new JWT({
  email: svc.client_email,
  key: svc.private_key,
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});
const { access_token: ACCESS } = await authClient.authorize();
const api = async (url) => {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${ACCESS}` } });
  const body = await res.text();
  if (!res.ok) throw new Error(`API ${res.status}: ${body.slice(0, 500)}`);
  return JSON.parse(body);
};

const releases = await api(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases?pageSize=100`);
console.log("RELEASES :");
for (const r of releases.releases ?? []) {
  console.log("  ", r.name.split("/releases/")[1], "→", r.rulesetName);
}
const rulesets = await api(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/rulesets?pageSize=100`);
console.log("RULESETS :", (rulesets.rulesets ?? []).length);
for (const rs of (rulesets.rulesets ?? []).slice(-5)) {
  const f = rs.source?.files?.[0];
  console.log("  ", rs.name.split("/rulesets/")[1], "fichier:", f?.name, `${f?.content?.length ?? 0} octets`, "créé:", rs.createTime);
}
