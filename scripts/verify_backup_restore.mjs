#!/usr/bin/env node
/**
 * VÉRIFICATION DE SAUVEGARDE — Gen3ia (itération 23, Job 478451).
 *
 * Principes grandes entreprises : « une sauvegarde non vérifiée n'est pas
 * une sauvegarde ». Ce script lit l'état réel (PITR, backups planifiés,
 * derniers exports) et rend un verdict PASS/FAIL par contrôle — conçu pour
 * tourner en tâche planifiée (VPS cron mensuel, cf. runbook) et alerter
 * l'owner par exit code (1 = au moins un contrôle en échec).
 *
 * Modes :
 *   --status   (défaut) verdict complet, sortie lisible
 *   --strict   exit 1 au premier contrôle en échec (pour cron/CI)
 *
 * Lecture seule : n'initie JAMAIS d'export ni de modification.
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = require ?? createRequire(import.meta.url);
const { JWT } = require("google-auth-library");

const STRICT = process.argv.slice(2).includes("--strict");
const KEY_PATH = new URL("../.fb_deploy_key.json", import.meta.url).pathname;

if (!existsSync(KEY_PATH)) {
  console.error("VÉRIFICATION IMPOSSIBLE — clé de service absente (.fb_deploy_key.json). Échec fail-closed.");
  process.exit(1);
}
const svc = JSON.parse(readFileSync(KEY_PATH, "utf8"));
const DB_ID = process.env.FIRESTORE_DATABASE_ID ?? "(default)";

const authClient = new JWT({
  email: svc.client_email,
  key: svc.private_key,
  scopes: ["https://www.googleapis.com/auth/datastore", "https://www.googleapis.com/auth/cloud-platform"],
});
const { access_token: ACCESS } = await authClient.authorize();
const api = async (url) => {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${ACCESS}` } });
  const body = await res.text();
  if (!res.ok) throw new Error(`API ${res.status}: ${body.slice(0, 400)}`);
  return body ? JSON.parse(body) : {};
};
const DB = `https://firestore.googleapis.com/v1/projects/${svc.project_id}/databases/${encodeURIComponent(DB_ID)}`;

const { BACKUP_POLICY, conformiteBackup, COLLECTIONS_CRITIQUES } = await import("../lib/db/backup-policy.ts");

const VERDICTS = [];
const verdict = (contrôle, ok, détail) => {
  VERDICTS.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${contrôle} — ${détail}`);
};

let db = {};
try {
  db = await api(DB);
} catch (e) {
  console.error("API Firestore injoignable:", String(e).slice(0, 200));
  process.exit(1);
}

/* Contrôle 1 — PITR */
const pitrOk = db.pointInTimeRecoveryEnablement === "ENABLED";
verdict("PITR activé (fenêtre 7 jours)", pitrOk, pitrOk ? "récupération point-in-time disponible" : "activer: node scripts/backup_firestore_data.mjs --enable-pitr");

/* Contrôle 2 — schedules de backup Google-managed */
let schedules = [];
try {
  const s = await api(`${DB}/backupSchedules?pageSize=20`);
  schedules = s.backupSchedules ?? [];
} catch { schedules = []; }
verdict("backup planifié Google-managed présent", schedules.length > 0, schedules.length > 0 ? `${schedules.length} schedule(s)` : "créer un schedule hebdomadaire (console Firebase → Firestore → Backup schedules)");

/* Contrôle 3 — fraîcheur du dernier export vs RPO */
let ops = [];
try {
  const o = await api(`${DB}/operations?pageSize=50&filter=operationType=EXPORT_DOCUMENTS`);
  ops = o.operations ?? [];
} catch { ops = []; }
const conf = conformiteBackup(ops);
verdict("dernier export conforme au RPO 24 h", conf.conforme, conf.raison);

/* Contrôle 4 — périmètre documenté cohérent avec le runbook */
const runbookPath = new URL("../docs/runbooks/sauvegarde-restauration.md", import.meta.url).pathname;
let runbookCouvre = false;
if (existsSync(runbookPath)) {
  const runbook = readFileSync(runbookPath, "utf8");
  runbookCouvre = COLLECTIONS_CRITIQUES.every((c) => runbook.includes(String(c)));
}
verdict("runbook couvre toutes les collections critiques", runbookCouvre, runbookCouvre ? `${COLLECTIONS_CRITIQUES.length} collections couvertes` : "collections critiques absentes du runbook — le mettre à jour");

const pass = VERDICTS.filter(Boolean).length;
console.log(`\n=== VERDICT: ${pass}/${VERDICTS.length} contrôles PASS ===`);
if (pass < VERDICTS.length && STRICT) process.exit(1);
if (pass < VERDICTS.length) process.exitCode = 1;
