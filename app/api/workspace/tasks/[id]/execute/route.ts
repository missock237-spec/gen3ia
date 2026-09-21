import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimit } from "@/lib/security/rate-limit";
import { AgentRuntime } from "@/lib/agents/runtime/runner";
import { DEFAULT_EXECUTION_POLICY } from "@/lib/security/execution-policy";
import { getWorkspaceTask } from "@/lib/agents/workspace";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";

const BodySchema = z.object({}).optional();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const user = await requireUser(request);
  const { id } = await params;
  const limit = rateLimit(`workspace-execute:${user.uid}`, { limit: 6, windowMs: 5 * 60 * 1000 });
  if (!limit.allowed) return NextResponse.json({ error: "Trop d'exécutions rapprochées. Réessayez dans quelques minutes." }, { status: 429 });

  try {
    BodySchema.parse(await request.json().catch(() => ({})));
    const task = await getWorkspaceTask(user.uid, id);
    if (task.status !== "approved") {
      return NextResponse.json({ error: "La tâche doit être approuvée avant son exécution." }, { status: 409 });
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
    if (!claimed) return NextResponse.json({ error: "Cette tâche est déjà en cours ou n'est plus approuvée." }, { status: 409 });

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
        status: state.status === "completed" ? "completed" : "failed",
        completedAt: FieldValue.serverTimestamp(),
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
    // Erreurs métier (tâche non approuvée, plan manquant, "Task not found") :
    // statut 4xx précis plutôt qu'un 500 générique.
    if (error instanceof Error && /Task not found|doit être approuvée|aucun plan/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
  } catch (error) {
    return NextResponse.json(errorBody(error, "Execution impossible."), { status: errorStatus(error) });
  }
}
