import "server-only";

/**
 * Sous-services sous autorité de l'agent IA : tâches planifiées, workflows, pilotage d'agents — exécutés via les outils réels. Extrait de engine.ts — code déplacé tel quel.
 */

import type { AgentIntent } from "./agent-intents";
import type { ScheduleIntent, ServiceControlIntent, WorkflowIntent } from "./service-intents";
import { safeEmitter } from "./stream-events";
import { buildQuickCreatePayload } from "@/lib/agents/quick-create";
import { createAgentRecord, deleteAgentForUser, listAgentsForUser, toSummary, updateAgentForUser } from "@/lib/agents/repository";
import { AgentRecordSchema } from "@/lib/agents/schema";
import { resolveAndHarden } from "@/lib/agents/tool-resolver";
import { appendMessage } from "@/lib/chat/repository";
import { executeTool } from "@/lib/tools/executor";
import { runChatTurn } from "./engine-chat";
import type { TurnBase } from "./engine-chat";
import type { TurnIntent } from "./engine-intent";
import { runPlanTurn } from "./engine-plan";
import { CONVERSATION_EXECUTION_POLICY } from "./engine-tools";
import type { ConversationTurnResult } from "./engine-turn";

/* ------------------------------------------------------------------ */
/* Tours « sous-services sous autorité de l'agent » — tâches planifiées */
/* et workflows : créés/pilotés RÉELLEMENT depuis le langage naturel.   */
/* ------------------------------------------------------------------ */

const TZ_FALLBACK = "UTC";

interface ServiceTurnContext extends TurnBase {
  timezone?: string;
}

/** Exécute un outil via l'exécuteur standard (politique, audit, quotas). */
async function executerOutilService(
  ctx: TurnBase,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ ok: true; output: unknown } | { ok: false; error: string }> {
  try {
    const result = await executeTool({
      userId: ctx.userId,
      executionId: `conv_${ctx.conversationId}`,
      projectId: ctx.projectId,
      toolName,
      input,
      policy: CONVERSATION_EXECUTION_POLICY,
    });
    if (!result.success) {
      return { ok: false, error: result.error ?? "Exécution impossible." };
    }
    return { ok: true, output: result.output };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Exécution impossible." };
  }
}

function labelJoursFr(days: number[]): string {
  const tri = [...new Set(days)].sort((a, b) => a - b);
  if (tri.length === 7) return "tous les jours";
  if (tri.join(",") === "1,2,3,4,5") return "du lundi au vendredi";
  if (tri.join(",") === "0,6") return "le week-end";
  const noms = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  return tri.map((d) => noms[d] ?? String(d)).join(", ");
}

export async function runScheduleIntentTurn(
  ctx: ServiceTurnContext,
  intent: ScheduleIntent,
): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  await onEvent({ type: "status", phase: "execution", label: "Mise en place de votre tâche planifiée…" });

  const resultat = await executerOutilService(ctx, "schedule.create", {
    name: intent.name,
    objective: intent.objective,
    daysOfWeek: intent.daysOfWeek,
    startTime: intent.startTime,
    endTime: intent.endTime,
    ...(intent.intervalMinutes !== undefined ? { intervalMinutes: intent.intervalMinutes } : {}),
    timezone: ctx.timezone?.trim() || TZ_FALLBACK,
  });

  const tz = ctx.timezone?.trim() || TZ_FALLBACK;
  const content = resultat.ok
    ? (() => {
        const output = resultat.output as {
          schedule?: { id: string; name: string };
          agent?: { name: string };
          recurrence?: string;
        };
        const schedule = output.schedule;
        const recurrence = output.recurrence ?? labelJoursFr(intent.daysOfWeek);
        return [
          `Tâche planifiée créée : « ${schedule?.name ?? intent.name} »`,
          `- Récurrence : ${recurrence}${intent.startTime ? ` (fenêtre ${intent.startTime} → ${intent.endTime})` : ""}${intent.intervalMinutes ? `, rappel toutes les ${intent.intervalMinutes} minutes` : ""}`,
          `- Fuseau : ${tz}`,
          `- Agent d'exécution : ${output.agent?.name ?? "résolu automatiquement"}`,
          `- Objectif : ${intent.objective.slice(0, 200)}`,
          "",
          "L'agent s'exécutera automatiquement selon cette récurrence (moteur de planification réel). Pour ajuster : « change l'heure de ma tâche planifiée… », « désactive ma tâche… » ou « supprime la tâche planifiée… ».",
        ].join("\n");
      })()
    : `Je n'ai pas pu créer la tâche planifiée : ${resultat.error}`;

  const assistantMessage = await appendMessage({
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    role: "assistant",
    content,
    generationStatus: resultat.ok ? "complete" : "failed",
  });
  await onEvent({ type: "message_complete", message: assistantMessage });
  return {
    conversationId: ctx.conversationId,
    userMessage: ctx.userMessage,
    assistantMessage,
    artifacts: [],
    approvals: [],
    intent: { mode: "chat", understanding: "Création réelle d'une tâche planifiée (langage naturel)." },
  };
}

export async function runWorkflowIntentTurn(
  ctx: ServiceTurnContext,
  intent: WorkflowIntent,
): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  await onEvent({ type: "status", phase: "execution", label: "Construction de votre workflow…" });

  const resultat = await executerOutilService(ctx, "workflow.create", {
    name: intent.name,
    objective: intent.objective,
    steps: intent.steps,
    ...(intent.runNow ? { runNow: true } : {}),
  });

  const content = resultat.ok
    ? (() => {
        const output = resultat.output as {
          id: string;
          name: string;
          nodeCount: number;
          steps?: string[];
          run?: { runId: string; status: string; result?: unknown; error?: string };
        };
        const lignes = [
          `Workflow créé : « ${output.name} » (${output.nodeCount} nœuds, exécutable)`,
          ...intent.steps.map((step, index) => `- Étape ${index + 1} : ${step.name}`),
          "",
          "Il est enregistré dans votre espace : lancez-le depuis la conversation (« exécute le workflow … »), ou modifiez-le dans le Studio.",
        ];
        if (output.run) {
          lignes.push("", `Exécution immédiate : statut ${output.run.status}${output.run.result !== undefined ? ` — résultat : ${JSON.stringify(output.run.result).slice(0, 600)}` : ""}${output.run.error ? ` — erreur : ${output.run.error.slice(0, 300)}` : ""}`);
        }
        return lignes.join("\n");
      })()
    : `Je n'ai pas pu créer le workflow : ${resultat.error}`;

  const assistantMessage = await appendMessage({
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    role: "assistant",
    content,
    generationStatus: resultat.ok ? "complete" : "failed",
  });
  await onEvent({ type: "message_complete", message: assistantMessage });
  return {
    conversationId: ctx.conversationId,
    userMessage: ctx.userMessage,
    assistantMessage,
    artifacts: [],
    approvals: [],
    intent: { mode: "chat", understanding: "Création réelle d'un workflow (langage naturel)." },
  };
}

/**
 * Agents sous commande de l'IA : création, liste, activation, désactivation
 * et suppression d'agents RÉELS depuis le langage naturel. Mêmes services
 * que le Studio (buildQuickCreatePayload → AgentRecordSchema →
 * resolveAndHarden → createAgentRecord) : ce qui est créé en base reprend
 * exactement la demande énoncée, aucune compétence n'est inventée.
 */
export async function runAgentIntentTurn(
  ctx: ServiceTurnContext,
  intent: AgentIntent,
): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);

  /* ---------- Création ---------- */
  if (intent.action === "create") {
    await onEvent({ type: "status", phase: "execution", label: "Création de votre agent…" });
    let content: string;
    let ok = false;
    try {
      const payload = buildQuickCreatePayload({
        name: intent.name,
        typeKey: intent.typeKey,
        ...(intent.customType ? { customType: intent.customType } : {}),
      });
      const parsed = AgentRecordSchema.safeParse(payload);
      if (!parsed.success) {
        content = "Je n'ai pas pu créer l'agent : les paramètres déduits de votre demande sont incomplets. Précisez un nom et un type (ex. « crée un agent commercial nommé Alex »).";
      } else {
        const { resolution, hardening } = resolveAndHarden(parsed.data.tools, parsed.data.authorizationMode);
        const record = await createAgentRecord(ctx.userId, {
          ...parsed.data,
          tools: resolution.resolved,
          authorizationMode: hardening.mode,
        });
        ok = true;
        content = [
          `Agent créé : « ${record.name} » (${record.typeLabel})`,
          `- Compétences : ${record.skills.slice(0, 6).join(", ") || "polyvalence"}`,
          `- Outils : ${record.tools.slice(0, 6).join(", ") || "aucun outil déclaré"}`,
          `- Statut : ${record.status}`,
          "",
          "Il est enregistré dans votre espace : sélectionnez-le dans le sélecteur d'agents du composer (Gen IA ⇄ agents) pour lui confier vos demandes, ou dites simplement « utilise l'agent … ».",
        ].join("\n");
      }
    } catch (error) {
      content = `Je n'ai pas pu créer l'agent : ${error instanceof Error ? error.message : "erreur inattendue"}.`;
    }

    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content,
      generationStatus: ok ? "complete" : "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Création réelle d'un agent (langage naturel)." },
    };
  }

  /* ---------- Liste ---------- */
  if (intent.action === "list") {
    await onEvent({ type: "status", phase: "execution", label: "Consultation de vos agents…" });
    let content: string;
    try {
      const agents = await listAgentsForUser(ctx.userId);
      if (agents.length === 0) {
        content = "Vous n'avez aucun agent pour l'instant. Dites simplement « crée-moi un agent … » (ex. « crée un agent commercial nommé Alex ») et je le crée réellement.";
      } else {
        content = [
          `Vos agents (${agents.length}) :`,
          ...agents.slice(0, 12).map((a) => {
            const s = toSummary(a);
            return `- ${s.name} — ${s.typeLabel}${s.status !== "active" ? ` (${s.status})` : ""} : ${s.description.slice(0, 100)}`;
          }),
          "",
          "Pour dialoguer avec l'un d'eux : sélecteur d'agents du composer, ou « utilise l'agent … ». Pour gérer : « active l'agent … », « désactive l'agent … », « supprime l'agent … ».",
        ].join("\n");
      }
    } catch {
      content = "Je n'ai pas pu consulter vos agents (stockage indisponible). Réessayez dans un instant.";
    }

    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content,
      generationStatus: "complete",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Liste réelle des agents (langage naturel)." },
    };
  }

  /* ---------- Activation / désactivation / suppression ----------
   * La cible est résolue par nom EXACT (insensible à la casse) parmi les
   * agents de l'utilisateur — aucune correspondance floue : en cas
   * d'ambiguïté, la liste est renvoyée et l'utilisateur précise. */
  if (intent.action === "enable" || intent.action === "disable" || intent.action === "delete") {
    await onEvent({ type: "status", phase: "execution", label: "Recherche de l'agent ciblé…" });
    let content: string;
    let ok = false;
    try {
      const agents = await listAgentsForUser(ctx.userId);
      const nom = intent.name?.trim().toLowerCase();
      const cible = nom
        ? agents.find((a) => a.name.trim().toLowerCase() === nom)
        : undefined;

      if (!nom) {
        content = agents.length === 0
          ? "Vous n'avez aucun agent pour l'instant."
          : `Quel agent concerne votre demande ? Vos agents : ${agents.slice(0, 8).map((a) => `« ${a.name} »`).join(", ")}.`;
      } else if (!cible) {
        content = agents.length === 0
          ? `Je ne trouve aucun agent : votre espace n'en contient pas (rien n'a été ${intent.action === "delete" ? "supprimé" : "modifié"}).`
          : `Aucun agent nommé exactement « ${intent.name} ». Vos agents : ${agents.slice(0, 8).map((a) => `« ${a.name} »`).join(", ")}. Rien n'a été ${intent.action === "delete" ? "supprimé" : "modifié"}.`;
      } else if (intent.action === "delete") {
        const supprimé = await deleteAgentForUser(ctx.userId, cible.id);
        ok = supprimé;
        content = supprimé
          ? `Agent « ${cible.name} » supprimé définitivement.`
          : `Je n'ai pas pu supprimer « ${cible.name} » (opération refusée par le stockage).`;
      } else {
        const statut = intent.action === "enable" ? "active" : "paused";
        const maj = await updateAgentForUser(ctx.userId, cible.id, { status: statut });
        ok = Boolean(maj);
        content = maj
          ? `Agent « ${cible.name} » ${intent.action === "enable" ? "réactivé" : "mis en pause"} (statut : ${maj.status}).`
          : `Je n'ai pas pu modifier « ${cible.name} » (opération refusée par le stockage).`;
      }
    } catch (error) {
      content = `Je n'ai pas pu ${intent.action === "delete" ? "supprimer" : intent.action === "enable" ? "activer" : "désactiver"} l'agent : ${error instanceof Error ? error.message : "erreur inattendue"}.`;
    }

    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content,
      generationStatus: ok || intent.action !== "delete" ? "complete" : "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: `Gestion réelle d'un agent : ${intent.action} (langage naturel).` },
    };
  }

  // Exhaustivité TypeScript (action couverte ci-dessus).
  return runChatTurn({ ...ctx, intent: { mode: "chat", understanding: "Demande d'agent non résolue." } });
}

export async function runServiceControlTurn(
  ctx: ServiceTurnContext,
  controle: ServiceControlIntent,
): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  const tz = ctx.timezone?.trim() || TZ_FALLBACK;

  // Suppression : action définitive → plan avec validation humaine (HITL).
  if (controle.action === "delete") {
    const toolName = controle.target === "schedule" ? "schedule.delete" : "workflow.delete";
    const intent: TurnIntent = {
      mode: "plan",
      understanding:
        controle.target === "schedule"
          ? "Suppression d'une tâche planifiée (validation humaine requise)."
          : "Suppression d'un workflow (validation humaine requise).",
      objective: `Supprimer ${controle.name ? `« ${controle.name} »` : "l'élément ciblé"}`,
      steps: [
        {
          title: `Supprimer ${controle.target === "schedule" ? "la tâche planifiée" : "le workflow"}${controle.name ? ` « ${controle.name} »` : ""}`,
          detail: "Action définitive — arrête l'automatisation récurrente correspondante.",
          toolName,
          toolInput: controle.name ? { name: controle.name } : {},
          sensitive: true,
        },
      ],
    };
    return runPlanTurn({ ...ctx, intent });
  }

  // Liste des tâches planifiées.
  if (controle.target === "schedule" && controle.action === "list") {
    await onEvent({ type: "status", phase: "execution", label: "Consultation de vos tâches planifiées…" });
    const resultat = await executerOutilService(ctx, "schedule.list", {});
    const content = !resultat.ok
      ? `Impossible de consulter vos tâches planifiées : ${resultat.error}`
      : (() => {
          const output = resultat.output as {
            count: number;
            schedules: Array<{
              name: string; enabled: boolean; daysOfWeek: number[] | null;
              startTime: string | null; endTime: string | null; intervalMinutes: number;
              lastExecutionStatus: string | null;
            }>;
          };
          if (output.count === 0) {
            return "Vous n'avez aucune tâche planifiée pour le moment. Dites-moi par exemple : « chaque lundi à 9h, prépare-moi un rapport des actualités IA » et je la mets en place.";
          }
          return [
            `Vos tâches planifiées (${output.count}) :`,
            ...output.schedules.map((s) => {
              const recurrence = s.daysOfWeek?.length ? labelJoursFr(s.daysOfWeek) : "tous les jours";
              const fenetre = s.startTime ? ` (${s.startTime} → ${s.endTime ?? "23:59"}${s.intervalMinutes ? `, toutes les ${s.intervalMinutes} min` : ""})` : "";
              const dernier = s.lastExecutionStatus ? ` — dernière exécution : ${s.lastExecutionStatus}` : "";
              return `- ${s.enabled ? "●" : "○"} « ${s.name} » — ${recurrence}${fenetre}${dernier}`;
            }),
          ].join("\n");
        })();
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId, userId: ctx.userId, role: "assistant", content,
      generationStatus: resultat.ok ? "complete" : "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId, userMessage: ctx.userMessage, assistantMessage,
      artifacts: [], approvals: [],
      intent: { mode: "chat", understanding: "Liste des tâches planifiées." },
    };
  }

  // Liste des workflows.
  if (controle.target === "workflow" && controle.action === "list") {
    await onEvent({ type: "status", phase: "execution", label: "Consultation de vos workflows…" });
    const resultat = await executerOutilService(ctx, "workflow.list", {});
    const content = !resultat.ok
      ? `Impossible de consulter vos workflows : ${resultat.error}`
      : (() => {
          const output = resultat.output as { count: number; workflows: Array<{ name: string; nodeCount: number }> };
          if (output.count === 0) {
            return "Vous n'avez aucun workflow pour le moment. Dites-moi par exemple : « crée un workflow : étape 1 : recherche les tendances, étape 2 : rédige un résumé » et je le construis.";
          }
          return [
            `Vos workflows (${output.count}) :`,
            ...output.workflows.map((w) => `- « ${w.name} » (${w.nodeCount} nœuds)`),
            "",
            "Pour en exécuter un : « exécute le workflow … ».",
          ].join("\n");
        })();
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId, userId: ctx.userId, role: "assistant", content,
      generationStatus: resultat.ok ? "complete" : "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId, userMessage: ctx.userMessage, assistantMessage,
      artifacts: [], approvals: [],
      intent: { mode: "chat", understanding: "Liste des workflows." },
    };
  }

  // Activation / désactivation d'une tâche planifiée.
  if (controle.target === "schedule" && (controle.action === "enable" || controle.action === "disable")) {
    await onEvent({
      type: "status", phase: "execution",
      label: controle.action === "enable" ? "Activation de la tâche planifiée…" : "Désactivation de la tâche planifiée…",
    });
    const input: Record<string, unknown> = { enable: controle.action === "enable" };
    if (controle.name) input.name = controle.name;
    const resultat = await executerOutilService(ctx, "schedule.update", input);
    const content = resultat.ok
      ? (() => {
          const output = resultat.output as { schedule?: { name: string; enabled: boolean } };
          return `Tâche planifiée « ${output.schedule?.name ?? controle.name ?? ""} » ${output.schedule?.enabled ? "réactivée" : "désactivée"} — ${output.schedule?.enabled ? "elle reprendra sa récurrence" : "elle ne s'exécutera plus"} (fuseau ${tz}).`;
        })()
      : `Je n'ai pas pu modifier la tâche planifiée : ${resultat.error}`;
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId, userId: ctx.userId, role: "assistant", content,
      generationStatus: resultat.ok ? "complete" : "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId, userMessage: ctx.userMessage, assistantMessage,
      artifacts: [], approvals: [],
      intent: { mode: "chat", understanding: "Pilotage d'une tâche planifiée." },
    };
  }

  // Exécution d'un workflow existant.
  if (controle.target === "workflow" && controle.action === "run") {
    await onEvent({ type: "status", phase: "execution", label: "Exécution du workflow…" });
    const input: Record<string, unknown> = {};
    if (controle.name) input.name = controle.name;
    const resultat = await executerOutilService(ctx, "workflow.run", input);
    const content = resultat.ok
      ? (() => {
          const output = resultat.output as { runId: string; status: string; workflow?: { name: string }; result?: unknown; error?: string };
          return [
            `Workflow « ${output.workflow?.name ?? controle.name ?? ""} » exécuté — statut : ${output.status}.`,
            output.result !== undefined ? `Résultat : ${JSON.stringify(output.result).slice(0, 1200)}` : "",
            output.error ? `Erreur : ${output.error.slice(0, 500)}` : "",
          ].filter(Boolean).join("\n");
        })()
      : `Je n'ai pas pu exécuter le workflow : ${resultat.error}`;
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId, userId: ctx.userId, role: "assistant", content,
      generationStatus: resultat.ok ? "complete" : "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId, userMessage: ctx.userMessage, assistantMessage,
      artifacts: [], approvals: [],
      intent: { mode: "chat", understanding: "Exécution réelle d'un workflow." },
    };
  }

  // Repli : le cas n'est pas géré en conversation → tour normal.
  return runChatTurn({ ...ctx, intent: { mode: "chat", understanding: "Demande générique." } });
}
