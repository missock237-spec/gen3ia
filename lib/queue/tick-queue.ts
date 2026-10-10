import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  deleteObject,
  getObjectWithEtag,
  isR2Configured,
  listObjectsUnderPrefix,
  putObjectConditional,
} from "@/lib/storage/r2";
import { assertSafeDestinationUrl, resolveJobOrigin } from "@/lib/queue/origin";

/**
 * FILE DE TICKS R2 (remplacement intégral de QStash — 2026-10).
 *
 * POURQUOI : la file externe Upstash QStash imposait une limite de 1 000
 * messages/jour sur ce compte. Un seul rendu vidéo long (segments →
 * transitions) l'épuisait : rendu bloqué en plein milieu, narration et
 * livraisons en échec (anomalie A2 du rapport de tests). Le stockage R2 est
 * déjà le socle de données de la plateforme (moteur r2fs — Task 111) : la
 * file de ticks y vit désormais directement, SANS plafond journalier ni
 * service externe.
 *
 * MODÈLE (équivalent sémantique de QStash, at-least-once) :
 *  1. ENQUEUE : un ticket JSON est écrit sous
 *     `queue/tickets/v1/<dueAtMs-16chiffres>-<uuid>.json` via un PUT
 *     conditionnel If-None-Match:* (création atomique — deux enqueue
 *     concurrents ne peuvent pas s'écraser). Le nom de clé encode l'échéance
 *     en tête : l'ordre lexicographique = ordre d'échéance.
 *  2. DÉLIVRANCE IMMÉDIATE : l'enqueueur self-appelle le receiver (POST
 *     signé vers l'origine canonique). Le receiver répond 202 APRÈS
 *     vérification et fait son travail dans after() — l'appelant n'attend
 *     pas le traitement (fenêtre serverless préservée).
 *  3. RATTRAPAGE (pump) : les tickets dus non complétés sont re-délivrés —
 *     opportunistement par les routes de suivi (polling client) et chaque
 *     jour par le cron sentinelle (/api/cron/agent-schedules). Une fonction
 *     tuée en pleine tranche laisse le ticket en place : il sera re-délivré
 *     après expiration du bail (même contrat que la redélivrance QStash).
 *  4. CLAIM : le traitement d'un ticket commence par un compare-and-swap
 *     (If-Match ETag) qui pose un bail — deux délivrances concurrentes du
 *     même ticket ne peuvent pas doubler le travail.
 *
 * SÉCURITÉ (replique du modèle QStash, en interne) : chaque POST de tick est
 * signé HMAC-SHA256 avec une clé DÉRIVÉE du secret R2 (présent sur toutes
 * les instances — aucun passage de configuration à effectuer). La clé
 * dérivée change si et seulement si R2_SECRET_ACCESS_KEY change, des deux
 * côtés simultanément. Vérification en temps constant + fenêtre de
 * fraîcheur ±300 s (anti-replay). Les receivers acceptent AUSSI le bearer
 * CRON_SECRET (Vercel cron / sonde externe autorisée).
 *
 * ORIGINE : uniquement l'origine canonique du serveur (GEN3IA_APP_ORIGIN,
 * allowlist — lib/queue/origin.ts) ; JAMAIS l'origine d'une requête entrante
 * (falsifiable). Aucune destination publiée sans assertSafeDestinationUrl.
 */

const TICKETS_PREFIX = "queue/tickets/v1/";
const DEAD_PREFIX = "queue/dead/v1/";

/** En-tête transportant la signature interne des ticks. */
export const TICK_SIGNATURE_HEADER = "x-gen3a-tick";

/** Fenêtre de fraîcheur de la signature (anti-replay). */
const SIGNATURE_MAX_AGE_SEC = 300;

/** Délai au-delà duquel la délivrance immédiate n'est PAS tentée (le pump s'en charge). */
const IMMEDIATE_DELIVERY_MAX_DELAY_SEC = 5;

/** Bail d'un ticket claimé par un worker (couvre une tranche complète + marge). */
const TICKET_LEASE_MS = 120_000;

/** Tentatives de délivrance avant mise en quarantaine (dead-letter). */
const TICKET_MAX_ATTEMPTS = 5;

/** Âge de purge des tickets (terminés ou abandonnés). */
const TICK_RETENTION_MS = 7 * 24 * 3600_000;

/** Nombre maximal de tickets traités par passage de pump. */
const PUMP_BATCH = 12;

/** Plafond défensif du corps d'un ticket (payloads minimaux { runId } / { jobId }). */
const MAX_TICKET_BYTES = 8_192;

/** Cache par processus de la clé dérivée (le secret R2 est immuable à l'échelle d'un déploiement). */
let cachedTickSecret: string | null = null;

/**
 * Clé de signature des ticks : HMAC-SHA256 dérivé du secret R2 avec un sel
 * fixe (domain separation — la clé ne ressemble jamais au secret lui-même et
 * n'est réutilisée par aucun autre HMAC de la plateforme). Absente de la
 * configuration R2 → null (file non activable : un receiver non vérifiable
 * serait une porte ouverte, même politique que l'ancienne file QStash).
 */
export function tickSignatureKey(): string | null {
  const r2Secret = process.env.R2_SECRET_ACCESS_KEY?.trim();
  if (!r2Secret) return null;
  if (cachedTickSecret === null) {
    cachedTickSecret = createHash("sha256").update(`${r2Secret}:gen3ia-tick-v1`).digest("hex");
  }
  return cachedTickSecret;
}

/** La file de ticks est-elle activable dans cet environnement ? */
export function tickQueueConfigured(): boolean {
  return isR2Configured() && tickSignatureKey() !== null && resolveJobOrigin().ok;
}

/** Comparaison à temps constant de deux chaînes hexadécimales. */
function hexEquals(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a); // garde un temps ~constant même en cas de longueurs différentes
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Signature d'un corps de tick : `v1.<tsMs>.<hmac>` (hmac = HMAC-SHA256(clé, ts + "\n" + corps)). */
export function signTickBody(rawBody: string): string {
  const key = tickSignatureKey();
  if (!key) throw new Error("Signature de tick impossible : secret R2 absent.");
  const ts = Date.now().toString();
  const hmac = createHmac("sha256", key).update(`${ts}\n${rawBody}`).digest("hex");
  return `v1.${ts}.${hmac}`;
}

/** Vérifie la signature d'un corps de tick (temps constant, fraîcheur ±300 s). */
export function verifyTickSignature(rawBody: string, header: string | null): boolean {
  if (!header) return false;
  const parts = header.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const ts = Number(parts[1]);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const ageSec = Math.abs(Date.now() - ts) / 1000;
  if (ageSec > SIGNATURE_MAX_AGE_SEC) return false;
  const key = tickSignatureKey();
  if (!key) return false;
  const expected = createHmac("sha256", key).update(`${parts[1]}\n${rawBody}`).digest("hex");
  return hexEquals(parts[2].toLowerCase(), expected);
}

/** Authentification d'une requête de tick : signature interne OU bearer CRON_SECRET (cron Vercel / sonde). */
export function verifyTickRequest(rawBody: string, authorization: string | null, tickHeader: string | null): boolean {
  if (verifyTickSignature(rawBody, tickHeader)) return true;
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return false;
  const bearer = authorization ?? "";
  const expected = `Bearer ${cronSecret}`;
  if (bearer.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(bearer, "utf8"), Buffer.from(expected, "utf8"));
}

/* ------------------------------------------------------------------ */
/* Tickets : écriture, lecture, claim, complétion                      */
/* ------------------------------------------------------------------ */

export type TickKind = "mission-tick" | "dispatch-tick" | "video-render-tick" | "video-production-tick";

interface TicketDocument {
  kind: TickKind;
  /** Corps JSON exact à poster au receiver. */
  body: string;
  /** Chemin du receiver (ex. /api/queue/mission-tick). */
  path: string;
  dueAtMs: number;
  attempts: number;
  leaseUntilMs?: number;
  createdAtMs: number;
}

function ticketKey(dueAtMs: number, id: string): string {
  return `${TICKETS_PREFIX}${String(dueAtMs).padStart(16, "0")}-${id}.json`;
}

/** Résultat discriminé d'un enqueue (contrat de l'ancienne file, conservé pour les appelants). */
export type TickPublishResult =
  | { ok: true; mode: "r2-queue"; messageId: string }
  | { ok: false; mode: "unconfigured" }
  | { ok: false; mode: "error"; message: string };

/**
 * Écrit un ticket DÛ (délivrance immédiate) et déclenche le receiver.
 * `path` est TOUJOURS un chemin interne fixe (jamais une URL externe) : la
 * destination est construite depuis l'origine canonique et validée contre
 * l'allowlist avant tout fetch.
 */
async function writeTicket(input: { kind: TickKind; body: string; path: string; delaySeconds?: number; id?: string }): Promise<TickPublishResult> {
  if (!isR2Configured()) return { ok: false, mode: "unconfigured" } as const;
  const now = Date.now();
  const delaySeconds = Math.max(0, Math.min(input.delaySeconds ?? 0, 86_400));
  const dueAtMs = now + delaySeconds * 1000;
  const id = input.id ?? crypto.randomUUID();
  const document: TicketDocument = {
    kind: input.kind,
    body: input.body,
    path: input.path,
    dueAtMs,
    attempts: 0,
    createdAtMs: now,
  };
  const encoded = Buffer.from(JSON.stringify(document), "utf8");
  if (encoded.byteLength > MAX_TICKET_BYTES) {
    return { ok: false, mode: "error", message: `Corps de ticket trop volumineux (${encoded.byteLength} octets).` } as const;
  }
  try {
    const created = await putObjectConditional(ticketKey(dueAtMs, id), encoded, "application/json", { ifNoneMatch: "*" });
    if (!created) {
      // Clé en collision (UUID) : création impossible — erreur honnête.
      return { ok: false, mode: "error", message: "Collision de clé de ticket (création conditionnelle refusée)." } as const;
    }
  } catch (error) {
    return { ok: false, mode: "error", message: error instanceof Error ? error.message : String(error) } as const;
  }

  // Délivrance immédiate pour les chaînes courtes (missions, vidéo) ; les
  // délais longs (slots de dispatch) reposent sur le pump opportuniste et la
  // sentinelle cron — un self-fetch immédiat serait un no-op prématuré.
  if (delaySeconds <= IMMEDIATE_DELIVERY_MAX_DELAY_SEC) {
    await deliverTickNow(input.path, input.body).catch(() => undefined);
  }
  return { ok: true, mode: "r2-queue", messageId: id } as const;
}

/**
 * POST signé vers le receiver d'un tick — origine canonique UNIQUEMENT,
 * FIRE-AND-FORGET GRACIÉ : la requête est initiée et on n'attend que le
 * temps qu'elle atteigne le fil (~300 ms) — JAMAIS la réponse complète
 * (le receiver traite une tranche de 50 s : l'enqueueur, souvent une
 * requête utilisateur, ne doit pas être tenu ouvert si longtemps). Le
 * receiver continue son travail même si le client se déconnecte (fonction
 * serverless indépendante) ; si la délivrance était perdue, le ticket R2
 * reste DÛ et le pump (polling client, sentinelle cron) le re-délivre.
 */
async function deliverTickNow(path: string, body: string): Promise<void> {
  const resolved = resolveJobOrigin();
  if (!resolved.ok) return;
  const destinationUrl = `${resolved.origin.replace(/\/$/, "")}${path}`;
  assertSafeDestinationUrl(destinationUrl);
  const floating = fetch(destinationUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [TICK_SIGNATURE_HEADER]: signTickBody(body),
    },
    body,
    signal: AbortSignal.timeout(120_000),
  }).catch(() => undefined); // jamais de rejet non géré (promesse flottante)
  // Grâce d'émission : laisser la requête atteindre le fil avant de rendre
  // la main à l'enqueueur (l'échec éventuel reste sans effet — pump en relais).
  await new Promise((resolve) => setTimeout(resolve, 300));
  void floating;
}

/**
 * Délivrance ATTENDUE (pump) : contrairement à deliverTickNow, la réponse
 * COMPLÈTE est attendue — le receiver travaille en ligne (contrat 5xx =
 * échec transitoire) et le pump décide : 2xx → ticket consommé, 5xx/réseau
 * → réessai avec backoff. C'est l'équivalent exact de la redélivrance de
 * l'ancienne file externe, sans plafond journalier.
 */
async function deliverTickAndAwait(path: string, body: string): Promise<void> {
  const resolved = resolveJobOrigin();
  if (!resolved.ok) throw new Error("Origine canonique non résolue");
  const destinationUrl = `${resolved.origin.replace(/\/$/, "")}${path}`;
  assertSafeDestinationUrl(destinationUrl);
  const response = await fetch(destinationUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [TICK_SIGNATURE_HEADER]: signTickBody(body),
    },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`Receiver ${path} a répondu ${response.status}`);
  }
}

/* ------------------------------------------------------------------ */
/* API de haut niveau (calquée sur l'ancien client QStash)             */
/* ------------------------------------------------------------------ */

/** Chemin du receiver de tick de mission. */
export const MISSION_TICK_PATH = "/api/queue/mission-tick";
/** Chemin du receiver de la boucle de dispatch planifié. */
export const DISPATCH_TICK_PATH = "/api/queue/dispatch-tick";
/** Chemin du receiver du worker de rendu vidéo. */
export const VIDEO_RENDER_TICK_PATH = "/api/video/worker/tick";
/** Chemin du receiver du worker de production vidéo. */
export const VIDEO_PRODUCTION_TICK_PATH = "/api/video/worker/production-tick";

/** Enfile un tick de mission ({ runId }) — délai court = chaîne immédiate. */
export async function enqueueMissionTick(runId: string, options: { delaySeconds?: number } = {}): Promise<TickPublishResult> {
  return writeTicket({
    kind: "mission-tick",
    body: JSON.stringify({ runId }),
    path: MISSION_TICK_PATH,
    delaySeconds: options.delaySeconds ?? 0,
  });
}

/** Enfile le tick de la boucle de dispatch (slot de 5 min) — délai = temps jusqu'au slot. */
export async function enqueueDispatchTick(options: { delaySeconds: number; slotEpoch: number }): Promise<TickPublishResult> {
  return writeTicket({
    kind: "dispatch-tick",
    body: JSON.stringify({ slotEpoch: options.slotEpoch }),
    path: DISPATCH_TICK_PATH,
    delaySeconds: options.delaySeconds,
  });
}

/** Enfile un tick du worker de rendu vidéo ({ jobId }). */
export async function enqueueVideoRenderTick(jobId: string, delaySeconds = 1): Promise<TickPublishResult> {
  return writeTicket({
    kind: "video-render-tick",
    body: JSON.stringify({ jobId }),
    path: VIDEO_RENDER_TICK_PATH,
    delaySeconds,
  });
}

/** Enfile un tick du worker de production vidéo ({ jobId }). */
export async function enqueueVideoProductionTick(jobId: string, delaySeconds = 1): Promise<TickPublishResult> {
  return writeTicket({
    kind: "video-production-tick",
    body: JSON.stringify({ jobId }),
    path: VIDEO_PRODUCTION_TICK_PATH,
    delaySeconds,
  });
}

/* ------------------------------------------------------------------ */
/* Pump : rattrapage des tickets dus                                   */
/* ------------------------------------------------------------------ */

export interface PumpOutcome {
  scanned: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  purged: number;
}

function parseTicket(data: Buffer): TicketDocument | null {
  try {
    const parsed = JSON.parse(data.toString("utf8")) as Partial<TicketDocument>;
    if (!parsed || typeof parsed.body !== "string" || typeof parsed.path !== "string") return null;
    return {
      kind: parsed.kind ?? "mission-tick",
      body: parsed.body,
      path: parsed.path,
      dueAtMs: typeof parsed.dueAtMs === "number" ? parsed.dueAtMs : 0,
      attempts: typeof parsed.attempts === "number" ? parsed.attempts : 0,
      ...(typeof parsed.leaseUntilMs === "number" ? { leaseUntilMs: parsed.leaseUntilMs } : {}),
      createdAtMs: typeof parsed.createdAtMs === "number" ? parsed.createdAtMs : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Rattrape les tickets DUS : délivrance au receiver, retry avec backoff sur
 * échec, quarantaine après épuisement des tentatives, purge des vieux
 * tickets. Idempotent et SÛR en exécution concurrente (claim CAS par ETag).
 * Les chemins de receiver ne viennent QUE de tickets écrits par ce module —
 * mais la défense en profondeur revalide le chemin contre l'allowlist avant
 * tout fetch (un bucket compromis ne peut pas faire poster vers un tiers).
 */
export async function pumpDueTicks(): Promise<PumpOutcome> {
  const outcome: PumpOutcome = { scanned: 0, delivered: 0, retried: 0, deadLettered: 0, purged: 0 };
  if (!isR2Configured()) return outcome;
  const now = Date.now();

  let entries: Array<{ key: string; sizeBytes: number; updatedAt: string }>;
  try {
    entries = await listObjectsUnderPrefix(TICKETS_PREFIX, 200);
  } catch {
    return outcome; // R2 indisponible : le prochain passage reprendra.
  }

  for (const entry of entries.slice(0, PUMP_BATCH * 2)) {
    outcome.scanned += 1;
    if (entry.key.endsWith("/") || !entry.key.endsWith(".json")) continue;
    if (outcome.delivered + outcome.retried + outcome.deadLettered >= PUMP_BATCH) break;

    const object = await getObjectWithEtag(entry.key, MAX_TICKET_BYTES).catch(() => null);
    if (!object) continue;
    const ticket = parseTicket(object.data);
    if (!ticket) {
      // Ticket illisible : quarantaine immédiate (jamais de re-traitement).
      await quarantineTicket(entry.key, object.data, "unreadable").catch(() => undefined);
      outcome.deadLettered += 1;
      continue;
    }
    // Purge des tickets trop vieux (créés > 7 j) : quelle que soit leur échéance.
    if (ticket.createdAtMs > 0 && now - ticket.createdAtMs > TICK_RETENTION_MS) {
      await deleteObject(entry.key).catch(() => undefined);
      outcome.purged += 1;
      continue;
    }
    const leaseActive = typeof ticket.leaseUntilMs === "number" && ticket.leaseUntilMs > now;
    if (ticket.dueAtMs > now || leaseActive) continue;

    // Claim CAS : marque la tentative AVANT la délivrance — deux pumps
    // concurrents ne peuvent pas doubler l'envoi (l'un reçoit null et passe).
    const claimed: TicketDocument = { ...ticket, attempts: ticket.attempts + 1, leaseUntilMs: now + TICKET_LEASE_MS };
    const put = await putObjectConditional(
      entry.key,
      Buffer.from(JSON.stringify(claimed), "utf8"),
      "application/json",
      { ifMatch: object.etag },
    ).catch(() => null);
    if (!put) continue; // concurrent plus rapide ou R2 indisponible.

    try {
      await deliverTickAndAwait(ticket.path, ticket.body);
      await deleteObject(entry.key).catch(() => undefined); // complété : ticket consommé.
      outcome.delivered += 1;
    } catch {
      if (claimed.attempts >= TICKET_MAX_ATTEMPTS) {
        await quarantineTicket(entry.key, Buffer.from(JSON.stringify(claimed), "utf8"), "max-attempts").catch(() => undefined);
        outcome.deadLettered += 1;
      } else {
        // Backoff exponentiel : 30 s, 60 s, 120 s, 240 s — réécriture à la
        // nouvelle échéance (nouvelle clé, l'ancienne est supprimée après).
        const backoffMs = 30_000 * 2 ** (claimed.attempts - 1);
        const retried: TicketDocument = { ...claimed, dueAtMs: now + backoffMs, leaseUntilMs: undefined };
        const id = entry.key.slice(TICKETS_PREFIX.length).replace(/\.json$/, "");
        await putObjectConditional(
          ticketKey(retried.dueAtMs, id.replace(/^\d+-/, "")),
          Buffer.from(JSON.stringify(retried), "utf8"),
          "application/json",
          { ifNoneMatch: "*" },
        ).catch(() => undefined);
        await deleteObject(entry.key).catch(() => undefined);
        outcome.retried += 1;
      }
    }
  }
  return outcome;
}

/** Déplace un ticket en quarantaine (inspection) : queue/dead/v1/<id>.json. */
async function quarantineTicket(key: string, data: Buffer, reason: string): Promise<void> {
  const id = key.slice(TICKETS_PREFIX.length);
  const payload = Buffer.from(JSON.stringify({ reason, quarantinedAtMs: Date.now(), originalKey: key, content: data.toString("utf8") }), "utf8");
  await putObjectConditional(`${DEAD_PREFIX}${id}`, payload, "application/json", { ifNoneMatch: "*" }).catch(() => undefined);
  await deleteObject(key).catch(() => undefined);
}

/* ------------------------------------------------------------------ */
/* Nudge opportuniste (throttlé par processus)                         */
/* ------------------------------------------------------------------ */

const NUDGE_INTERVAL_MS = 15_000;
let lastNudgeAtMs = 0;

/**
 * Déclenche le pump depuis une route de suivi (polling client) — au plus une
 * fois toutes les 15 s par instance, en fire-and-forget : le temps de
 * réponse de la route appelante n'est JAMAIS impacté. Les échecs sont
 * silencieux (le prochain sondage retentera).
 */
export function nudgePumpFromPolling(): void {
  const now = Date.now();
  if (now - lastNudgeAtMs < NUDGE_INTERVAL_MS) return;
  lastNudgeAtMs = now;
  void pumpDueTicks().catch(() => undefined);
}
