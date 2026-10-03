import "server-only";

import { appendMessage } from "@/lib/chat/repository";
import { reconcileAgentRun } from "@/lib/agents/conversation-run";
import { buildFinalResponse } from "@/lib/agents/final-response";
import { deliverablesSection, extractDeliverables, type MissionDeliverable } from "@/lib/agents/deliverables";
import { createNotification } from "@/lib/notifications/repository";
import type { RuntimeExecutionState } from "@/lib/agents/runtime/types";

/**
 * LIVRAISON DE MISSION À LA CONVERSATION (exigence production : « il ne doit
 * s'arrêter que s'il a terminé et livré le résultat à l'utilisateur »).
 *
 * Toute mission runtime rattachée à une conversation — exécutée en synchrone
 * (chat) OU en arrière-plan via la file (mission-tick) — termine par CE
 * passage unique :
 *  1. texte final HONNÊTE construit depuis les statuts réels (jamais la
 *     promesse du modèle) ;
 *  2. manifest des livrables réels (artefacts, fichiers) listé dans le
 *     message ;
 *  3. run conversationnel réconcilié (timeline + payload) ;
 *  4. message assistant persisté sur le fil (visible au retour, onglet
 *     fermé, actualisé ou supprimé) ;
 *  5. notification in-app de livraison pour les missions en file.
 *
 * Best-effort total : un incident de livraison ne condamne jamais le travail
 * déjà accompli (le checkpoint reste la vérité du travail).
 */

export interface MissionDeliveryResult {
  finalText?: string;
  deliverables: MissionDeliverable[];
  messageId?: string;
}

export async function deliverMissionToConversation(input: {
  userId: string;
  conversationId: string;
  state: Pick<RuntimeExecutionState, "plan" | "outputs" | "status" | "error" | "outcomeVerification" | "observations" | "billing">;
  projectId?: string;
  /** true = mission exécutée en arrière-plan (file) → notification de livraison. */
  background?: boolean;
  /** Remplace le texte final calculé (cas HITL : attente de confirmation). */
  overrideClosingText?: string;
  /** Run pré-existant (créé avant exécution) : lié au message final pour la timeline inline. */
  runId?: string;
}): Promise<MissionDeliveryResult> {
  const { state } = input;
  const deliverables = extractDeliverables(state.plan, state.outputs ?? {});
  const finalText = buildFinalResponse(
    state.plan,
    state.outputs ?? {},
    { ...(state.outcomeVerification ? { outcome: state.outcomeVerification } : {}) },
  ).text + deliverablesSection(deliverables);

  const closingText = input.overrideClosingText
    ? input.overrideClosingText
    : state.status === "completed"
      ? finalText
      : `${finalText}\n\nL'exécution a été interrompue : ${state.error ?? "erreur inconnue"}. Les étapes réussies et leurs résultats restent conservés — reprenez quand vous voulez.`;

  // 3) Run conversationnel réconcilié (créé s'il n'existe pas encore).
  try {
    await reconcileAgentRun({
      userId: input.userId,
      conversationId: input.conversationId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      plan: state.plan,
      status: state.status,
      outputs: state.outputs,
      observations: state.observations,
      billing: state.billing,
      finalText: state.status === "completed" ? finalText : undefined,
      error: state.error,
    });
  } catch { /* fail-soft : la mission reste lisible via le checkpoint */ }

  // 4) Message final persisté sur le fil (lié au run pour la timeline).
  let messageId: string | undefined;
  try {
    const message = await appendMessage({
      conversationId: input.conversationId,
      userId: input.userId,
      role: "assistant",
      content: closingText,
      ...(input.runId ? { runId: input.runId } : {}),
    });
    messageId = message.id;
  } catch { /* fail-soft */ }

  // 5) Notification de livraison (missions arrière-plan : l'utilisateur
  //    n'attend plus devant le chat — il est prévenu où qu'il soit).
  if (input.background) {
    await createNotification({
      userId: input.userId,
      type: "info",
      title: state.status === "completed" ? "Mission livrée" : state.status === "failed" ? "Mission terminée avec des étapes en échec" : `Mission ${state.status}`,
      body: `${state.plan.objective.slice(0, 160)}${deliverables.length > 0 ? ` — ${deliverables.length} livrable(s) remis(s).` : ""}`,
      kind: "conversation",
      conversationId: input.conversationId,
      executionId: state.plan.executionId,
    }).catch(() => undefined);
  }

  return { finalText: state.status === "completed" ? finalText : undefined, deliverables, messageId };
}
