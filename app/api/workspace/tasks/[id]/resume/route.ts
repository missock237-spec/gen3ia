import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { resumeWorkspaceTask } from "@/lib/agents/workspace";
import { AgentRuntime } from "@/lib/agents/runtime/runner";
import { DEFAULT_EXECUTION_POLICY } from "@/lib/security/execution-policy";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Reprise d'une tâche en pause.
 *
 * Par défaut, la reprise est ACTIVE : le contrôle de pause est levé puis
 * l'exécution continue immédiatement (le plan persisté conserve les étapes
 * complétées — le planificateur DAG saute le terminé et reprend les étapes
 * restantes). `continue: false` se contente de lever la pause (reprise
 * manuelle via la route d'exécution habituelle).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const limit = await enforceRateLimit(`workspace-resume:${user.uid}`, { limit: 12, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de reprises rapprochées. Réessayez dans quelques minutes." }, { status: 429 });

    const body = await request.json().catch(() => ({}));
    const continueExecution = body?.continue !== false;

    const task = await resumeWorkspaceTask(user.uid, id);

    if (!continueExecution) {
      return NextResponse.json({
        success: true,
        task,
        message: "Pause levée : relancez l'exécution pour continuer les étapes restantes.",
      });
    }

    if (!task.plan) return NextResponse.json({ error: "La tâche ne possède aucun plan exécutable." }, { status: 409 });

    const taskRef = adminDb.collection("agentWorkspaceTasks").doc(id);
    const claimed = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(taskRef);
      if (!snap.exists || snap.get("ownerId") !== user.uid) throw new Error("Task not found.");
      if (snap.get("status") !== "approved") return false;
      tx.update(taskRef, { status: "running", updatedAt: FieldValue.serverTimestamp() });
      return true;
    });
    if (!claimed) return NextResponse.json({ error: "La tâche n'est plus reprenable (état modifié entre-temps)." }, { status: 409 });

    try {
      const runtime = new AgentRuntime({
        userId: user.uid,
        objective: task.objective,
        plan: task.plan,
        policy: DEFAULT_EXECUTION_POLICY,
        signal: request.signal,
      });
      const state = await runtime.run();
      await taskRef.update({
        plan: state.plan,
        status: state.status === "completed" ? "completed" : state.status === "paused" ? "paused" : "failed",
        ...(state.status === "paused" ? {} : { completedAt: FieldValue.serverTimestamp() }),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return NextResponse.json({
        success: state.status === "completed",
        executionId: state.executionId,
        status: state.status,
        outputs: state.outputs,
        observations: state.observations,
        billing: state.billing,
      });
    } catch (error) {
      await taskRef.update({ status: "failed", updatedAt: FieldValue.serverTimestamp() });
      throw error;
    }
  } catch (error) {
    if (error instanceof Error && /Task not found|peut être reprise/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(errorBody(error, "Reprise impossible."), { status: errorStatus(error) });
  }
}
