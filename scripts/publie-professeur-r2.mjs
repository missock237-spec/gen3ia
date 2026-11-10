#!/usr/bin/env node
/**
 * PUBLIE LA CONFIG PROFESSEUR MÉDIA DANS LE BUCKET R2 PRIVÉ (canal pull).
 *
 * Contexte (incidence réelle it.144, 2026-11-10) : le canal SSH du CD est
 * muet (« SSH entrant muet — canal SSH sauté d'office ») et l'étape qui
 * déposait /opt/gen3ia/.z-ai-config sur le VPS n'a JAMAIS réussi depuis la
 * bascule en mode pull — le professeur média (image photoréaliste, voix
 * humaine, vidéo) était donc absent de la production et les utilisateurs
 * recevaient les compositions neuronales abstraites.
 *
 * Canal de livraison SANS secret publié :
 *   · le runner possède .env.production (secret DOTENV_PRODUCTION = copie
 *     exacte du VPS) → il y lit les credentials R2 du bucket PRIVÉ ;
 *   · le runner y dépose la config professeur (secret ZAI_CONFIG_JSON_B64)
 *     sous une clé privée ;
 *   · l'application VPS la lit au runtime (professeur-media, candidat R2).
 * Aucun secret ne transite ni dans la release publique ni dans le dépôt.
 *
 * Idempotent. Non bloquant : sans creds ou sans secret → sort 0 avec un
 * message honnête (le repli neuronal local reste la règle).
 */
import { readFileSync } from "node:fs";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const CLE = "private/professeur-media/z-ai-config.json";

function lireEnvProduction(chemin) {
  const variables = {};
  for (const ligne of readFileSync(chemin, "utf-8").split("\n")) {
    const proprete = ligne.trim();
    if (!proprete || proprete.startsWith("#")) continue;
    const indice = proprete.indexOf("=");
    if (indice <= 0) continue;
    let valeur = proprete.slice(indice + 1).trim();
    // GUILLEMETS DOTENV (incidence réelle run #471) : une valeur écrite
    // R2_ACCOUNT_ID="8d31…" livrait le hostname « "8d31…".r2.cloudflarestorage.com »
    // — getaddrinfo ENOTFOUND, la config professeur n'atteignait jamais R2.
    // L'application (dotenv) strippait déjà ; le script fait pareil désormais.
    if (valeur.length >= 2
        && ((valeur.startsWith('"') && valeur.endsWith('"'))
          || (valeur.startsWith("'") && valeur.endsWith("'")))) {
      valeur = valeur.slice(1, -1).trim();
    }
    variables[proprete.slice(0, indice).trim()] = valeur;
  }
  return variables;
}

async function main() {
  const cheminConfig = process.env.ZAI_CONFIG_FILE ?? "/tmp/zai-config.json";
  let corps;
  try {
    corps = readFileSync(cheminConfig);
  } catch {
    console.log("::warning::config professeur absente du runner (secret ZAI_CONFIG_JSON_B64 vide ?) — non publiée");
    process.exit(0);
  }
  if (corps.length < 32) {
    console.log("::warning::config professeur vide — non publiée (repli neuronal honnête)");
    process.exit(0);
  }
  // validation JSON minimale : baseUrl + apiKey présents
  const parsed = JSON.parse(corps.toString("utf-8"));
  if (typeof parsed.baseUrl !== "string" || typeof parsed.apiKey !== "string" ||
      !parsed.baseUrl || !parsed.apiKey) {
    console.log("::warning::config professeur incomplète (baseUrl/apiKey) — non publiée");
    process.exit(0);
  }

  const variables = lireEnvProduction(".env.production");
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = variables;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    console.log("::warning::credentials R2 absentes du .env.production — config professeur non publiée");
    process.exit(0);
  }

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: CLE,
    Body: corps,
    ContentType: "application/json",
  }));
  console.log(`✓ config professeur publiée dans R2 (clé ${CLE}, ${corps.length} octets) — ` +
    "l'application la lira au runtime (candidat R2 de professeur-media).");
}

main().catch((e) => {
  console.log("::warning::publication R2 échouée (non bloquant) :", e instanceof Error ? e.message : String(e));
  process.exit(0); // jamais bloquant — le repli neuronal reste la règle
});
