#!/usr/bin/env node
/**
 * OPÉRATEUR DE SAUVEGARDE DONNÉES FIRESTORE — Gen3ia (itération 23, Job 478451).
 *
 * Trois modes :
 *   --status       État non destructif : PITR activé ? backups planifiés ? dernier export ? fraîcheur vs RPO.
 *   --export       Export managed Firestore vers GCS (documents:export, service Google — zéro lecture locale).
 *   --enable-pitr  Active la récupération point-in-time (7 jours, réversible via --disable-pitr).
 *
 * Auth : clé de service `.fb_deploy_key.json` à la racine (MÊME convention que
 * scripts/backup_firebase_rules.mjs, déjà prouvée en exploitation).
 * L'export exige un bucket GCS (env GCS_BACKUP_BUCKET) — destination sous
 * gs://<bucket>/firestore-exports/<horodatage>/ (une préfixe par exécution).
 *
 * Sûreté : AUCUN mode d'écriture sur les données de production (export = lecture).
 * La restauration est volontairement HORS de ce script et passe par le runbook
 * docs/runbooks/sauvegarde-restauration.md (opération sous double contrôle).
 *
 * Exemples :
 *   node scripts/backup_firestore_data.mjs --status
 *   GCS_BACKUP_BUCKET=gen3ia-backups node scripts/backup_firestore_data.mjs --export
 *   node scripts/backup_firestore_data.mjs --enable-pitr
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { JWT } = require("google-auth-library");

const ARGS = new Set(process.argv.slice(2));
const MODE = ARGS.has("--status") ? "status" : ARGS.has("--export") ? "export" : ARGS.has("--enable-pitr") ? "enable-pitr" : ARGS.has("--disable-pitr") ? "disable-pitr" : null;

if (!MODE) {
  console.error("Usage: node scripts/backup_firestore_data.mjs --status | --export | --enable-pitr | --disable-pitr");
  process.exit(2);
}

const KEY_PATH = new URL("../.fb_deploy_key.json", import.meta.url).pathname;
if (!existsSync(KEY_PATH)) {
  console.error(`Clé de service introuvable: ${KEY_PATH} (cf. runbook docs/runbooks/sauvegarde-restauration.md)`);
  process.exit(2);
}
const svc = JSON.parse(readFileSync(KEY_PATH, "utf8"));
const PROJECT = svc.project_id;
const DB_ID = process.env.FIRESTORE_DATABASE_ID ?? "(default)";

const authClient = new JWT({
  email: svc.client_email,
  key: svc.private_key,
  scopes: ["https://www.googleapis.com/auth/datastore", "https://www.googleapis.com/auth/cloud-platform"],
});
const { access_token: ACCESS } = await authClient.authorize();

const api = async (url, init = {}) => {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${ACCESS}`, ...(init.headers ?? {}) },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`API ${res.status}: ${body.slice(0, 500)}`);
  return body ? JSON.parse(body) : {};
};

const DB = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${encodeURIComponent(DB_ID)}`;

/* ------------------------------ --status ------------------------------- */
async function status() {
  const db = await api(DB);
  const pitr = db.pointInTimeRecoveryEnablement ?? "POINT_IN_TIME_RECOVERY_ENABLEMENT_UNSPECIFIED";
  const pitrOk = pitr === "ENABLED";

  // Backups planifiés (Google-managed) et leurs exécutions
  let schedules = [];
  try {
    const s = await api(`${DB}/backupSchedules?pageSize=20`);
    schedules = s.backupSchedules ?? [];
  } catch (e) {
    console.error("note: backupSchedules indisponible:", String(e).slice(0, 160));
  }

  // Dernière opération d'export initiée par ce projet (historique opérations)
  let lastExport = null;
  try {
    const ops = await api(`${DB}/operations?pageSize=50&filter=operationType=EXPORT_DOCUMENTS`);
    const done = (ops.operations ?? []).filter((o) => o.done === true && !o.error);
    done.sort((a, b) => String(b?.metadata?.startTime ?? "").localeCompare(String(a?.metadata?.startTime ?? "")));
    lastExport = done[0] ?? null;
  } catch (e) {
    console.error("note: operations indisponible:", String(e).slice(0, 160));
  }

  const { conformiteBackup } = await import("../lib/db/backup-policy.ts");
  const conf = conformiteBackup(lastExport ? [lastExport] : []);

  console.log("=== STATUT SAUVEGARDE FIRESTORE ===");
  console.log(`projet:           ${PROJECT}`);
  console.log(`base:             ${DB_ID}`);
  console.log(`PITR (7 j):       ${pitrOk ? "ACTIVÉ" : "DÉSACTIVÉ"} (${pitr})`);
  console.log(`schedules:        ${schedules.length} (rétention par schedule)`);
  for (const sc of schedules) {
    console.log(`  - ${sc.name?.split("/").pop()} rétention ${(sc.retention?.split("s")[0] ?? "?") / 86400} j`);
  }
  if (lastExport) {
    const { ageExportHeures } = await import("../lib/db/backup-policy.ts");
    console.log(`dernier export:   ${lastExport.metadata?.startTime ?? "?"} (âge ${ageExportHeures(lastExport).toFixed(1)} h)`);
    console.log(`destination:      ${lastExport.response?.outputUriPrefix ?? "?"}`);
  } else {
    console.log("dernier export:   AUCUN (aucune opération d'export terminée)");
  }
  console.log(`conformité RPO:   ${conf.conforme ? "CONFORME" : "NON CONFORME"} — ${conf.raison}`);
  if (!conf.conforme) process.exitCode = 1;
}

/* ------------------------------ --export ------------------------------- */
async function exportData() {
  const bucket = process.env.GCS_BACKUP_BUCKET;
  if (!bucket) {
    console.error("GCS_BACKUP_BUCKET requis (ex: gs://gen3ia-backups) — cf. runbook.");
    process.exit(2);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputUriPrefix = `${bucket.replace(/\/$/, "")}/firestore-exports/${stamp}`;
  console.log(`export vers ${outputUriPrefix} …`);
  const op = await api(`${DB}/documents:export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ outputUriPrefix }),
  });
  console.log("opération:", op.name);
  if (!op.done) {
    console.log("export en cours — vérifier ensuite avec --status (polling l'API operations).");
    return;
  }
  if (op.error) {
    console.error("ÉCHEC export:", JSON.stringify(op.error).slice(0, 300));
    process.exit(1);
  }
  console.log("destination:", op.response?.outputUriPrefix ?? outputUriPrefix);
}

/* --------------------------- --enable-pitr ----------------------------- */
async function setPitr(enabled) {
  const value = enabled ? "ENABLED" : "DISABLED";
  const res = await api(`${DB}?updateMask=pointInTimeRecoveryEnablement`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pointInTimeRecoveryEnablement: value }),
  });
  console.log(`PITR → ${value} (opération: ${res.name ?? "terminée"})`);
}

if (MODE === "status") await status();
else if (MODE === "export") await exportData();
else if (MODE === "enable-pitr") await setPitr(true);
else if (MODE === "disable-pitr") await setPitr(false);
