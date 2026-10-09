import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { AgentRuntime } from "@/lib/agents/runtime/runner";
import { isExecutionStopRequested } from "@/lib/agents/runtime/pause";
import { DEFAULT_EXECUTION_POLICY } from "@/lib/security/execution-policy";
import { getWorkspaceTask } from "@/lib/agents/workspace";
import { enqueueMissionContinuation } from "@/lib/queue/mission-continuation";
import { adminDb } from "@/lib/firebase/admin";
import { runFirestoreGuarded } from "@/lib/queue/firestore-guard";
import { DocumentReference, FieldValue } from "firebase-admin/firestore";

/**
 * GARDE QUOTA (Task 110-e) : le claim transactionnel et les mises à jour de
 * statut de la tâche workspace sont des écritures Firestore BRUTES sur un
 * chemin utilisateur (exécution/reprise d'une tâche de l'agent) — sous
 * quota quotidien épuisé elles pendaient SANS lever (Task 97) et retenaient
 * la requête jusqu'au kill maxDuration 300. runFirestoreGuarded (lib/queue/
 * firestore-guard, partagé avec la file de missions 110-d) borne chaque
 * touche à 6 s + disjoncteur : échec rapide quota-classifié (503
 * actionnable via errorStatus), sémantique de claim inchangée.
 */
const claimTask = (taskRef: DocumentReference, uid: string) =>
  runFirestoreGuarded(`workspace task claim ${taskRef.id}`, () => adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists || snap.get("ownerId") !== uid) throw new Error("Task not found.");
    if (snap.get("status") !== "approved") return false;
    tx.update(taskRef, { status: "running", updatedAt: FieldValue.serverTimestamp() });
    return true;
  }));

export const runtime = "nodejs";
// Fenêtre bornée pour le repli synchrone : l'échéance de tranche coupe la
// mission PROPREMENT avant la fin de fenêtre et la suite part en file.
export const maxDuration = 300;
const TASK_SYNC_BUDGET_MS = 290_000;

const BodySchema = z.object({}).optional();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const user = await requireUser(request);
  const { id } = await params;
  const limit = await enforceRateLimit(`workspace-execute:${user.uid}`, { limit: 6, windowMs: 5 * 60 * 1000 });
  if (!limit.allowed) return NextResponse.json({ error: "Trop d'exécutions rapprochées. Réessayez dans quelques minutes." }, { status: 429 });

  try {
    BodySchema.parse(await request.json().catch(() => ({})));
    const task = await getWorkspaceTask(user.uid, id);
    if (task.status !== "approved") {
      return NextResponse.json({ error: "La tâche doit être approuvée avant son exécution." }, { status: 409 });
    }
    if (!task.plan) return NextResponse.json({ error: "La tâche ne possède aucun plan exécutable." }, { status: 409 });

    const taskRef = adminDb.collection("agentWorkspaceTasks").doc(id);
    const claimed = await claimTask(taskRef, user.uid);
    if (!claimed) return NextResponse.json({ error: "Cette tâche est déjà en cours ou n'est plus approuvée." }, { status: 409 });

    try {
      const runtime = new AgentRuntime({
        userId: user.uid,
        objective: task.objective,
        plan: task.plan,
        policy: DEFAULT_EXECUTION_POLICY,
        // PAS de signal requête (exigence production) : l'utilisateur qui
        // rafraîchit ou ferme l'onglet n'exprime PAS un arrêt — l'exécution
        // continue serveur jusqu'à sa borne de tranche. L'arrêt explicite
        // passe par les contrôles pause/stop (routes dédiées).
        batchDeadlineMs: Date.now() + TASK_SYNC_BUDGET_MS,
        // SYSTÈME MISSION AVANCÉ : contrat de résultat du modèle professionnel
        // — la porte de sortie vérifie les critères d'acceptation.
        ...(task.outcomeContract ? { outcomeContract: task.outcomeContract } : {}),
        // Cloisonnement multi-tenant (Task 58) : tâche d'organisation.
        ...(task.orgId ? { orgId: task.orgId } : {}),
      });
      const state = await runtime.run();
      // Le plan (avec les statuts d'étapes mis à jour) est re-persisté : une
      // reprise après pause ré-exécute le même plan et saute le terminé.
      // L'arrêt utilisateur (contrôle "stop" ou déconnexion du client)
      // aboutit à l'état "cancelled" — terminal, distinct de "failed".
      // Garde anti-course : si un stop est posé entre la dernière lecture du
      // runtime et cette écriture, l'ARRÊT gagne (jamais "completed" après
      // un arrêt demandé par l'utilisateur).
      const stopWasRequested = await isExecutionStopRequested(state.executionId);
      const finalStatus = stopWasRequested ? "cancelled" : state.status;

      // CONTINUATION ARRIÈRE-PLAN (exigence production) : la borne de tranche
      // a interrompu la mission avec des étapes restantes → la suite part sur
      // la file. Fermer l'onglet ne stoppe plus jamais une tâche lancée.
      let continuation: { queued: boolean; runId?: string; reason?: string } | undefined;
      if (!stopWasRequested && finalStatus === "paused" && state.plan.steps.some((step) => step.status === "pending")) {
        continuation = await enqueueMissionContinuation({
          userId: user.uid,
          executionId: state.executionId,
          objective: task.objective,
          plan: state.plan,
          ...(task.orgId ? { orgId: task.orgId } : {}),
          origin: process.env.GEN3IA_APP_ORIGIN?.trim() || request.nextUrl.origin,
        });
      }

      await runFirestoreGuarded(`workspace task finalize ${id}`, () => taskRef.update({
        plan: state.plan,
        status: finalStatus === "completed" ? "completed" : finalStatus === "paused" ? "paused" : finalStatus === "cancelled" ? "cancelled" : "failed",
        ...(finalStatus === "paused" ? {} : { completedAt: FieldValue.serverTimestamp() }),
        updatedAt: FieldValue.serverTimestamp(),
      }));
      return NextResponse.json({
        success: finalStatus === "completed",
        executionId: state.executionId,
        status: finalStatus,
        ...(continuation ? { continuation } : {}),
        outputs: state.outputs,
        observations: state.observations,
        billing: state.billing,
      });
    } catch (error) {
      // Erreur réelle de la mission (PAS une déconnexion : le signal requête
      // n'est plus propagé au runtime) — la tâche est marquée "failed" (best-
      // effort, borné 6 s par le garde 110-e) et le checkpoint reste
      // disponible pour une reprise manuelle. Un incident de statut ne
      // remplace JAMAIS l'erreur réelle de la mission.
      await runFirestoreGuarded(`workspace task fail ${id}`, () => taskRef.update({ status: "failed", updatedAt: FieldValue.serverTimestamp() })).catch(() => undefined);
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
