import "server-only";

/**
 * SUIVI ASYNCHRONE DES SESSIONS JULES (Task 121).
 *
 * Jules (jules.google) est un agent de code ASYNCHRONE : une session démarre
 * sur POST /sessions, puis travaille plusieurs minutes avant de produire des
 * sorties (patchs / pull requests). Ce module assure la boucle complète :
 *
 *  1. PERSISTANCE — chaque session lancée depuis une conversation est
 *     enregistrée dans la collection Firestore `julesSessions` (même couche
 *     résiliente que les files vidéo : quota-aware, jamais bloquante) avec
 *     la conversation d'origine pour la livraison future ;
 *  2. PROGRAMMATION — un TICK de suivi est écrit dans la file R2
 *     (format des tickets de lib/queue/tick-queue.ts, module NON MODIFIÉ :
 *     l'écriture est atomique If-None-Match:* et le pump existant livre les
 *     tickets dus au receiver /api/cron/jules-followup) ;
 *  3. SONDAGE — chaque passage interroge julesGetSession pour les sessions
 *     actives et livre le résultat dans le fil d'origine DÈS qu'un état
 *     terminal est observé ;
 *  4. LIVRAISON — message assistant + artefact code, idempotents (miroir de
 *     deliverJobToConversation, Task 113 : « livrer d'abord, marquer
 *     ensuite » + anti-doublon par lecture du fil).
 *
 * La boucle est AUTO-PERPÉTUANTE tant qu'une session reste active (un
 * nouveau tick est programmé à chaque passage) et s'arrête toute seule quand
 * tout est livré. Les replis : cron quotidien (/api/cron/agent-schedules →
 * pump), polling client (nudgePumpFromPolling) et route GET bearer.
 */

import { randomUUID } from "node:crypto";

import { julesGetSession, type JulesSessionSnapshot } from "@/lib/integrations/jules/client";
import { resilientCreate, resilientQuery, resilientSet } from "@/lib/db/firestore-resilient";
import { appendMessage, listMessages } from "@/lib/chat/repository";
import { createArtifact } from "@/lib/domain/artifacts/repository";
import { putObjectConditional } from "@/lib/storage/r2";
import { tickQueueConfigured } from "@/lib/queue/tick-queue";

/* ------------------------------------------------------------------ */
/* Contrat de la collection Firestore `julesSessions`                  */
/* ------------------------------------------------------------------ */

export const JULES_SESSIONS_COLLECTION = "julesSessions";

export const JULES_SESSION_STATUSES = ["active", "completed", "failed", "cancelled", "stalled"] as const;
export type JulesSessionStatus = (typeof JULES_SESSION_STATUSES)[number];

/** Document de suivi d'une session Jules lancée depuis la plateforme. */
export interface JulesSessionRecord {
  /** Identifiant du document (UUID). */
  id: string;
  userId: string;
  /** Conversation d'origine : absente = lancée hors chat (aucune livraison). */
  conversationId?: string;
  projectId?: string;
  /** Nom de session Jules (GET /sessions/{name}). */
  session: string;
  /** Dépôt cible « owner/repo ». */
  repo: string;
  /** Consigne transmise à Jules (traçabilité). */
  prompt: string;
  /** Titre court dérivé de la demande (artefact, messages). */
  title: string;
  status: JulesSessionStatus;
  /** Nombre de sondages effectués (borne anti-boucle infinie). */
  pollAttempts: number;
  /** Dernier état brut observé côté Jules (ex. « IN_PROGRESS »). */
  lastState?: string;
  /** Horodatage ISO de la livraison chat (IDEMPOTENCE). */
  deliveredAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Paramètres de création (le moteur conversationnel est l'appelant nominal). */
export interface CreateJulesSessionRecordInput {
  userId: string;
  conversationId?: string;
  projectId?: string;
  /** Nom de session renvoyé par julesCreateSession. */
  session: string;
  repo: string;
  prompt: string;
  title?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Crée le document de suivi d'une session Jules (couche résiliente Firestore). */
export async function createJulesSessionRecord(input: CreateJulesSessionRecordInput): Promise<JulesSessionRecord> {
  const now = nowIso();
  const record: JulesSessionRecord = {
    id: randomUUID(),
    userId: input.userId,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    session: input.session,
    repo: input.repo,
    prompt: input.prompt.slice(0, 4_000),
    title: (input.title ?? "Tâche Jules").slice(0, 80),
    status: "active",
    pollAttempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  await resilientCreate(JULES_SESSIONS_COLLECTION, record.id, record, input.userId);
  return record;
}

/** Sessions Jules encore actives (les plus anciennes d'abord). */
export async function listActiveJulesSessions(limit = 10): Promise<JulesSessionRecord[]> {
  return resilientQuery<JulesSessionRecord>(
    JULES_SESSIONS_COLLECTION,
    [{ field: "status", value: "active" }],
    { orderField: "createdAt", limit },
  );
}

/** Patch merge d'un document de session (ownerId pour la propriété du doc). */
async function patchJulesSession(id: string, userId: string, patch: Partial<JulesSessionRecord>): Promise<void> {
  await resilientSet(JULES_SESSIONS_COLLECTION, id, { ...patch, updatedAt: nowIso() } as object, {
    merge: true,
    ownerId: userId,
  });
}

/* ------------------------------------------------------------------ */
/* États Jules → statut de suivi                                       */
/* ------------------------------------------------------------------ */

/**
 * Mappe l'état brut renvoyé par l'API Jules vers un statut de suivi.
 * États observés côté Google : « IN_PROGRESS » pendant le travail, puis un
 * état terminal (« COMPLETED », « FAILED », « CANCELLED ») ; la correspondance
 * est tolérante aux variantes (done/finished/succeeded, annulé, erreur).
 */
export function mapJulesState(state?: string): JulesSessionStatus {
  const lower = (state ?? "").toLowerCase();
  if (!lower) return "active";
  if (lower.includes("complet") || lower.includes("done") || lower.includes("finish") || lower.includes("success") || lower.includes("succeed")) {
    return "completed";
  }
  if (lower.includes("cancel")) return "cancelled";
  if (lower.includes("fail") || lower.includes("error")) return "failed";
  return "active";
}

/* ------------------------------------------------------------------ */
/* Programmation du tick de suivi (file de ticks R2, format partagé)   */
/* ------------------------------------------------------------------ */

/** Chemin du receiver de suivi (route cron + receiver de tick à la fois). */
export const JULES_FOLLOWUP_PATH = "/api/cron/jules-followup";

/**
 * Préfixe des tickets de la file de ticks R2 — FORMAT FIGÉ par
 * lib/queue/tick-queue.ts (module en LECTURE SEULE pour cette tâche) :
 * `queue/tickets/v1/<dueAtMs-16chiffres>-<uuid>.json`. Le pump existant
 * (pumpDueTicks) liste ce préfixe, claim les tickets dus (CAS ETag) et les
 * livre en POST signé au chemin `path` du document.
 */
const TICKETS_PREFIX = "queue/tickets/v1/";

/** Taille plafond d'un ticket (contrat de la file). */
const MAX_TICKET_BYTES = 8_192;

/** Délai entre deux sondages d'une session Jules (secondes). */
export const JULES_FOLLOWUP_DELAY_SEC = 90;

/** Budget de sondages avant l'avis honnête « toujours en cours » (≈ 2 h à 90 s). */
export const JULES_MAX_POLL_ATTEMPTS = 80;

/** Sessions sondées par passage (bornage serverless). */
const MAX_SESSIONS_PER_PASS = 10;

/** Résultat d'une programmation de tick (contrat calqué sur TickPublishResult). */
export type JulesFollowupScheduleResult =
  | { ok: true; ticketId: string }
  | { ok: false; reason: "unconfigured" | "error"; message?: string };

/**
 * Programme un passage du suivi Jules : écrit un ticket DÛ dans la file de
 * ticks R2 (délai en secondes). Le pump opportuniste (polling client, boucle
 * de dispatch, cron sentinelle) livre le ticket au receiver
 * /api/cron/jules-followup — AUCUNE modification de lib/queue/tick-queue.ts.
 */
export async function scheduleJulesFollowup(delaySeconds = JULES_FOLLOWUP_DELAY_SEC): Promise<JulesFollowupScheduleResult> {
  if (!tickQueueConfigured()) {
    // File non activable : le cron quotidien et la route GET bearer restent
    // les replis — le suivi n'est jamais silencieusement perdu.
    return { ok: false, reason: "unconfigured" };
  }
  const now = Date.now();
  const dueAtMs = now + Math.max(0, Math.min(delaySeconds, 86_400)) * 1000;
  const id = randomUUID();
  const document = {
    kind: "jules-followup",
    body: JSON.stringify({ v: 1 }),
    path: JULES_FOLLOWUP_PATH,
    dueAtMs,
    attempts: 0,
    createdAtMs: now,
  };
  const encoded = Buffer.from(JSON.stringify(document), "utf8");
  if (encoded.byteLength > MAX_TICKET_BYTES) {
    return { ok: false, reason: "error", message: `Corps de ticket trop volumineux (${encoded.byteLength} octets).` };
  }
  try {
    const key = `${TICKETS_PREFIX}${String(dueAtMs).padStart(16, "0")}-${id}.json`;
    const created = await putObjectConditional(key, encoded, "application/json", { ifNoneMatch: "*" });
    if (!created) {
      return { ok: false, reason: "error", message: "Collision de clé de ticket (création conditionnelle refusée)." };
    }
    return { ok: true, ticketId: id };
  } catch (error) {
    return { ok: false, reason: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------------ */
/* Message de livraison (pur — testé unitairement)                    */
/* ------------------------------------------------------------------ */

/** Sortie Jules formatée pour le message. */
export interface JulesDeliveryOutputsEntry {
  url?: string;
  type?: string;
  description?: string;
}

/** Paramètres du message de livraison. */
export interface JulesDeliveryMessageParams {
  status: JulesSessionStatus;
  session: string;
  repo: string;
  title?: string;
  outputs?: JulesDeliveryOutputsEntry[];
  errorMessage?: string;
  lastState?: string;
}

/** Phrase-marker déterministe par statut (anti-doublon de la livraison). */
export function julesDeliveryPhrase(status: JulesSessionStatus): string {
  switch (status) {
    case "completed":
      return "Votre tâche Jules est terminée";
    case "failed":
      return "Votre tâche Jules n'a pas abouti";
    case "cancelled":
      return "Votre tâche Jules a bien été annulée";
    default:
      return "Votre tâche Jules est toujours en cours";
  }
}

/** Ligne d'identification stable de la livraison (présente dans CHAQUE message). */
export function julesSessionLine(session: string): string {
  return `Session : ${session}`;
}

/** Construit le message de livraison (FR) — déterministe sauf les sorties. */
export function buildJulesDeliveryMessage(params: JulesDeliveryMessageParams): string {
  const lines: string[] = [];
  lines.push(`${julesDeliveryPhrase(params.status)}${params.title ? ` — ${params.title}` : ""}.`);
  lines.push("");
  lines.push(`Dépôt : ${params.repo}`);
  lines.push(julesSessionLine(params.session));
  if (params.lastState) lines.push(`Dernier état observé : ${params.lastState}`);
  lines.push("");

  if (params.status === "completed") {
    const outputs = (params.outputs ?? []).filter((o) => o.url || o.description || o.type);
    if (outputs.length > 0) {
      lines.push("Ce que Jules a produit :");
      for (const output of outputs.slice(0, 8)) {
        const label = output.description || output.type || "sortie";
        lines.push(output.url ? `- [${label}](${output.url})` : `- ${label}`);
      }
    } else {
      lines.push("Jules a terminé sans sortie téléchargeable : vérifiez les branches et pull requests du dépôt.");
    }
    lines.push("");
    lines.push("Relisez les changements, puis fusionnez ce que vous validez — demandez-moi des ajustements si besoin, je relance Jules sur le même dépôt.");
  } else if (params.status === "failed") {
    lines.push("La session Jules s'est terminée en échec côté Google.");
    if (params.errorMessage) lines.push(`Message remonté : ${params.errorMessage.slice(0, 400)}`);
    lines.push("");
    lines.push("Réessayez en renvoyant votre demande : je relance une session Jules sur le même dépôt.");
  } else if (params.status === "cancelled") {
    lines.push("La session Jules a été annulée (aucun changement fusionné).");
    lines.push("");
    lines.push("Redemandez-moi la tâche quand vous voulez : je relance une session Jules sur le même dépôt.");
  } else {
    // stalled : budget de sondages épuisé — la session peut encore vivre côté Google.
    lines.push(`Après ${JULES_MAX_POLL_ATTEMPTS} vérifications, la session n'était toujours pas terminée côté Google : la surveillance automatique s'arrête.`);
    lines.push("");
    lines.push("La session continue peut-être de travailler. Redemandez-moi « où en est ma tâche Jules ? » plus tard : je relance la vérification immédiatement.");
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Livraison idempotente dans la conversation (miroir Task 113)       */
/* ------------------------------------------------------------------ */

/** Statuts terminaux : seul un état terminal est livré. */
function isTerminalStatus(status: JulesSessionStatus): boolean {
  return status !== "active";
}

/**
 * Livre le résultat d'une session Jules TERMINALE dans sa conversation
 * d'origine : message assistant + artefact code (URLs patch/PR). NE LÈVE
 * JAMAIS — un incident de livraison est journalisé, le marqueur reste absent
 * et le prochain passage re-livre naturellement.
 *
 * Ordre « LIVRER D'ABORD, MARQUER ENSUITE » (Task 113) :
 *   1. anti-doublon par LECTURE du fil (phrase-marker + ligne session) ;
 *   2. appendMessage (LE livrable) ;
 *   3. artefact de livraison (sorties patch/PR) ;
 *   4. marqueur deliveredAt (best-effort, compensé par l'anti-doublon 1).
 */
export async function deliverJulesResultToConversation(
  record: JulesSessionRecord,
  snapshot: JulesSessionSnapshot | null,
): Promise<boolean> {
  if (!record.conversationId || record.deliveredAt || !isTerminalStatus(record.status)) return false;
  try {
    // 1) ANTI-DOUBLON par lecture du fil : le message de livraison contient
    // TOUJOURS la phrase-marker du statut ET la ligne « Session : <id> »
    // (le message de lancement utilise une autre formulation — pas de collision).
    const recent = await listMessages(record.userId, record.conversationId, 40, { order: "recent" }).catch(() => []);
    const alreadyDelivered = recent.some(
      (m) =>
        m.role === "assistant" &&
        m.content.includes(julesDeliveryPhrase(record.status)) &&
        m.content.includes(julesSessionLine(record.session)),
    );
    if (alreadyDelivered) {
      await patchJulesSession(record.id, record.userId, { deliveredAt: nowIso() }).catch(() => undefined);
      return false;
    }

    const content = buildJulesDeliveryMessage({
      status: record.status,
      session: record.session,
      repo: record.repo,
      title: record.title,
      outputs: snapshot?.outputs,
      ...(snapshot?.errorMessage ? { errorMessage: snapshot.errorMessage } : {}),
      ...(snapshot?.state ? { lastState: snapshot.state } : {}),
    });

    // 2) LE LIVRABLE : le message part AVANT tout marquage.
    await appendMessage({
      conversationId: record.conversationId,
      userId: record.userId,
      role: "assistant",
      content,
      generationStatus: "complete",
    });

    // 3) Artefact de livraison : les sorties (patch/PR) deviennent cliquables
    // dans le fil — uniquement quand il y a une URL à montrer.
    const firstUrl = (snapshot?.outputs ?? []).find((o) => typeof o.url === "string" && o.url)?.url;
    if (firstUrl) {
      await createArtifact({
        userId: record.userId,
        conversationId: record.conversationId,
        ...(record.projectId ? { projectId: record.projectId } : {}),
        type: "code",
        title: record.title || "Tâche Jules",
        url: firstUrl,
        note: `Session Jules ${record.status} — ${record.repo}`,
      }).catch(() => undefined);
    }

    // 4) Marqueur d'idempotence (best-effort).
    await patchJulesSession(record.id, record.userId, { deliveredAt: nowIso() }).catch(() => undefined);
    return true;
  } catch (error) {
    // Livraison impossible (magasin indisponible…) : AUCUN marqueur posé —
    // le prochain passage re-livrera naturellement.
    console.warn("[jules-followup] livraison chat impossible", error instanceof Error ? error.message : error);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Passage de sondage (le cœur du tick)                               */
/* ------------------------------------------------------------------ */

/** Résultat d'un passage de suivi. */
export interface JulesFollowupPassResult {
  /** Sessions actives trouvées au début du passage. */
  found: number;
  /** Sessions livrées dans leur conversation ce passage. */
  delivered: number;
  /** Sessions passées en terminal (livrées ou hors chat). */
  finished: number;
  /** Sessions toujours actives (un nouveau tick est programmé). */
  stillActive: number;
  /** Programmation du prochain tick (unconfigured = repli cron/polling). */
  nextTick: JulesFollowupScheduleResult;
}

/**
 * Un passage du suivi Jules : sonde les sessions actives, livre les résultats
 * terminaux dans leur conversation d'origine, puis programme le prochain tick
 * tant qu'au moins une session reste active. NE LÈVE PAS — chaque session est
 * traitée isolément (un incident n'arrête pas les autres).
 */
export async function pollJulesSessions(): Promise<JulesFollowupPassResult> {
  const result: JulesFollowupPassResult = { found: 0, delivered: 0, finished: 0, stillActive: 0, nextTick: { ok: false, reason: "unconfigured" } };

  let sessions: JulesSessionRecord[] = [];
  try {
    sessions = await listActiveJulesSessions(MAX_SESSIONS_PER_PASS);
  } catch {
    // Firestore indisponible : le prochain passage reprendra.
    return result;
  }
  result.found = sessions.length;
  if (sessions.length === 0) return result;

  for (const record of sessions) {
    try {
      const snapshot = await julesGetSession(record.session);
      const status = mapJulesState(snapshot.state);
      const attempts = record.pollAttempts + 1;

      if (status === "active") {
        // Toujours en cours : borne anti-boucle — au-delà du budget, un avis
        // honnête est livré et la surveillance s'arrête (la session peut
        // continuer de vivre côté Google, l'utilisateur garde la main).
        if (attempts >= JULES_MAX_POLL_ATTEMPTS) {
          const stalled: JulesSessionRecord = { ...record, pollAttempts: attempts, status: "stalled", lastState: snapshot.state };
          const delivered = await deliverJulesResultToConversation(stalled, snapshot);
          await patchJulesSession(record.id, record.userId, {
            pollAttempts: attempts,
            status: "stalled",
            ...(snapshot.state ? { lastState: snapshot.state } : {}),
            ...(delivered ? { deliveredAt: nowIso() } : {}),
          });
          result.finished += 1;
          if (delivered) result.delivered += 1;
        } else {
          await patchJulesSession(record.id, record.userId, {
            pollAttempts: attempts,
            ...(snapshot.state ? { lastState: snapshot.state } : {}),
          });
          result.stillActive += 1;
        }
        continue;
      }

      // État terminal : livrer d'abord, marquer ensuite.
      const terminal: JulesSessionRecord = { ...record, pollAttempts: attempts, status, lastState: snapshot.state };
      const delivered = await deliverJulesResultToConversation(terminal, snapshot);
      await patchJulesSession(record.id, record.userId, {
        pollAttempts: attempts,
        status,
        ...(snapshot.state ? { lastState: snapshot.state } : {}),
        ...(delivered ? { deliveredAt: nowIso() } : {}),
      });
      result.finished += 1;
      if (delivered) result.delivered += 1;
    } catch (error) {
      // Incident de sondage (réseau, quota API…) : la session reste active,
      // le compteur borne les tentatives — jamais de perte silencieuse.
      console.warn(
        "[jules-followup] sondage impossible",
        record.session,
        error instanceof Error ? error.message : error,
      );
      const attempts = record.pollAttempts + 1;
      if (attempts >= JULES_MAX_POLL_ATTEMPTS) {
        const stalled: JulesSessionRecord = { ...record, pollAttempts: attempts, status: "stalled" };
        const delivered = await deliverJulesResultToConversation(stalled, null).catch(() => false);
        await patchJulesSession(record.id, record.userId, {
          pollAttempts: attempts,
          status: "stalled",
          ...(delivered ? { deliveredAt: nowIso() } : {}),
        }).catch(() => undefined);
        result.finished += 1;
        if (delivered) result.delivered += 1;
      } else {
        await patchJulesSession(record.id, record.userId, { pollAttempts: attempts }).catch(() => undefined);
        result.stillActive += 1;
      }
    }
  }

  // Auto-perpétuation : tant qu'une session est active, le prochain passage
  // est programmé. La boucle s'arrête d'elle-même une fois tout livré.
  if (result.stillActive > 0) {
    result.nextTick = await scheduleJulesFollowup(JULES_FOLLOWUP_DELAY_SEC).catch((error: unknown) => ({
      ok: false as const,
      reason: "error" as const,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
  return result;
}
