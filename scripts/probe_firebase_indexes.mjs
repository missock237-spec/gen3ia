#!/usr/bin/env node
/**
 * Sonde d'index Firestore : pour chaque index composite déclaré dans
 * firestore.indexes.json, exécute la requête composée exacte via runQuery.
 *  - succès → l'index existe en production
 *  - FAILED_PRECONDITION → index manquant + lien de création
 * Nécessite uniquement datastore.user (aucune écriture, aucune donnée lue :
 * les filtres visent des userId inexistants).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { JWT } = require("google-auth-library");

const ROOT = new URL("..", import.meta.url).pathname;
const svc = JSON.parse(readFileSync(`${ROOT}/.fb_deploy_key.json`, "utf8"));
const PROJECT = svc.project_id;
const DB_ID = process.env.FIREBASE_FIRESTORE_DATABASE_ID ?? "gen3ia";
const PROBE_USER = "probe-index-check-000000000000000000000000";

const authClient = new JWT({
  email: svc.client_email,
  key: svc.private_key,
  scopes: ["https://www.googleapis.com/auth/datastore"],
});
const { access_token: ACCESS } = await authClient.authorize();

const desired = JSON.parse(readFileSync(`${ROOT}/firestore.indexes.json`, "utf8"));
const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DB_ID}/documents:runQuery`;

let ok = 0, missing = 0;
for (const idx of desired.indexes ?? []) {
  // Construit la requête composée exacte : égalités + orderBy du dernier champ
  const equality = idx.fields.filter((f) => f.order === undefined && f.arrayConfig === undefined);
  const ordered = idx.fields.filter((f) => f.order !== undefined || f.arrayConfig !== undefined);
  // Heuristique de sonde : chaque champ d'égalité filtre sur une valeur inexistante
  // (userId/orgId/conversationId = valeur sentinelle), les champs ordonnés deviennent orderBy.
  const whereFields = equality.length > 0 ? equality : [];
  const orderByFields = ordered.length > 0 ? ordered : equality.slice(-1);
  const structuredQuery = {
    from: [{ collectionId: idx.collectionGroup }],
    where: whereFields.length
      ? {
          compositeFilter: {
            op: "AND",
            filters: whereFields.map((f) => ({
              fieldFilter: {
                field: { fieldPath: f.fieldPath },
                op: "EQUAL",
                value: { stringValue: PROBE_USER },
              },
            })),
          },
        }
      : undefined,
    orderBy: orderByFields.map((f) => ({
      field: { fieldPath: f.fieldPath },
      direction: f.order === "DESCENDING" ? "DESCENDING" : "ASCENDING",
    })),
    limit: 1,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
  });
  const bodyText = await res.text();
  const isIndexError = bodyText.includes("FAILED_PRECONDITION") || bodyText.includes("The query requires an index");
  const label = `${idx.collectionGroup}(${idx.fields.map((f) => `${f.fieldPath}:${f.order ?? f.arrayConfig ?? "="}`).join(",")})`;
  if (res.ok && !isIndexError) {
    ok++;
    console.log(`✔ PRÉSENT   ${label}`);
  } else {
    missing++;
    console.log(`✘ MANQUANT  ${label}`);
    if (bodyText.includes("index")) {
      const match = bodyText.match(/https:\/\/console\.firebase\.google\.com[^\s"\\]+/);
      if (match) console.log(`   → création : ${match[0].replace(/\\u0026/g, "&")}`);
    }
    if (!res.ok && !isIndexError) console.log("   erreur inattendue :", res.status, bodyText.slice(0, 200));
  }
}
console.log(`\nBilan : ${ok} présents, ${missing} manquants sur ${(desired.indexes ?? []).length} déclarés`);
process.exit(missing > 0 ? 1 : 0);
