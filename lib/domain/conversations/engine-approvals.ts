import "server-only";

/**
 * Exécution/refus d'une étape approuvée (validation humaine inline). Extrait de engine.ts — code déplacé tel quel.
 */

import type { ConversationApproval, ConversationArtifact, ConversationRun, RunStatus, RunStep } from "./types";
import { recordRunOutcome } from "@/lib/ai/auto-improvement";
import { finalizeRun, makeStep, updateRunSteps } from "@/lib/domain/runs/repository";
import { executeTool } from "@/lib/tools/executor";
import { TOOL_OUTPUT_ARTIFACTS, artifactFromToolOutput } from "./engine-plan";
import { CONVERSATION_EXECUTION_POLICY, condenseToolOutput } from "./engine-tools";

/* ------------------------------------------------------------------ */
/* Exécution d'une étape approuvée                                     */
/* ------------------------------------------------------------------ */

export interface ApprovedStepOutcome {
  step: RunStep;
  artifact?: ConversationArtifact;
  summary: string;
}

/** Exécute l'étape d'un run correspondant à une validation approuvée. */
export async function executeApprovedStep(params: {
  userId: string;
  conversationId: string;
  run: ConversationRun;
  approval: ConversationApproval;
}): Promise<ApprovedStepOutcome> {
  const { run, approval } = params;
  const steps = run.steps;
  const stepIndex = steps.findIndex((s) => s.id === approval.stepId);
  if (stepIndex === -1) throw new Error("Étape du run introuvable pour cette validation.");

  const step = steps[stepIndex];
  step.status = "in_progress";
  step.startedAt = new Date().toISOString();
  steps[stepIndex] = step;
  await updateRunSteps(params.userId, run.id, steps);

  const result = await executeTool({
    userId: params.userId,
    executionId: run.id,
    projectId: run.projectId,
    toolName: approval.toolName,
    input: (step.toolInput ?? {}) as Record<string, unknown>,
    policy: CONVERSATION_EXECUTION_POLICY,
  });

  step.finishedAt = new Date().toISOString();
  if (result.success) {
    step.status = "done";
    step.output = condenseToolOutput(result.output);
  } else {
    step.status = "failed";
    step.output = result.error;
  }

  let artifact: ConversationArtifact | undefined;
  if (result.success && TOOL_OUTPUT_ARTIFACTS.has(approval.toolName)) {
    const created = await artifactFromToolOutput({
      userId: params.userId,
      conversationId: params.conversationId,
      projectId: run.projectId,
      runId: run.id,
      toolName: approval.toolName,
      toolInput: (step.toolInput ?? {}) as Record<string, unknown>,
      output: result.output,
    });
    if (created) {
      artifact = created;
      step.artifactId = created.id;
    }
  }

  // Toutes les validations traitées ? On clôture le run.
  const remaining = steps.filter((s) => s.status === "awaiting");
  const hasFailure = steps.some((s) => s.status === "failed");
  // Statut HOISTÉ : il est utilisé par finalizeRun ET par recordRunOutcome
  // (bug historique : `const status` déclaré dans le bloc `if` puis lu
  // hors du bloc — ReferenceError à l'exécution, l'action s'exécutait mais
  // l'approbation « échouait » après coup : « Décision impossible. »).
  const status: RunStatus = hasFailure ? "failed" : "completed";
  if (remaining.length === 0) {
    steps.push(
      makeStep({
        phase: "result",
        title: "Résultat",
        detail: result.success ? "Action validée exécutée avec succès." : "Action validée en échec.",
        status: "done",
      }),
    );
    await finalizeRun(params.userId, run.id, status, steps);
  } else {
    await updateRunSteps(params.userId, run.id, steps);
  }
  // AUTO-AMÉLIORATION : issue de l'action validée enregistrée.
  void recordRunOutcome({
    userId: params.userId,
    objective: approval.title,
    status,
    failedSteps: result.success ? [] : [{ title: approval.title, detail: result.error }],
  }).catch(() => undefined);

  const summary = result.success
    ? `Action exécutée : ${approval.title}${step.output ? `\n\n${step.output.slice(0, 600)}` : ""}`
    : `L'action « ${approval.title} » a échoué : ${result.error ?? "erreur inconnue"}`;

  return { step, artifact, summary };
}

/** Marque l'étape d'une validation rejetée comme ignorée et clôture si besoin. */
export async function rejectApprovalStep(params: {
  userId: string;
  run: ConversationRun;
  approval: ConversationApproval;
}): Promise<void> {
  const { run, approval } = params;
  const steps = run.steps;
  const stepIndex = steps.findIndex((s) => s.id === approval.stepId);
  if (stepIndex >= 0) {
    const step = steps[stepIndex];
    step.status = "skipped";
    step.detail = `${step.detail ? `${step.detail}\n` : ""}Rejeté par l'utilisateur le ${new Date().toISOString()}.`;
    steps[stepIndex] = step;
  }
  const remaining = steps.filter((s) => s.status === "awaiting");
  if (remaining.length === 0) {
    steps.push(
      makeStep({
        phase: "result",
        title: "Résultat",
        detail: "Action rejetée par l'utilisateur — aucune donnée n'a été envoyée.",
        status: "done",
      }),
    );
    await finalizeRun(params.userId, run.id, "completed", steps);
  } else {
    await updateRunSteps(params.userId, run.id, steps);
  }
}
