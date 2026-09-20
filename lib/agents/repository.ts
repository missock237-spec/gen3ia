import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { AgentRecord, AgentRecordSchema, AgentRecordInput, AgentSummary } from "./schema";

const COLLECTION = "agents";
interface AgentDoc { [key: string]: unknown; ownerId: string; createdAt?: Timestamp | FieldValue; updatedAt?: Timestamp | FieldValue; }

function toRecord(id: string, data: AgentDoc): AgentRecord {
  return {
    ...(AgentRecordSchema.parse({ ...data, tools: Array.isArray(data.tools) ? data.tools : [] }) as AgentRecord),
    id, ownerId: data.ownerId,
    createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate().toISOString() : new Date().toISOString(),
    updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt.toDate().toISOString() : new Date().toISOString(),
  };
}
export async function createAgentRecord(ownerId: string, input: AgentRecordInput): Promise<AgentRecord> {
  const values = AgentRecordSchema.parse(input);
  const ref = adminDb.collection(COLLECTION).doc(); const now = FieldValue.serverTimestamp();
  await ref.set({ ...values, ownerId, createdAt: now, updatedAt: now } satisfies AgentDoc);
  return toRecord(ref.id, (await ref.get()).data() as AgentDoc);
}
export async function listAgentsByOwner(ownerId: string, projectId?: string): Promise<AgentRecord[]> {
  const snapshot = await adminDb.collection(COLLECTION).where("ownerId", "==", ownerId).orderBy("createdAt", "desc").limit(100).get();
  return snapshot.docs.filter(d => d.data().status !== "archived").filter(d => !projectId || d.data().projectId === projectId).map(d => toRecord(d.id, d.data() as AgentDoc));
}
export async function getAgentById(agentId: string): Promise<AgentRecord | null> {
  const snap = await adminDb.collection(COLLECTION).doc(agentId).get(); if (!snap.exists) return null;
  const data = snap.data() as AgentDoc | undefined; if (!data || data.status !== "active") return null; return toRecord(snap.id, data);
}
export async function getAgentForOwner(ownerId: string, agentId: string): Promise<AgentRecord | null> {
  const snap = await adminDb.collection(COLLECTION).doc(agentId).get(); if (!snap.exists) return null;
  const data = snap.data() as AgentDoc | undefined; if (!data || data.ownerId !== ownerId) return null; return toRecord(snap.id, data);
}
export async function updateAgentForOwner(ownerId: string, agentId: string, patch: Partial<AgentRecordInput>): Promise<AgentRecord | null> {
  const current = await getAgentForOwner(ownerId, agentId); if (!current) return null;
  const merged = AgentRecordSchema.parse({
    name: patch.name ?? current.name, description: patch.description ?? current.description, type: patch.type ?? current.type,
    projectId: patch.projectId ?? current.projectId, systemPrompt: patch.systemPrompt ?? current.systemPrompt,
    modelStrategy: patch.modelStrategy ?? current.modelStrategy, preferredProvider: patch.preferredProvider ?? current.preferredProvider,
    preferredModel: patch.preferredModel ?? current.preferredModel, autonomous: patch.autonomous ?? current.autonomous,
    maxIterations: patch.maxIterations ?? current.maxIterations, tools: patch.tools ?? current.tools,
    memoryEnabled: patch.memoryEnabled ?? current.memoryEnabled, webResearchEnabled: patch.webResearchEnabled ?? current.webResearchEnabled,
    documentGenerationEnabled: patch.documentGenerationEnabled ?? current.documentGenerationEnabled, voiceEnabled: patch.voiceEnabled ?? current.voiceEnabled,
    voiceConfig: patch.voiceConfig ?? current.voiceConfig, status: patch.status ?? current.status,
  });
  await adminDb.collection(COLLECTION).doc(agentId).set({ ...merged, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return getAgentForOwner(ownerId, agentId);
}
export async function deleteAgentForOwner(ownerId: string, agentId: string): Promise<boolean> {
  const current = await getAgentForOwner(ownerId, agentId); if (!current) return false;
  await adminDb.collection(COLLECTION).doc(agentId).delete(); return true;
}
export async function countActiveAgentsOfType(ownerId: string, type: string): Promise<number> {
  const snapshot = await adminDb.collection(COLLECTION).where("ownerId", "==", ownerId).where("type", "==", type).where("status", "==", "active").limit(5).get(); return snapshot.size;
}
export function toSummary(record: AgentRecord): AgentSummary {
  return { id: record.id, name: record.name, description: record.description, type: record.type, projectId: record.projectId, status: record.status,
    modelStrategy: record.modelStrategy, preferredProvider: record.preferredProvider, preferredModel: record.preferredModel, autonomous: record.autonomous,
    maxIterations: record.maxIterations, tools: record.tools, memoryEnabled: record.memoryEnabled, webResearchEnabled: record.webResearchEnabled,
    documentGenerationEnabled: record.documentGenerationEnabled, voiceEnabled: record.voiceEnabled, voiceConfig: record.voiceConfig,
    createdAt: record.createdAt, updatedAt: record.updatedAt };
}
