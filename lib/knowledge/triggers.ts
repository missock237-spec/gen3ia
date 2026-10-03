import "server-only";

import { z } from "zod";
import { randomUUID } from "crypto";

import { adminDb } from "@/lib/firebase/admin";
import { getAgentForUser } from "@/lib/agents/repository";
import { createQueuedMission } from "@/lib/queue/mission-queue";
import { missionQueueConfigured, publishMissionTick } from "@/lib/queue/qstash";

/**
 * DÉCLENCHEURS D'INGESTION (concept post-SaaS #9 « Reality-to-Digital
 * Engine ») : le réel qui entre dans la base de connaissances DÉCLENCHE des
 * actions autonomes. Une image scannée, un enregistrement vocal ou un
 * document importé peut lancer une mission d'agent (qui peut elle-même
 * exécuter un workflow via l'outil workflow.run, envoyer des messages
 * d'équipe, produire des livrables…).
 *
 * DÉCISION D'ARCHITECTURE : l'exécution d'arrière-plan passe UNIQUEMENT par
 * la file d'attente des missions (createQueuedMission + QStash) — le seul
 * chemin résilient de la plateforme (bail, reprise par tranches, facturation
 * par étape). Une panne de déclencheur ne JAMAIS invalider l'ingestion :
 * les résultats sont journalisés par document (collection
 * `knowledgeTriggerRuns`).
 */

const COLLECTION = "knowledgeTriggers";
const RUNS_COLLECTION = "knowledgeTriggerRuns";

export const TriggerMatchSchema = z.object({
  kind: z.enum(["any", "filename_contains", "mime_type"]),
  /** Motif du match (sous-chaîne du nom de fichier ou préfixe du type MIME, insensible à la casse). */
  pattern: z.string().trim().min(1).max(200).optional(),
});

export const TriggerActionSchema = z.object({
  type: z.literal("run_agent_mission"),
  /** Agent réel du Studio (validé à l'écriture). */
  agentId: z.string().trim().min(1).max(128),
  /** Modèle d'objectif ; jetons {{document.name}}, {{document.mimeType}}, {{document.excerpt}}. */
  objectiveTemplate: z.string().trim().min(3).max(2_000),
});

export const KnowledgeTriggerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  match: TriggerMatchSchema,
  action: TriggerActionSchema,
  enabled: z.boolean().default(true),
  orgId: z.string().trim().min(1).max(128).optional(),
});

export interface KnowledgeTriggerDoc {
  id: string;
  userId: string;
  orgId?: string;
  name: string;
  match: z.infer<typeof TriggerMatchSchema>;
  action: z.infer<typeof TriggerActionSchema>;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface TriggerEvaluationResult {
  triggerId: string;
  triggerName: string;
  status: "matched_no_queue" | "mission_queued" | "agent_missing" | "failed";
  detail: string;
  runId?: string;
}

/* ------------------------------------------------------------------ */
/* CRUD (routes API)                                                    */
/* ------------------------------------------------------------------ */

/** Valide l'agent cible AVANT persistance (réel, actif, accessible). */
export async function createKnowledgeTrigger(userId: string, input: unknown): Promise<KnowledgeTriggerDoc> {
  const parsed = KnowledgeTriggerSchema.parse(input);
  const agent = await getAgentForUser(userId, parsed.action.agentId);
  if (!agent || agent.status !== "active") {
    throw new Error("Agent cible du déclencheur introuvable ou inactif.");
  }
  const now = Date.now();
  const doc: KnowledgeTriggerDoc = {
    id: randomUUID(),
    userId,
    ...(parsed.orgId ? { orgId: parsed.orgId } : {}),
    name: parsed.name,
    match: parsed.match,
    action: parsed.action,
    enabled: parsed.enabled,
    createdAtMs: now,
    updatedAtMs: now,
  };
  await adminDb.collection(COLLECTION).doc(doc.id).set(doc);
  return doc;
}

export async function listKnowledgeTriggers(userId: string): Promise<KnowledgeTriggerDoc[]> {
  const snapshot = await adminDb.collection(COLLECTION).where("userId", "==", userId).limit(100).get();
  return snapshot.docs.map((doc) => doc.data() as KnowledgeTriggerDoc);
}

export async function updateKnowledgeTrigger(userId: string, triggerId: string, patch: { enabled?: boolean; name?: string }): Promise<KnowledgeTriggerDoc> {
  const ref = adminDb.collection(COLLECTION).doc(triggerId);
  const snapshot = await ref.get();
  const data = snapshot.data() as Partial<KnowledgeTriggerDoc> | undefined;
  if (!data || data.userId !== userId) throw new Error("Déclencheur introuvable ou inaccessible.");
  const update = {
    ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 120) } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    updatedAtMs: Date.now(),
  };
  await ref.update(update);
  return { ...(data as KnowledgeTriggerDoc), ...update };
}

export async function deleteKnowledgeTrigger(userId: string, triggerId: string): Promise<void> {
  const ref = adminDb.collection(COLLECTION).doc(triggerId);
  const snapshot = await ref.get();
  const data = snapshot.data() as Partial<KnowledgeTriggerDoc> | undefined;
  if (!data || data.userId !== userId) throw new Error("Déclencheur introuvable ou inaccessible.");
  await ref.delete();
}

/* ------------------------------------------------------------------ */
/* Évaluation (appelée après une ingestion réussie)                     */
/* ------------------------------------------------------------------ */

/** Match PUR (testé sans Firestore) : le document déclenche-t-il la règle ? */
export function triggerMatches(trigger: Pick<KnowledgeTriggerDoc, "match">, document: { name: string; mimeType: string }): boolean {
  switch (trigger.match.kind) {
    case "any":
      return true;
    case "filename_contains":
      return Boolean(trigger.match.pattern) && document.name.toLowerCase().includes((trigger.match.pattern ?? "").toLowerCase());
    case "mime_type":
      return Boolean(trigger.match.pattern) && document.mimeType.toLowerCase().startsWith((trigger.match.pattern ?? "").toLowerCase());
  }
}

/** Rend l'objectif depuis le modèle (jetons bornés — jamais de prompt géant). */
export function renderTriggerObjective(template: string, document: { name: string; mimeType: string; excerpt: string }): string {
  return template
    .replaceAll("{{document.name}}", document.name.slice(0, 200))
    .replaceAll("{{document.mimeType}}", document.mimeType.slice(0, 100))
    .replaceAll("{{document.excerpt}}", document.excerpt.slice(0, 600));
}

/**
 * Évalue tous les déclencheurs actifs du propriétaire pour un document
 * fraîchement ingéré. NE LÈVE JAMAIS : chaque règle est journalisée
 * (knowledgeTriggerRuns) et les échecs isolés.
 */
export async function evaluateKnowledgeTriggers(input: {
  userId: string;
  orgId?: string;
  document: { id: string; name: string; mimeType: string; excerpt: string };
}): Promise<TriggerEvaluationResult[]> {
  let triggers: KnowledgeTriggerDoc[];
  try {
    triggers = (await listKnowledgeTriggers(input.userId)).filter((trigger) => trigger.enabled);
  } catch (error) {
    console.error("[knowledge-triggers] lecture impossible (ingestion poursuivie):", error instanceof Error ? error.message : error);
    return [];
  }

  const results: TriggerEvaluationResult[] = [];
  for (const trigger of triggers) {
    if (!triggerMatches(trigger, input.document)) continue;
    let result: TriggerEvaluationResult;
    try {
      if (!missionQueueConfigured()) {
        result = { triggerId: trigger.id, triggerName: trigger.name, status: "matched_no_queue", detail: "File d'attente non configurée — mission non lancée." };
      } else {
        const agent = await getAgentForUser(input.userId, trigger.action.agentId);
        if (!agent || agent.status !== "active") {
          result = { triggerId: trigger.id, triggerName: trigger.name, status: "agent_missing", detail: `Agent ${trigger.action.agentId.slice(0, 64)} introuvable ou inactif.` };
        } else {
          const objective = renderTriggerObjective(trigger.action.objectiveTemplate, {
            name: input.document.name,
            mimeType: input.document.mimeType,
            excerpt: input.document.excerpt,
          });
          const runId = randomUUID();
          const executionId = randomUUID();
          await createQueuedMission({
            runId,
            executionId,
            userId: input.userId,
            objective,
            ...(input.orgId ? { orgId: input.orgId } : {}),
            plan: {
              executionId,
              objective,
              steps: [
                {
                  id: "step_1",
                  type: "llm",
                  name: "Traiter le document ingéré",
                  description: objective,
                  dependencies: [],
                  status: "pending",
                  input: {},
                  skillIds: [],
                  maxRetries: 2,
                  timeoutMs: 120_000,
                  sideEffect: false,
                  requiresApproval: false,
                },
              ],
              maxConcurrency: 1,
              maxIterations: 10,
            },
          });
          const origin = process.env.GEN3IA_APP_ORIGIN?.trim();
          if (origin) await publishMissionTick(origin, runId);
          result = { triggerId: trigger.id, triggerName: trigger.name, status: "mission_queued", detail: "Mission enfilée.", runId };
        }
      }
    } catch (error) {
      result = { triggerId: trigger.id, triggerName: trigger.name, status: "failed", detail: (error instanceof Error ? error.message : "Erreur inconnue").slice(0, 300) };
    }
    results.push(result);
    // Journal par document (best-effort — jamais bloquant).
    await adminDb.collection(RUNS_COLLECTION).add({
      documentId: input.document.id,
      triggerId: trigger.id,
      userId: input.userId,
      ...(input.orgId ? { orgId: input.orgId } : {}),
      status: result.status,
      detail: result.detail,
      ...(result.runId ? { runId: result.runId } : {}),
      createdAtMs: Date.now(),
    }).catch(() => undefined);
  }
  return results;
}
