#!/usr/bin/env node
/**
 * Configuration des variables d'environnement Vercel pour Bland AI.
 *
 * Utilisation (depuis la racine du projet) :
 *
 *   VERCEL_TOKEN=xxxx PROJECT_NAME=gen3ia node scripts/vercel-env-bland.mjs
 *
 * Prérequis :
 *   - VERCEL_TOKEN : un token Vercel avec le scope suffisant
 *     (https://vercel.com/account/tokens) ;
 *   - PROJECT_NAME : le nom du projet Vercel (défaut : gen3ia).
 *
 * Le script crée (ou met à jour) les variables suivantes pour les
 * environnements production / preview / development :
 *   - BLAND_API_KEY            (requis — la valeur peut venir de l'env local
 *                               ou du fichier .env.local) ;
 *   - BLAND_WEBHOOK_BASE_URL   (optionnel — URL publique de l'app) ;
 *   - BLAND_WEBHOOK_SECRET     (optionnel — signature des webhooks entrants) ;
 *   - GEN3IA_MAX_DAILY_VOICE_CALLS (optionnel) ;
 *   - GEN3IA_VOICE_CALL_MIN_BALANCE_MINOR (optionnel).
 *
 * Équivalent manuel (CLI Vercel) :
 *   vercel env add BLAND_API_KEY production
 *   # ou via le dashboard : Settings > Environment Variables.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const VERCEL_API = "https://api.vercel.com";
const ENVIRONMENTS = ["production", "preview", "development"];

const token = process.env.VERCEL_TOKEN?.trim();
const projectName = process.env.PROJECT_NAME?.trim() || "gen3ia";

if (!token) {
  console.error("ERREUR : définissez VERCEL_TOKEN (https://vercel.com/account/tokens).");
  process.exit(1);
}

/** Lit la valeur d'une clé dans .env.local (simple parse KEY=VALUE). */
function readLocalEnv(key) {
  const file = path.join(process.cwd(), ".env.local");
  if (!existsSync(file)) return undefined;
  const match = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((line) => line.startsWith(`${key}=`));
  return match ? match.slice(key.length + 1).trim() : undefined;
}

async function vercelFetch(pathname, init) {
  const response = await fetch(`${VERCEL_API}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Vercel ${pathname} → HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`);
  }
  return payload;
}

async function main() {
  // 1. Résolution du projet.
  const projects = await vercelFetch(`/v9/projects?limit=100`);
  const project = projects.projects?.find((p) => p.name === projectName);
  if (!project) {
    console.error(`ERREUR : projet Vercel « ${projectName} » introuvable (vérifiez PROJECT_NAME).`);
    process.exit(1);
  }

  const variables = [
    { key: "BLAND_API_KEY", value: process.env.BLAND_API_KEY?.trim() || readLocalEnv("BLAND_API_KEY"), required: true },
    { key: "BLAND_WEBHOOK_BASE_URL", value: process.env.BLAND_WEBHOOK_BASE_URL?.trim() || readLocalEnv("BLAND_WEBHOOK_BASE_URL") },
    { key: "BLAND_WEBHOOK_SECRET", value: process.env.BLAND_WEBHOOK_SECRET?.trim() || readLocalEnv("BLAND_WEBHOOK_SECRET") },
    { key: "GEN3IA_MAX_DAILY_VOICE_CALLS", value: process.env.GEN3IA_MAX_DAILY_VOICE_CALLS?.trim() || readLocalEnv("GEN3IA_MAX_DAILY_VOICE_CALLS") },
    { key: "GEN3IA_VOICE_CALL_MIN_BALANCE_MINOR", value: process.env.GEN3IA_VOICE_CALL_MIN_BALANCE_MINOR?.trim() || readLocalEnv("GEN3IA_VOICE_CALL_MIN_BALANCE_MINOR") },
  ].filter((v) => v.value);

  const missing = variables.filter((v) => v.required && !v.value);
  if (missing.length > 0) {
    console.error(`ERREUR : ${missing.map((v) => v.key).join(", ")} manquant(s) — ni env d'exécution ni .env.local.`);
    process.exit(1);
  }

  // 2. Variables existantes (pour upsert propre).
  const existing = await vercelFetch(`/v9/projects/${project.id}/env?limit=100`);
  const byKey = new Map((existing.envs ?? []).map((v) => [v.key, v]));

  for (const variable of variables) {
    const current = byKey.get(variable.key);
    if (current) {
      await vercelFetch(`/v10/projects/${project.id}/env/${current.id}`, {
        method: "PATCH",
        body: JSON.stringify({ value: variable.value, target: ENVIRONMENTS }),
      });
      console.log(`✓ mise à jour : ${variable.key}`);
    } else {
      await vercelFetch(`/v10/projects/${project.id}/env`, {
        method: "POST",
        body: JSON.stringify({ key: variable.key, value: variable.value, target: ENVIRONMENTS, type: "encrypted" }),
      });
      console.log(`✓ créée : ${variable.key}`);
    }
  }

  console.log(`\nTerminé pour le projet « ${projectName} » (${ENVIRONMENTS.join(", ")}).`);
  console.log("Pensez à REDÉPLOYER pour que les nouvelles variables soient prises en compte.");
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
