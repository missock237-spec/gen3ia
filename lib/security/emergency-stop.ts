import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { runFirestoreGuarded } from "@/lib/queue/firestore-guard";

const COLLECTION = "emergencyStops";
type StopScope = "user" | "agent" | "execution";

/**
 * GARDE QUOTA (Task 110-e) : l'ARRÊT D'URGENCE est une ÉCRITURE Firestore
 * posée par l'utilisateur via /api/security/emergency-stop — dernier recours
 * pour reprendre la main sur un agent. Sur Firestore brut, sous quota
 * quotidien épuisé elle pendaît SANS lever (Task 97) : le bouton d'urgence
 * restait suspendu jusqu'au kill de la fonction. runFirestoreGuarded
 * (lib/queue/firestore-guard, partagé avec la file de missions 110-d) borne
 * l'écriture à 6 s + disjoncteur. Les LECTURES (assertExecutionNotStopped,
 * 3 lectures par étape outil via executeToolSecurely) restent BRUTES :
 * elles lèvent vite sous quota (Task 97) — échec honnête de l'étape, même
 * doctrine que getWallet — et un incident ne doit JAMAIS masquer un arrêt
 * actif (fail-closed assumé).
 */

function assertId(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error(`${name} is required.`);
  return normalized;
}

function stopRef(scope: StopScope, id: string) {
  return adminDb.collection(COLLECTION).doc(`${scope}_${assertId(id, "id")}`);
}

export async function activateEmergencyStop(params: { userId: string; scope?: StopScope; agentId?: string; executionId?: string; reason?: string }): Promise<void> {
  const userId = assertId(params.userId, "userId");
  const scope = params.scope ?? "user";
  const targetId = scope === "user" ? userId : scope === "agent"
    ? assertId(params.agentId ?? "", "agentId")
    : assertId(params.executionId ?? "", "executionId");
  await runFirestoreGuarded(`emergency stop set ${scope}_${targetId}`, () => stopRef(scope, targetId).set({
    active: true,
    scope,
    targetId,
    ownerId: userId,
    reason: (params.reason ?? "Emergency stop requested by user").slice(0, 2_000),
    activatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true }));
}

export async function clearEmergencyStop(params: { userId: string; scope?: StopScope; agentId?: string; executionId?: string }): Promise<void> {
  const userId = assertId(params.userId, "userId");
  const scope = params.scope ?? "user";
  const targetId = scope === "user" ? userId : scope === "agent"
    ? assertId(params.agentId ?? "", "agentId")
    : assertId(params.executionId ?? "", "executionId");
  const document = stopRef(scope, targetId);
  const snapshot = await document.get();
  if (snapshot.exists && String(snapshot.get("ownerId") ?? "") !== userId) throw new Error("Emergency stop does not belong to this user.");
  await runFirestoreGuarded(`emergency stop clear ${scope}_${targetId}`, () => document.set({ active: false, clearedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true }));
}

async function isActive(scope: StopScope, id: string, userId: string): Promise<boolean> {
  const snapshot = await stopRef(scope, id).get();
  if (!snapshot.exists) return false;
  const data = snapshot.data() ?? {};
  return data.active === true && String(data.ownerId ?? "") === userId;
}

export async function assertExecutionNotStopped(params: { userId: string; executionId: string; agentId?: string }): Promise<void> {
  const userId = assertId(params.userId, "userId");
  const executionId = assertId(params.executionId, "executionId");
  const [userStopped, executionStopped, agentStopped] = await Promise.all([
    isActive("user", userId, userId),
    isActive("execution", executionId, userId),
    params.agentId ? isActive("agent", params.agentId, userId) : Promise.resolve(false),
  ]);
  if (userStopped || executionStopped || agentStopped) throw new Error("Execution blocked by emergency stop.");
}

export type { StopScope };
