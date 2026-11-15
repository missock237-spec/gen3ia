import { FieldValue, Timestamp } from "@/lib/r2fs";
import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase/admin";
import { runFirestoreGuarded } from "@/lib/queue/firestore-guard";
import { createAgentPlan } from "@/lib/agents/planner/service";
import type { RuntimePlan } from "@/lib/agents/runtime";
import { clearExecutionPause, requestExecutionPause, requestExecutionStop } from "@/lib/agents/runtime/pause";
import { assertOrgAttach } from "@/lib/tenants/resource-access";
import type { OutcomeContract } from "@/lib/agents/outcome-contract";

export type WorkspaceTaskStatus = "draft"|"awaiting_approval"|"approved"|"running"|"completed"|"failed"|"cancelled"|"paused";
export interface WorkspaceTask { id:string; ownerId:string; objective:string; status:WorkspaceTaskStatus; plan?:RuntimePlan; parentTaskId?:string; activeBranchId:string; /** Organisation propriétaire (Task 58) — présente uniquement sur les tâches créées dans un contexte d'organisation. */ orgId?:string; /** Contrat de résultat (système mission avancé) : critères d'acceptation vérifiés par la porte de sortie du runtime. */ outcomeContract?:OutcomeContract; createdAt:number; updatedAt:number; approvedAt?:number; completedAt?:number; }
function assertOwner(ownerId:string){if(!ownerId?.trim()) throw new Error("ownerId is required.");}
function ms(v:unknown){return v instanceof Timestamp?v.toMillis():typeof v==="number"?v:Date.now();}
// Document Firestore agentWorkspaceTasks tel que stocké (champs requis par
// createWorkspaceTask — assertions non-null justifiées à la lecture).
type WorkspaceTaskDoc = { ownerId?:string; objective?:string; status?:string; plan?:RuntimePlan; parentTaskId?:string; activeBranchId?:string; orgId?:string; outcomeContract?:OutcomeContract; createdAt?:Timestamp|number; updatedAt?:Timestamp|number; approvedAt?:Timestamp|number; completedAt?:Timestamp|number; };
function taskFrom(id:string,d:WorkspaceTaskDoc):WorkspaceTask{return {id,ownerId:d.ownerId!,objective:d.objective!,status:d.status as WorkspaceTaskStatus,plan:d.plan,parentTaskId:d.parentTaskId,activeBranchId:d.activeBranchId!,...(d.orgId?{orgId:d.orgId}:{}),...(d.outcomeContract?{outcomeContract:d.outcomeContract}:{}),createdAt:ms(d.createdAt),updatedAt:ms(d.updatedAt),approvedAt:d.approvedAt?ms(d.approvedAt):undefined,completedAt:d.completedAt?ms(d.completedAt):undefined};}
const TASKS="agentWorkspaceTasks", BRANCHES="agentWorkspaceBranches", SNAPSHOTS="agentWorkspaceSnapshots";
/**
 * GARDE QUOTA (Task 110-e) : le tableau « agent IA » (tâches workspace) est
 * pollé par l'interface (liste + détail) et chaque action utilisateur
 * (créer, approuver, exécuter, pauser, arrêter, branches, rollback) écrit en
 * direct — second symptôme production (« dans l'agent ia aucune tâche ne
 * s'exécute ») : sous quota Firestore épuisé, createWorkspaceTask et
 * approveWorkspaceTask pendaient SANS lever (Task 97), la requête était
 * retenue jusqu'au kill maxDuration et la tâche n'existait jamais. Chaque
 * touche passe par runFirestoreGuarded (lib/queue/firestore-guard, partagé
 * avec la file de missions 110-d) — deadline 6 s + disjoncteur : échec
 * rapide quota-classifié (503 actionnable via errorStatus) au lieu d'une
 * pendule ; les lectures restent honnêtes (échouent vite sous quota, la
 * lecture reprise par le garde couvre aussi les stalls réseau).
 */
export async function createWorkspaceTask(ownerId:string,objective:string,opts?:{orgId?:string;outcomeContract?:OutcomeContract;templateId?:string}){assertOwner(ownerId);const plan=await createAgentPlan(ownerId,objective);
// Cloisonnement multi-tenant (Task 58) : rattachement validé AVANT la
// transaction — l'appelant doit être membre de l'organisation cible.
const orgId=opts?.orgId?.trim()||undefined;
if(orgId) await assertOrgAttach(ownerId,orgId);
const id=randomUUID(),branchId=randomUUID(),snapshotId=randomUUID(),now=Date.now();await runFirestoreGuarded(`workspace task create ${id}`,()=>adminDb.runTransaction(async tx=>{tx.create(adminDb.collection(TASKS).doc(id),{ownerId,objective,status:"awaiting_approval",plan,activeBranchId:branchId,...(orgId?{orgId}:{}),...(opts?.outcomeContract?{outcomeContract:opts.outcomeContract}:{}),...(opts?.templateId?{templateId:opts.templateId.slice(0,64)}:{}),createdAt:Timestamp.fromMillis(now),updatedAt:Timestamp.fromMillis(now)});tx.create(adminDb.collection(BRANCHES).doc(branchId),{ownerId,taskId:id,name:"main",snapshotId,active:true,createdAt:Timestamp.fromMillis(now)});tx.create(adminDb.collection(SNAPSHOTS).doc(snapshotId),{ownerId,taskId:id,branchId,state:{plan,status:"awaiting_approval"},createdAt:Timestamp.fromMillis(now)});}));return getWorkspaceTask(ownerId,id);}
export async function listWorkspaceTasks(ownerId:string,limitCount=12){
  assertOwner(ownerId);
  const safeLimit=Math.min(Math.max(Math.floor(limitCount)||12,1),50);
  const snap=await runFirestoreGuarded(`workspace task list ${ownerId}`,()=>adminDb.collection(TASKS).where("ownerId","==",ownerId).limit(safeLimit).get());
  return snap.docs.map(doc=>taskFrom(doc.id,doc.data())).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,safeLimit);
}
/** Un « running » plus vieux que ce seuil est un kill plateforme : résoluble. */
const STALE_RUNNING_MS=15*60*1000;
/**
 * Résout une tâche fantôme « running » (fonction serveur tuée avant sa
 * finalisation) : après le délai de staleness, elle passe en « paused » —
 * la reprise redevient possible au lieu d'un blocage définitif. La tâche
 * LUE est TOUJOURS retournée (l'ancien contrat « null si pas concernée »
 * forçait l'appelant à relire le même document : 2 lectures Firestore par
 * consultation du détail, alors que celle-ci est pollée par l'interface).
 */
export async function resolveStaleRunningTask(ownerId:string,id:string):Promise<WorkspaceTask>{
  const task=await getWorkspaceTask(ownerId,id);
  if(task.status!=="running") return task;
  if(Date.now()-task.updatedAt<STALE_RUNNING_MS) return task;
  await runFirestoreGuarded(`workspace task stale ${id}`,()=>adminDb.collection(TASKS).doc(id).update({status:"paused",updatedAt:FieldValue.serverTimestamp()}));
  return getWorkspaceTask(ownerId,id);
}

export async function getWorkspaceTask(ownerId:string,id:string){assertOwner(ownerId);const s=await runFirestoreGuarded(`workspace task get ${id}`,()=>adminDb.collection(TASKS).doc(id).get());if(!s.exists||s.get("ownerId")!==ownerId)throw new Error("Task not found.");return taskFrom(id,s.data()!);}
export async function updateWorkspacePlan(ownerId:string,id:string,plan:RuntimePlan){assertOwner(ownerId);const task=await getWorkspaceTask(ownerId,id);if(task.status!=="draft"&&task.status!=="awaiting_approval")throw new Error("Only draft or awaiting-approval tasks can be edited.");const parsed=(await import("@/lib/agents/runtime")).RuntimePlanSchema.safeParse(plan);if(!parsed.success)throw new Error(`Invalid runtime plan: ${parsed.error.message}`);if(parsed.data.objective!==task.objective)throw new Error("Plan objective cannot be changed.");const validation=(await import("@/lib/agents/runtime")).validateDAG(parsed.data);if(!validation.valid)throw new Error(`Invalid agent DAG:\n${validation.errors.join("\n")}`);await runFirestoreGuarded(`workspace task plan ${id}`,()=>adminDb.collection(TASKS).doc(id).update({plan:parsed.data,status:"awaiting_approval",updatedAt:FieldValue.serverTimestamp()}));await snapshotWorkspaceTask(ownerId,id,{plan:parsed.data,status:"awaiting_approval",reason:"plan_updated"});return getWorkspaceTask(ownerId,id);}
export async function approveWorkspaceTask(ownerId:string,id:string){const task=await getWorkspaceTask(ownerId,id);if(task.status!=="awaiting_approval")throw new Error("Task is not awaiting approval.");await runFirestoreGuarded(`workspace task approve ${id}`,()=>adminDb.collection(TASKS).doc(id).update({status:"approved",approvedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()}));return getWorkspaceTask(ownerId,id);}
export async function listWorkspaceBranches(ownerId:string,taskId:string){
  const task=await getWorkspaceTask(ownerId,taskId);
  // Task 101 (m3) : plafond 50 — les branches d'une tâche sont des actes
  // explicites de l'utilisateur, la liste intégrale ne sert que l'UI.
  const snap=await runFirestoreGuarded(`workspace branches list ${taskId}`,()=>adminDb.collection(BRANCHES).where("ownerId","==",ownerId).where("taskId","==",task.id).limit(50).get());
  return snap.docs.map(doc=>({id:doc.id,...(doc.data() as object)} as {id:string;createdAt?:Timestamp|number;[key:string]:unknown})).sort((a,b)=>ms(b.createdAt)-ms(a.createdAt));
}
export async function listWorkspaceSnapshots(ownerId:string,taskId:string){
  const task=await getWorkspaceTask(ownerId,taskId);
  // Task 101 (m3) : plafond 50 — les snapshots s'accumulent à chaque mise à
  // jour de plan / événement : sans limite, la liste croissait sans borne.
  const snap=await runFirestoreGuarded(`workspace snapshots list ${taskId}`,()=>adminDb.collection(SNAPSHOTS).where("ownerId","==",ownerId).where("taskId","==",task.id).limit(50).get());
  return snap.docs.map(doc=>({id:doc.id,...(doc.data() as object)} as {id:string;createdAt?:Timestamp|number;[key:string]:unknown})).sort((a,b)=>ms(b.createdAt)-ms(a.createdAt));
}

export async function createBranch(ownerId:string,taskId:string,name:string){const task=await getWorkspaceTask(ownerId,taskId);const branchId=randomUUID(),snapshotId=randomUUID(),now=Date.now();await runFirestoreGuarded(`workspace snapshot create ${snapshotId}`,()=>adminDb.collection(SNAPSHOTS).doc(snapshotId).create({ownerId,taskId,branchId,state:{plan:task.plan,status:task.status},createdAt:Timestamp.fromMillis(now)}));await runFirestoreGuarded(`workspace branch create ${branchId}`,()=>adminDb.collection(BRANCHES).doc(branchId).create({ownerId,taskId,name:name.trim().slice(0,80),parentBranchId:task.activeBranchId,snapshotId,active:false,createdAt:Timestamp.fromMillis(now)}));return {id:branchId,taskId,ownerId,name:name.trim().slice(0,80),parentBranchId:task.activeBranchId,snapshotId,createdAt:now,active:false};}
export async function switchWorkspaceBranch(ownerId:string,taskId:string,branchId:string){
  const task=await getWorkspaceTask(ownerId,taskId);
  const branch=await runFirestoreGuarded(`workspace branch get ${branchId}`,()=>adminDb.collection(BRANCHES).doc(branchId).get());
  if(!branch.exists||branch.get("ownerId")!==ownerId||branch.get("taskId")!==taskId) throw new Error("Branch not found.");
  const snapshotId=branch.get("snapshotId") as string|undefined;
  if(!snapshotId) throw new Error("Branch has no snapshot.");
  const snapshot=await runFirestoreGuarded(`workspace snapshot get ${snapshotId}`,()=>adminDb.collection(SNAPSHOTS).doc(snapshotId).get());
  if(!snapshot.exists||snapshot.get("ownerId")!==ownerId||snapshot.get("taskId")!==taskId) throw new Error("Branch snapshot not found.");
  const state=snapshot.get("state") as {plan?:RuntimePlan;status?:WorkspaceTaskStatus}|undefined;
  await runFirestoreGuarded(`workspace branch switch ${taskId}`,()=>adminDb.runTransaction(async tx=>{
    const branches=await tx.get(adminDb.collection(BRANCHES).where("ownerId","==",ownerId).where("taskId","==",taskId));
    for(const doc of branches.docs) tx.update(doc.ref,{active:doc.id===branchId});
    tx.update(adminDb.collection(TASKS).doc(taskId),{activeBranchId:branchId,plan:state?.plan??task.plan,status:state?.status==="running"?"approved":state?.status??"approved",updatedAt:FieldValue.serverTimestamp()});
  }));
  return getWorkspaceTask(ownerId,taskId);
}

export async function rollbackTask(ownerId:string,taskId:string,snapshotId:string){const task=await getWorkspaceTask(ownerId,taskId);const snap=await runFirestoreGuarded(`workspace snapshot get ${snapshotId}`,()=>adminDb.collection(SNAPSHOTS).doc(snapshotId).get());if(!snap.exists||snap.get("ownerId")!==ownerId||snap.get("taskId")!==taskId)throw new Error("Snapshot not found.");const state=snap.get("state") as {plan?:RuntimePlan;status?:WorkspaceTaskStatus}|undefined;await runFirestoreGuarded(`workspace task rollback ${taskId}`,()=>adminDb.collection(TASKS).doc(taskId).update({plan:state?.plan??task.plan,status:state?.status==="running"?"approved":state?.status??"approved",updatedAt:FieldValue.serverTimestamp()}));return getWorkspaceTask(ownerId,taskId);}
export async function snapshotWorkspaceTask(ownerId:string,taskId:string,state:Record<string,unknown>){const task=await getWorkspaceTask(ownerId,taskId);const id=randomUUID();await runFirestoreGuarded(`workspace snapshot create ${id}`,()=>adminDb.collection(SNAPSHOTS).doc(id).create({ownerId,taskId,branchId:task.activeBranchId,state,createdAt:FieldValue.serverTimestamp()}));return id;}

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
  await runFirestoreGuarded(`workspace task pause ${taskId}`,()=>adminDb.collection(TASKS).doc(taskId).update({pauseRequested:true,...(reason?{pauseReason:reason.slice(0,500)}:{}),updatedAt:FieldValue.serverTimestamp()}));
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
  await runFirestoreGuarded(`workspace task stop ${taskId}`,()=>adminDb.collection(TASKS).doc(taskId).update({status:"cancelled",completedAt:FieldValue.serverTimestamp(),...(task.status==="running"?{stopRequested:true}:{}),...(reason?{stopReason:reason.slice(0,500)}:{stopReason:FieldValue.delete()}),pauseRequested:FieldValue.delete(),pauseReason:FieldValue.delete(),updatedAt:FieldValue.serverTimestamp()}));
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
  await runFirestoreGuarded(`workspace task resume ${taskId}`,()=>adminDb.collection(TASKS).doc(taskId).update({status:"approved",pauseRequested:FieldValue.delete(),pauseReason:FieldValue.delete(),updatedAt:FieldValue.serverTimestamp()}));
  return getWorkspaceTask(ownerId,taskId);
}
