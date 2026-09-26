import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import { createAgentPlan } from "@/lib/agents/planner/service";
import type { RuntimePlan } from "@/lib/agents/runtime";
import { clearExecutionPause, requestExecutionPause, requestExecutionStop } from "@/lib/agents/runtime/pause";

export type WorkspaceTaskStatus = "draft"|"awaiting_approval"|"approved"|"running"|"completed"|"failed"|"cancelled"|"paused";
export interface WorkspaceTask { id:string; ownerId:string; objective:string; status:WorkspaceTaskStatus; plan?:RuntimePlan; parentTaskId?:string; activeBranchId:string; createdAt:number; updatedAt:number; approvedAt?:number; completedAt?:number; }
function assertOwner(ownerId:string){if(!ownerId?.trim()) throw new Error("ownerId is required.");}
function ms(v:unknown){return v instanceof Timestamp?v.toMillis():typeof v==="number"?v:Date.now();}
function taskFrom(id:string,d:any):WorkspaceTask{return {id,ownerId:d.ownerId,objective:d.objective,status:d.status,plan:d.plan,parentTaskId:d.parentTaskId,activeBranchId:d.activeBranchId,createdAt:ms(d.createdAt),updatedAt:ms(d.updatedAt),approvedAt:d.approvedAt?ms(d.approvedAt):undefined,completedAt:d.completedAt?ms(d.completedAt):undefined};}
const TASKS="agentWorkspaceTasks", BRANCHES="agentWorkspaceBranches", SNAPSHOTS="agentWorkspaceSnapshots";
export async function createWorkspaceTask(ownerId:string,objective:string){assertOwner(ownerId);const plan=await createAgentPlan(ownerId,objective);const id=randomUUID(),branchId=randomUUID(),snapshotId=randomUUID(),now=Date.now();await adminDb.runTransaction(async tx=>{tx.create(adminDb.collection(TASKS).doc(id),{ownerId,objective,status:"awaiting_approval",plan,activeBranchId:branchId,createdAt:Timestamp.fromMillis(now),updatedAt:Timestamp.fromMillis(now)});tx.create(adminDb.collection(BRANCHES).doc(branchId),{ownerId,taskId:id,name:"main",snapshotId,active:true,createdAt:Timestamp.fromMillis(now)});tx.create(adminDb.collection(SNAPSHOTS).doc(snapshotId),{ownerId,taskId:id,branchId,state:{plan,status:"awaiting_approval"},createdAt:Timestamp.fromMillis(now)});});return getWorkspaceTask(ownerId,id);}
export async function listWorkspaceTasks(ownerId:string,limitCount=12){
  assertOwner(ownerId);
  const safeLimit=Math.min(Math.max(Math.floor(limitCount)||12,1),50);
  const snap=await adminDb.collection(TASKS).where("ownerId","==",ownerId).limit(safeLimit).get();
  return snap.docs.map(doc=>taskFrom(doc.id,doc.data())).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,safeLimit);
}

export async function getWorkspaceTask(ownerId:string,id:string){assertOwner(ownerId);const s=await adminDb.collection(TASKS).doc(id).get();if(!s.exists||s.get("ownerId")!==ownerId)throw new Error("Task not found.");return taskFrom(id,s.data()!);}
export async function updateWorkspacePlan(ownerId:string,id:string,plan:RuntimePlan){assertOwner(ownerId);const task=await getWorkspaceTask(ownerId,id);if(task.status!=="draft"&&task.status!=="awaiting_approval")throw new Error("Only draft or awaiting-approval tasks can be edited.");const parsed=(await import("@/lib/agents/runtime")).RuntimePlanSchema.safeParse(plan);if(!parsed.success)throw new Error(`Invalid runtime plan: ${parsed.error.message}`);if(parsed.data.objective!==task.objective)throw new Error("Plan objective cannot be changed.");const validation=(await import("@/lib/agents/runtime")).validateDAG(parsed.data);if(!validation.valid)throw new Error(`Invalid agent DAG:\n${validation.errors.join("\n")}`);await adminDb.collection(TASKS).doc(id).update({plan:parsed.data,status:"awaiting_approval",updatedAt:FieldValue.serverTimestamp()});await snapshotWorkspaceTask(ownerId,id,{plan:parsed.data,status:"awaiting_approval",reason:"plan_updated"});return getWorkspaceTask(ownerId,id);}
export async function approveWorkspaceTask(ownerId:string,id:string){const task=await getWorkspaceTask(ownerId,id);if(task.status!=="awaiting_approval")throw new Error("Task is not awaiting approval.");await adminDb.collection(TASKS).doc(id).update({status:"approved",approvedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});return getWorkspaceTask(ownerId,id);}
export async function listWorkspaceBranches(ownerId:string,taskId:string){
  const task=await getWorkspaceTask(ownerId,taskId);
  const snap=await adminDb.collection(BRANCHES).where("ownerId","==",ownerId).where("taskId","==",task.id).get();
  return snap.docs.map(doc=>({id:doc.id,...doc.data()})).sort((a:any,b:any)=>ms(b.createdAt)-ms(a.createdAt));
}
export async function listWorkspaceSnapshots(ownerId:string,taskId:string){
  const task=await getWorkspaceTask(ownerId,taskId);
  const snap=await adminDb.collection(SNAPSHOTS).where("ownerId","==",ownerId).where("taskId","==",task.id).get();
  return snap.docs.map(doc=>({id:doc.id,...doc.data()})).sort((a:any,b:any)=>ms(b.createdAt)-ms(a.createdAt));
}

export async function createBranch(ownerId:string,taskId:string,name:string){const task=await getWorkspaceTask(ownerId,taskId);const branchId=randomUUID(),snapshotId=randomUUID(),now=Date.now();await adminDb.collection(SNAPSHOTS).doc(snapshotId).create({ownerId,taskId,branchId,state:{plan:task.plan,status:task.status},createdAt:Timestamp.fromMillis(now)});await adminDb.collection(BRANCHES).doc(branchId).create({ownerId,taskId,name:name.trim().slice(0,80),parentBranchId:task.activeBranchId,snapshotId,active:false,createdAt:Timestamp.fromMillis(now)});return {id:branchId,taskId,ownerId,name:name.trim().slice(0,80),parentBranchId:task.activeBranchId,snapshotId,createdAt:now,active:false};}
export async function switchWorkspaceBranch(ownerId:string,taskId:string,branchId:string){
  const task=await getWorkspaceTask(ownerId,taskId);
  const branch=await adminDb.collection(BRANCHES).doc(branchId).get();
  if(!branch.exists||branch.get("ownerId")!==ownerId||branch.get("taskId")!==taskId) throw new Error("Branch not found.");
  const snapshotId=branch.get("snapshotId") as string|undefined;
  if(!snapshotId) throw new Error("Branch has no snapshot.");
  const snapshot=await adminDb.collection(SNAPSHOTS).doc(snapshotId).get();
  if(!snapshot.exists||snapshot.get("ownerId")!==ownerId||snapshot.get("taskId")!==taskId) throw new Error("Branch snapshot not found.");
  const state=snapshot.get("state") as {plan?:RuntimePlan;status?:WorkspaceTaskStatus}|undefined;
  await adminDb.runTransaction(async tx=>{
    const branches=await tx.get(adminDb.collection(BRANCHES).where("ownerId","==",ownerId).where("taskId","==",taskId));
    for(const doc of branches.docs) tx.update(doc.ref,{active:doc.id===branchId});
    tx.update(adminDb.collection(TASKS).doc(taskId),{activeBranchId:branchId,plan:state?.plan??task.plan,status:state?.status==="running"?"approved":state?.status??"approved",updatedAt:FieldValue.serverTimestamp()});
  });
  return getWorkspaceTask(ownerId,taskId);
}

export async function rollbackTask(ownerId:string,taskId:string,snapshotId:string){const task=await getWorkspaceTask(ownerId,taskId);const snap=await adminDb.collection(SNAPSHOTS).doc(snapshotId).get();if(!snap.exists||snap.get("ownerId")!==ownerId||snap.get("taskId")!==taskId)throw new Error("Snapshot not found.");const state=snap.get("state") as {plan?:RuntimePlan;status?:WorkspaceTaskStatus}|undefined;await adminDb.collection(TASKS).doc(taskId).update({plan:state?.plan??task.plan,status:state?.status==="running"?"approved":state?.status??"approved",updatedAt:FieldValue.serverTimestamp()});return getWorkspaceTask(ownerId,taskId);}
export async function snapshotWorkspaceTask(ownerId:string,taskId:string,state:Record<string,unknown>){const task=await getWorkspaceTask(ownerId,taskId);const id=randomUUID();await adminDb.collection(SNAPSHOTS).doc(id).create({ownerId,taskId,branchId:task.activeBranchId,state,createdAt:FieldValue.serverTimestamp()});return id;}

/**
 * Pause d'une tâche workspace en cours d'exécution.
 *
 * Mécanisme : le runtime consulte un contrôle de pause (agentPauseControls)
 * entre chaque lot d'étapes — à la première consultation, il s'arrête
 * proprement, conserve les étapes déjà payées et retourne un état "paused".
 * L'executionId courant est lu sur la tâche (persisté à la revendication
 * d'exécution) ; sans exécution en cours, la pause est refusée.
 */
export async function pauseWorkspaceTask(ownerId:string,taskId:string,reason?:string){
  const task=await getWorkspaceTask(ownerId,taskId);
  if(task.status!=="running") throw new Error("Seule une tâche en cours d'exécution peut être mise en pause.");
  const executionId=task.plan?.executionId;
  if(!executionId) throw new Error("Aucune exécution active identifiable pour cette tâche.");
  await requestExecutionPause({userId:ownerId,executionId,taskId,reason});
  await adminDb.collection(TASKS).doc(taskId).update({pauseRequested:true,...(reason?{pauseReason:reason.slice(0,500)}:{}),updatedAt:FieldValue.serverTimestamp()});
  return getWorkspaceTask(ownerId,taskId);
}

/**
 * ARRÊT DÉFINITIF d'une tâche demandé par l'utilisateur à tout moment.
 *
 * Accepté depuis les statuts "running" (exécution en cours) ET "paused"
 * (une tâche mise en pause peut être abandonnée). La tâche passe
 * immédiatement à "cancelled" (l'interface reflète l'arrêt sans attendre
 * le prochain contrôle du runtime) et le contrôle d'arrêt est posé pour
 * que le runtime en cours termine proprement à son prochain point de
 * consultation (entre les lots d'étapes / avant chaque étape). Si la tâche
 * était en pause, le contrôle de pause est simplement supprimé — aucune
 * exécution ne tourne.
 */
export async function stopWorkspaceTask(ownerId:string,taskId:string,reason?:string){
  const task=await getWorkspaceTask(ownerId,taskId);
  if(task.status!=="running"&&task.status!=="paused") throw new Error("Seule une tâche en cours d'exécution ou en pause peut être arrêtée.");
  const executionId=task.plan?.executionId;
  if(task.status==="running"){
    if(!executionId) throw new Error("Aucune exécution active identifiable pour cette tâche.");
    await requestExecutionStop({userId:ownerId,executionId,taskId,reason});
  } else if(executionId){
    try { await clearExecutionPause(ownerId,executionId); } catch { /* contrôle déjà absent : rien à lever */ }
  }
  await adminDb.collection(TASKS).doc(taskId).update({status:"cancelled",completedAt:FieldValue.serverTimestamp(),...(task.status==="running"?{stopRequested:true}:{}),...(reason?{stopReason:reason.slice(0,500)}:{stopReason:FieldValue.delete()}),pauseRequested:FieldValue.delete(),pauseReason:FieldValue.delete(),updatedAt:FieldValue.serverTimestamp()});
  await snapshotWorkspaceTask(ownerId,taskId,{plan:task.plan,status:"cancelled",reason:reason?"task_stopped":"task_stopped"});
  return getWorkspaceTask(ownerId,taskId);
}

/**
 * Reprise d'une tâche en pause : supprime le contrôle de pause. La reprise
 * effective se fait via la route d'exécution habituelle (le plan persisté
 * conserve les étapes complétées — le planificateur DAG saute le terminé
 * et reprend les étapes restantes).
 */
export async function resumeWorkspaceTask(ownerId:string,taskId:string){
  const task=await getWorkspaceTask(ownerId,taskId);
  if(task.status!=="paused") throw new Error("Seule une tâche en pause peut être reprise.");
  const executionId=task.plan?.executionId;
  if(executionId){
    try { await clearExecutionPause(ownerId,executionId); } catch { /* contrôle déjà absent : rien à lever */ }
  }
  await adminDb.collection(TASKS).doc(taskId).update({status:"approved",pauseRequested:FieldValue.delete(),pauseReason:FieldValue.delete(),updatedAt:FieldValue.serverTimestamp()});
  return getWorkspaceTask(ownerId,taskId);
}
