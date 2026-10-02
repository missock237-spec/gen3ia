#!/usr/bin/env node
/**
 * Enregistre la PLANIFICATION QStash qui déclenche le dispatcher d'agents
 * toutes les 5 minutes (Task 62 — priorité #5, file d'attente managée).
 *
 * PROBLÈME RÉSOLU : la route /api/cron/agent-schedules est conçue pour une
 * cadence 5 minutes (claims transactionnels par slot de 5 min, veille RSS,
 * renouvellements mensuels), mais Vercel (plan actuel) ne permet qu'un cron
 * QUOTIDIEN (vercel.json `0 6 * * *`) — les agents planifiés ne s'exécutaient
 * donc qu'une fois par jour à 06:00 UTC au lieu de leur fenêtre réelle.
 * QStash Schedules (déjà notre file managée pour les missions longues)
 * apporte la cadence 5 minutes sans dépendre du plan Vercel.
 *
 * Le dispatcher est IDEMPOTENT par slot (claims transactionnels Firestore) :
 * les doubles déclenchements (QStash 5 min + cron Vercel quotidien conservé
 * en filet de secours) ne peuvent jamais exécuter deux fois le même slot.
 *
 * Usage : QSTASH_TOKEN=… CRON_SECRET=… node scripts/setup_qstash_schedule.mjs
 * Idempotent : un schedule existant pointant sur la même destination est
 * détecté et laissé en place.
 */
import { readFileSync } from "node:fs";

const PROD_URL = process.env.GEN3IA_APP_ORIGIN?.trim() || "https://gen3ia.online";
const SCHEDULE_CRON = "*/5 * * * *";
const DESTINATION = `${PROD_URL}/api/cron/agent-schedules`;

/**
 * Base API QStash : ce compte utilise l'instance RÉGIONALE
 * (QSTASH_URL = https://qstash-eu-central-1.upstash.io) — l'endpoint global
 * qstash.upstash.io rejette toute création (destination « invalid scheme »
 * parce que le token n'y est pas reconnu). Défaut : global (comptes standards).
 */
const QSTASH_BASE = (process.env.QSTASH_URL?.trim() || "https://qstash.upstash.io").replace(/\/$/, "");

function readEnvValue(name) {
  const fromProcess = process.env[name]?.trim();
  if (fromProcess) return fromProcess;
  try {
    // Fallback : fichier .env.local (jamais committé).
    const lines = readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n");
    for (const line of lines) {
      const match = line.match(/^${name}=(.*)$/);
      if (match) return match[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // pas de .env.local — tant pis.
  }
  return undefined;
}

const token = readEnvValue("QSTASH_TOKEN");
const cronSecret = readEnvValue("CRON_SECRET");

if (!token || !cronSecret) {
  console.error("✖ QSTASH_TOKEN et CRON_SECRET requis (env ou .env.local).");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

// 1) Lister les schedules existants (idempotence).
const listResponse = await fetch(`${QSTASH_BASE}/v2/schedules`, { headers });
if (!listResponse.ok) {
  console.error(`✖ Lecture des schedules impossible : HTTP ${listResponse.status}`, await listResponse.text());
  process.exit(1);
}
const existing = await listResponse.json();
const schedules = Array.isArray(existing) ? existing : existing.schedules ?? [];
const already = schedules.find((s) => (s.destination ?? "").includes("agent-schedules") || (s.url ?? "").includes("agent-schedules"));

if (already) {
  console.log(`✔ Schedule déjà présent : ${already.scheduleId ?? already.id} (cron ${already.cron}) — rien à faire.`);
  process.exit(0);
}

// 2) Créer le schedule 5 minutes avec le secret cron transmis en en-tête.
const createResponse = await fetch(`${QSTASH_BASE}/v2/schedules`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    destination: DESTINATION,
    cron: SCHEDULE_CRON,
    retries: 1,
    headers: {
      Authorization: `Bearer ${cronSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ source: "qstash-schedule" }),
  }),
});

const text = await createResponse.text();
if (!createResponse.ok) {
  console.error(`✖ Création du schedule impossible : HTTP ${createResponse.status}`, text);
  process.exit(1);
}

console.log(`✔ Schedule créé : ${text} — ${SCHEDULE_CRON} → ${DESTINATION}`);

// 3) Vérification : relecture.
const verify = await fetch(`${QSTASH_BASE}/v2/schedules`, { headers });
const after = await verify.json();
const afterList = Array.isArray(after) ? after : after.schedules ?? [];
const found = afterList.find((s) => (s.destination ?? s.url ?? "").includes("agent-schedules"));
if (found) {
  console.log(`✔ Vérifié : schedule ${found.scheduleId ?? found.id} actif (cron ${found.cron}).`);
} else {
  console.error("⚠ Schedule non retrouvé à la relecture — inspecter la console Upstash.");
  process.exit(1);
}
