import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";
import type { AgentSchedule } from "@/lib/agents/scheduler";
import type { AgentRecord } from "@/lib/agents/schema";

/**
 * IMPORTS DYNAMIQUES (casse-cycle) : lib/agents/scheduler importe le runtime
 * agent (AgentRuntime) qui importe l'exécuteur d'outils qui importe CE module
 * (default-registry). Un import statique créerait une dépendance circulaire
 * initialisant les outils avec des exports encore indéfinis.
 */
async function chargerScheduler() {
  return import("@/lib/agents/scheduler");
}
async function chargerRepository() {
  return import("@/lib/agents/repository");
}

/**
 * Outils « tâches planifiées » : ils opèrent sur les RÉELLES planifications
 * d'agents (collection Firestore agentSchedules, moteur lib/agents/scheduler
 * exécuté par le cron /api/cron/agent-schedules). Un utilisateur peut ainsi
 * créer, consulter, modifier ou supprimer une automatisation récurrente
 * depuis la conversation ou son agent IA — en langage naturel.
 *
 * La création résout automatiquement l'agent d'exécution : agent précisé →
 * premier agent actif (préférence « automatisation ») → création d'un agent
 * dédié (charte professionnelle générée serveur). Aucun identifiant n'est
 * inventé : les identifiants renvoyés sont ceux de la base.
 */

const daysOfWeekSchema = z
  .array(z.number().int().min(0).max(6))
  .min(1)
  .max(7)
  .refine((days) => new Set(days).size === days.length, "jours en double");

const CreateInputSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  objective: z.string().trim().min(3).max(5000),
  /** 0 = dimanche … 6 = samedi. Obligatoire sans webhook ni veille. */
  daysOfWeek: daysOfWeekSchema.optional(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  /** Rappel automatique toutes les N minutes DANS la fenêtre (0 = à l'heure de début). */
  intervalMinutes: z.number().int().min(0).max(1440).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  /** Déclencheur webhook entrant (l'agent s'exécute à l'événement). */
  enableWebhook: z.boolean().optional(),
  /** Sources de veille RSS/web qui déclenchent l'agent au changement. */
  watchSources: z
    .array(z.object({
      type: z.enum(["rss", "web"]),
      url: z.string().trim().url().max(2000),
      label: z.string().trim().max(120).optional(),
    }))
    .max(5)
    .optional(),
  /** Agent existant à utiliser (identifiant exact). Sinon résolution automatique. */
  agentId: z.string().trim().min(1).max(200).optional(),
});

const ListInputSchema = z.object({});

const UpdateInputSchema = z.object({
  scheduleId: z.string().trim().min(1).max(200).optional(),
  /** Ciblage tolérant par nom (extrait du message utilisateur). */
  name: z.string().trim().min(1).max(200).optional(),
  enable: z.boolean().optional(),
  objective: z.string().trim().min(3).max(5000).optional(),
  daysOfWeek: daysOfWeekSchema.optional(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  intervalMinutes: z.number().int().min(0).max(1440).optional(),
});

const DeleteInputSchema = z.object({
  scheduleId: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(200).optional(),
});

/** Résumé compact, affichable dans une réponse conversationnelle. */
function resumeSchedule(schedule: AgentSchedule) {
  return {
    id: schedule.id,
    name: schedule.name,
    objective: schedule.objective,
    enabled: schedule.enabled,
    timezone: schedule.timezone,
    daysOfWeek: schedule.daysOfWeek ?? null,
    startTime: schedule.startTime ?? null,
    endTime: schedule.endTime ?? null,
    intervalMinutes: schedule.intervalMinutes,
    webhook: Boolean(schedule.alwaysOnWebhookToken),
    watchSources: schedule.watchSources?.length ?? 0,
    lastExecutionStatus: schedule.lastExecutionStatus ?? null,
    lastExecutionAt: schedule.lastExecutionAt ?? null,
    nextRunAt: schedule.nextRunAt ?? null,
  };
}

const JOURS_LABELS: Record<number, string> = {
  0: "dimanche", 1: "lundi", 2: "mardi", 3: "mercredi", 4: "jeudi", 5: "vendredi", 6: "samedi",
};

export function labelJours(days: number[]): string {
  const tri = [...new Set(days)].sort((a, b) => a - b);
  if (tri.length === 7) return "tous les jours";
  if (tri.length === 5 && tri.join(",") === "1,2,3,4,5") return "du lundi au vendredi";
  if (tri.length === 2 && tri.join(",") === "0,6") return "le week-end";
  return tri.map((d) => JOURS_LABELS[d] ?? String(d)).join(", ");
}

export function describeRecurrence(schedule: {
  daysOfWeek?: number[];
  startTime?: string;
  endTime?: string;
  intervalMinutes: number;
  alwaysOnWebhookToken?: string;
  watchSources?: unknown[];
}): string {
  if (schedule.alwaysOnWebhookToken) return "déclenchement par webhook (à chaque événement entrant)";
  if ((schedule.watchSources?.length ?? 0) > 0) return "déclenchement par veille (RSS/web) au changement de contenu";
  const fenetre = schedule.startTime
    ? ` entre ${schedule.startTime} et ${schedule.endTime ?? "23:59"}`
    : "";
  const rappel = schedule.intervalMinutes > 0 ? `, rappel toutes les ${schedule.intervalMinutes} min` : "";
  const jours = schedule.daysOfWeek?.length ? labelJours(schedule.daysOfWeek) : "tous les jours";
  return `${jours}${fenetre}${rappel}`;
}

/** Résout l'agent d'exécution : existant précisé → premier actif pertinent → création dédiée. */
export async function resolveScheduleAgent(
  userId: string,
  agentId: string | undefined,
  objective: string,
): Promise<{ agent: AgentRecord; created: boolean }> {
  const { listAgentsByOwner, createAgentRecord } = await chargerRepository();
  if (agentId) {
    const agents = await listAgentsByOwner(userId);
    const found = agents.find((a) => a.id === agentId);
    if (!found) throw new Error("Agent introuvable pour ce compte.");
    if (found.status !== "active") throw new Error("Seul un agent actif peut être planifié.");
    return { agent: found, created: false };
  }

  const agents = (await listAgentsByOwner(userId)).filter((a) => a.status === "active");
  if (agents.length > 0) {
    const preferred =
      agents.find((a) => a.type === "automation") ??
      agents.find((a) => a.type === "universal") ??
      agents[0]!;
    return { agent: preferred, created: false };
  }

  const name = "Agent d'automatisation";
  const created = await createAgentRecord(userId, {
    name,
    description: "Agent créé automatiquement pour exécuter les tâches planifiées demandées en conversation.",
    type: "automation",
    typeLabel: "Automatisation",
    skills: ["planification", "exécution d'objectifs", "rapport"],
    agentMode: "standard",
    status: "active",
    voiceEnabled: false,
  });
  return { agent: created, created: true };
}

/** Utilitaire de ciblage tolérant : par id exact ou par nom (insensible à la casse). */
async function trouverSchedule(
  userId: string,
  target: { scheduleId?: string; name?: string },
): Promise<AgentSchedule> {
  const { listSchedules } = await chargerScheduler();
  const schedules = await listSchedules(userId);
  if (target.scheduleId) {
    const parId = schedules.find((s) => s.id === target.scheduleId);
    if (parId) return parId;
  }
  if (target.name?.trim()) {
    const needle = target.name.trim().toLowerCase();
    const parNom = schedules.find(
      (s) => s.name.toLowerCase().includes(needle) || needle.includes(s.name.toLowerCase()),
    );
    if (parNom) return parNom;
  }
  throw new Error(
    "Planification introuvable. Consultez vos tâches planifiées (schedule.list) pour retrouver le nom exact.",
  );
}

export const scheduleCreateTool: ToolDefinition<z.infer<typeof CreateInputSchema>> = {
  name: "schedule.create",
  description:
    "Crée une RÉELLE tâche planifiée : un agent s'exécutera automatiquement selon la récurrence demandée " +
    "(fenêtre horaire hebdomadaire, webhook ou veille RSS/web). " +
    'Input : { objective: "<ce que l\'agent doit faire à chaque exécution>", name?, daysOfWeek?: [1] (0=dimanche…6=samedi), startTime?: "09:00", endTime?: "10:00", intervalMinutes?, timezone?, enableWebhook?, watchSources?: [{type:"rss"|"web", url}], agentId? }. ' +
    "L'agent d'exécution est résolu automatiquement (premier agent actif, sinon un agent d'automatisation est créé).",
  category: "system",
  risk: "medium",
  inputSchema: CreateInputSchema,
  async execute(input, context) {
    const { createSchedule } = await chargerScheduler();
    const { agent } = await resolveScheduleAgent(context.userId, input.agentId, input.objective);
    const schedule = await createSchedule(context.userId, {
      agentId: agent.id,
      name: input.name?.trim() || input.objective.slice(0, 80),
      objective: input.objective,
      ...(input.daysOfWeek ? { daysOfWeek: input.daysOfWeek } : {}),
      ...(input.startTime ? { startTime: input.startTime } : {}),
      ...(input.endTime ? { endTime: input.endTime } : {}),
      ...(input.intervalMinutes !== undefined ? { intervalMinutes: input.intervalMinutes } : {}),
      timezone: input.timezone?.trim() || "UTC",
      enabled: true,
      ...(input.enableWebhook !== undefined ? { enableWebhook: input.enableWebhook } : {}),
      ...(input.watchSources ? { watchSourceInputs: input.watchSources } : {}),
    });
    return {
      created: true,
      schedule: resumeSchedule(schedule!),
      agent: { id: agent.id, name: agent.name },
      recurrence: describeRecurrence(schedule!),
    };
  },
};

export const scheduleListTool: ToolDefinition<z.infer<typeof ListInputSchema>> = {
  name: "schedule.list",
  description:
    "Liste les RÉELLES tâches planifiées du compte (nom, récurrence, statut, dernière exécution, agent).",
  category: "system",
  risk: "low",
  inputSchema: ListInputSchema,
  async execute(_input, context) {
    const { listSchedules } = await chargerScheduler();
    const schedules = await listSchedules(context.userId);
    return {
      count: schedules.length,
      schedules: schedules.slice(0, 20).map(resumeSchedule),
    };
  },
};

export const scheduleUpdateTool: ToolDefinition<z.infer<typeof UpdateInputSchema>> = {
  name: "schedule.update",
  description:
    "Modifie ou active/désactive une RÉELLE tâche planifiée existante. " +
    'Input : { scheduleId? ou name? (ciblage), enable?: true|false, objective?, daysOfWeek?, startTime?, endTime?, intervalMinutes? }. ' +
    "Au moins un champ à modifier est requis.",
  category: "system",
  risk: "medium",
  inputSchema: UpdateInputSchema,
  async execute(input, context) {
    const { updateSchedule } = await chargerScheduler();
    // Validation AVANT ciblage : aucun champ → aucun accès base nécessaire.
    const champFourni =
      input.enable !== undefined ||
      input.objective !== undefined ||
      input.daysOfWeek !== undefined ||
      input.startTime !== undefined ||
      input.endTime !== undefined ||
      input.intervalMinutes !== undefined;
    if (!champFourni) {
      throw new Error("Aucune modification fournie (enable/objective/daysOfWeek/startTime/endTime/intervalMinutes).");
    }
    const existante = await trouverSchedule(context.userId, input);
    const patch: Record<string, unknown> = {};
    if (input.enable !== undefined) patch.enabled = input.enable;
    if (input.objective !== undefined) patch.objective = input.objective;
    if (input.daysOfWeek !== undefined) patch.daysOfWeek = input.daysOfWeek;
    if (input.startTime !== undefined) patch.startTime = input.startTime;
    if (input.endTime !== undefined) patch.endTime = input.endTime;
    if (input.intervalMinutes !== undefined) patch.intervalMinutes = input.intervalMinutes;
    if (Object.keys(patch).length === 0) {
      throw new Error("Aucune modification fournie (enable/objective/daysOfWeek/startTime/endTime/intervalMinutes).");
    }
    const updated = await updateSchedule(context.userId, existante.id, patch);
    return {
      updated: true,
      schedule: resumeSchedule(updated!),
      recurrence: describeRecurrence(updated!),
    };
  },
};

export const scheduleDeleteTool: ToolDefinition<z.infer<typeof DeleteInputSchema>> = {
  name: "schedule.delete",
  description:
    "Supprime DÉFINITIVEMENT une tâche planifiée (l'automatisation récurrente s'arrête). Action sensible : validation humaine requise. " +
    "Input : { scheduleId? ou name? (ciblage) }.",
  category: "system",
  risk: "high",
  inputSchema: DeleteInputSchema,
  async execute(input, context) {
    const { deleteSchedule } = await chargerScheduler();
    const existante = await trouverSchedule(context.userId, input);
    await deleteSchedule(context.userId, existante.id);
    return { deleted: true, id: existante.id, name: existante.name };
  },
};
