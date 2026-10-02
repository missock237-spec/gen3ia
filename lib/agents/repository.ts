import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { buildAgentCharter } from "./charter";
import { AgentRecord, AgentRecordSchema, AgentRecordInput, AgentSummary } from "./schema";
import {
  assertOrgAttach,
  assertOrgTransfer,
  assertResourceRead,
  assertResourceWrite,
  listUserOrgIds,
} from "@/lib/tenants/resource-access";

const COLLECTION = "agents";
interface AgentDoc { [key: string]: unknown; ownerId: string; createdAt?: Timestamp | FieldValue; updatedAt?: Timestamp | FieldValue; }

function toRecord(id: string, data: AgentDoc): AgentRecord {
  const parsed = AgentRecordSchema.parse({
    ...data,
    tools: Array.isArray(data.tools) ? data.tools : [],
    skills: Array.isArray(data.skills) ? data.skills : [],
    // Compatibilité : les agents créés avant la charte ont toujours un
    // systemPrompt explicite ; ce repli reste défensif.
    systemPrompt: typeof data.systemPrompt === "string" && data.systemPrompt.trim().length >= 10 ? data.systemPrompt : "Agent Gen3ia. Tu réponds de manière professionnelle.",
  }) as AgentRecord;
  return { ...parsed, id, ownerId: data.ownerId,
    createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate().toISOString() : new Date().toISOString(),
    updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt.toDate().toISOString() : new Date().toISOString(),
  };
}
/**
 * Crée un agent. Sans opts.orgId l'agent est personnel (comportement
 * historique) ; avec orgId, l'appelant doit être membre de l'organisation
 * cible (tous rôles) — la garde est faite AVANT toute écriture.
 */
export async function createAgentRecord(ownerId: string, input: AgentRecordInput, opts?: { orgId?: string }): Promise<AgentRecord> {
  const values = AgentRecordSchema.parse(input);
  const orgId = opts?.orgId?.trim() || values.orgId;
  if (orgId) {
    await assertOrgAttach(ownerId, orgId);
    values.orgId = orgId;
  } else {
    delete values.orgId;
  }
  // Sans prompt saisi par l'utilisateur, la charte professionnelle
  // (identité + conduite + périmètre strict) est générée automatiquement.
  if (!values.systemPrompt || values.systemPrompt.trim().length < 10) {
    values.systemPrompt = buildAgentCharter(values);
  }
  const ref = adminDb.collection(COLLECTION).doc(); const now = FieldValue.serverTimestamp();
  await ref.set({ ...values, ownerId, createdAt: now, updatedAt: now } satisfies AgentDoc);
  return toRecord(ref.id, (await ref.get()).data() as AgentDoc);
}
export async function listAgentsByOwner(ownerId: string, projectId?: string): Promise<AgentRecord[]> {
  const snapshot = await adminDb.collection(COLLECTION).where("ownerId", "==", ownerId).orderBy("createdAt", "desc").limit(100).get();
  return snapshot.docs.filter(d => d.data().status !== "archived").filter(d => !projectId || d.data().projectId === projectId).map(d => toRecord(d.id, d.data() as AgentDoc));
}

/** Firestore limite l'opérateur `in` à 30 valeurs par requête. */
const IN_QUERY_CHUNK = 30;
const LIST_CAP = 100;

/**
 * Liste union org-aware (recommandation C) : agents personnels + agents des
 * organisations dont l'utilisateur est membre. Deux familles de requêtes
 * bornées (ownerId == uid ; orgId in chunk≤30), fusion dédupliquée, tri
 * createdAt desc, plafond 100 — I/O Firestore maîtrisées et déterministes.
 */
export async function listAgentsForUser(userId: string, projectId?: string): Promise<AgentRecord[]> {
  const personal = await listAgentsByOwner(userId, projectId);
  const orgIds = await listUserOrgIds(userId);
  if (orgIds.length === 0) return personal;

  const chunks: string[][] = [];
  for (let i = 0; i < orgIds.length; i += IN_QUERY_CHUNK) chunks.push(orgIds.slice(i, i + IN_QUERY_CHUNK));
  const orgSnapshots = await Promise.all(chunks.map((chunk) =>
    adminDb.collection(COLLECTION).where("orgId", "in", chunk).limit(LIST_CAP).get()));

  const byId = new Map<string, AgentRecord>();
  for (const record of personal) byId.set(record.id, record);
  for (const snapshot of orgSnapshots) {
    for (const doc of snapshot.docs) {
      const data = doc.data() as AgentDoc | undefined;
      if (!data || data.status === "archived") continue;
      if (projectId && data.projectId !== projectId) continue;
      if (!byId.has(doc.id)) byId.set(doc.id, toRecord(doc.id, data));
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, LIST_CAP);
}
export async function getAgentById(agentId: string): Promise<AgentRecord | null> {
  const snap = await adminDb.collection(COLLECTION).doc(agentId).get(); if (!snap.exists) return null;
  const data = snap.data() as AgentDoc | undefined; if (!data || data.status !== "active") return null; return toRecord(snap.id, data);
}
export async function getAgentForOwner(ownerId: string, agentId: string): Promise<AgentRecord | null> {
  const snap = await adminDb.collection(COLLECTION).doc(agentId).get(); if (!snap.exists) return null;
  const data = snap.data() as AgentDoc | undefined; if (!data || data.ownerId !== ownerId) return null; return toRecord(snap.id, data);
}

/**
 * Accès org-aware (recommandation C) : le propriétaire garde l'accès
 * intégral ; une ressource rattachée à une organisation est lisible par ses
 * membres (rôle member) et gérable par owner/admin de l'org. La dénégation
 * renvoie null (indiscernable d'une ressource absente — anti-énumération).
 */
export async function getAgentForUser(userId: string, agentId: string): Promise<AgentRecord | null> {
  const snap = await adminDb.collection(COLLECTION).doc(agentId).get(); if (!snap.exists) return null;
  const data = snap.data() as AgentDoc | undefined; if (!data) return null;
  try {
    await assertResourceRead(userId, { ownerId: data.ownerId, orgId: typeof data.orgId === "string" ? data.orgId : null });
  } catch {
    return null;
  }
  return toRecord(snap.id, data);
}
export async function updateAgentForOwner(ownerId: string, agentId: string, patch: Partial<AgentRecordInput>): Promise<AgentRecord | null> {
  const current = await getAgentForOwner(ownerId, agentId); if (!current) return null;
  const merged = AgentRecordSchema.parse({
    name: patch.name ?? current.name, description: patch.description ?? current.description, type: patch.type ?? current.type,
    typeLabel: patch.typeLabel ?? current.typeLabel, skills: patch.skills ?? current.skills,
    agentMode: patch.agentMode ?? current.agentMode, memoryFile: patch.memoryFile ?? current.memoryFile,
    projectId: patch.projectId ?? current.projectId, systemPrompt: patch.systemPrompt ?? current.systemPrompt,
    modelStrategy: patch.modelStrategy ?? current.modelStrategy, preferredProvider: patch.preferredProvider ?? current.preferredProvider,
    preferredModel: patch.preferredModel ?? current.preferredModel, autonomous: patch.autonomous ?? current.autonomous,
    subagentsEnabled: patch.subagentsEnabled ?? current.subagentsEnabled,
    maxSubagents: patch.maxSubagents ?? current.maxSubagents,
    subAgentIds: patch.subAgentIds ?? current.subAgentIds,
    temperature: patch.temperature ?? current.temperature,
    mcpEnabled: patch.mcpEnabled ?? current.mcpEnabled,
    authorizationMode: patch.authorizationMode ?? current.authorizationMode,
    budgetEurMinor: patch.budgetEurMinor ?? current.budgetEurMinor,
    maxIterations: patch.maxIterations ?? current.maxIterations, tools: patch.tools ?? current.tools,
    memoryEnabled: patch.memoryEnabled ?? current.memoryEnabled, webResearchEnabled: patch.webResearchEnabled ?? current.webResearchEnabled,
    documentGenerationEnabled: patch.documentGenerationEnabled ?? current.documentGenerationEnabled, voiceEnabled: patch.voiceEnabled ?? current.voiceEnabled,
    voiceConfig: patch.voiceConfig ?? current.voiceConfig, status: patch.status ?? current.status,
  });
  // Si l'identité ou le périmètre change et qu'aucun prompt explicite n'est
  // fourni, la charte est régénérée pour refléter la nouvelle configuration.
  if (patch.systemPrompt === undefined && (!merged.systemPrompt || merged.systemPrompt.trim().length < 10)) {
    merged.systemPrompt = buildAgentCharter(merged);
  }
  await adminDb.collection(COLLECTION).doc(agentId).set({ ...merged, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return getAgentForOwner(ownerId, agentId);
}
export async function deleteAgentForOwner(ownerId: string, agentId: string): Promise<boolean> {
  const current = await getAgentForOwner(ownerId, agentId); if (!current) return false;
  await adminDb.collection(COLLECTION).doc(agentId).delete(); return true;
}

/** Mise à jour org-aware : écriture propriétaire OU owner/admin de l'org. */
export async function updateAgentForUser(userId: string, agentId: string, patch: Partial<AgentRecordInput> & { orgId?: string }): Promise<AgentRecord | null> {
  const snap = await adminDb.collection(COLLECTION).doc(agentId).get(); if (!snap.exists) return null;
  const data = snap.data() as AgentDoc | undefined; if (!data) return null;
  try {
    await assertResourceWrite(userId, { ownerId: data.ownerId, orgId: typeof data.orgId === "string" ? data.orgId : null });
    // Transfert d'organisation : la destination doit être une org dont le
    // gestionnaire fait partie (undefined = inchangé ; "" = détachement).
    await assertOrgTransfer(userId, { ownerId: data.ownerId, orgId: typeof data.orgId === "string" ? data.orgId : null }, patch.orgId);
  } catch {
    return null;
  }
  const nextOrgId = patch.orgId === undefined ? (typeof data.orgId === "string" ? data.orgId : undefined) : (patch.orgId.trim() || undefined);
  const merged = AgentRecordSchema.parse({
    name: patch.name ?? data.name ?? "Agent", description: patch.description ?? data.description ?? "",
    type: patch.type ?? data.type ?? "universal",
    typeLabel: patch.typeLabel ?? data.typeLabel, skills: patch.skills ?? data.skills ?? [],
    agentMode: patch.agentMode ?? data.agentMode ?? "standard",
    memoryFile: patch.memoryFile ?? data.memoryFile,
    projectId: patch.projectId ?? data.projectId, orgId: nextOrgId,
    systemPrompt: patch.systemPrompt ?? data.systemPrompt,
    modelStrategy: patch.modelStrategy ?? data.modelStrategy ?? "automatic",
    preferredProvider: patch.preferredProvider ?? data.preferredProvider, preferredModel: patch.preferredModel ?? data.preferredModel,
    autonomous: patch.autonomous ?? data.autonomous ?? true,
    subagentsEnabled: patch.subagentsEnabled ?? data.subagentsEnabled ?? true,
    maxSubagents: patch.maxSubagents ?? data.maxSubagents ?? 3,
    subAgentIds: patch.subAgentIds ?? data.subAgentIds ?? [],
    temperature: patch.temperature ?? data.temperature ?? 0.7,
    mcpEnabled: patch.mcpEnabled ?? data.mcpEnabled ?? true,
    authorizationMode: patch.authorizationMode ?? data.authorizationMode ?? "always_ask",
    budgetEurMinor: patch.budgetEurMinor ?? data.budgetEurMinor,
    maxIterations: patch.maxIterations ?? data.maxIterations ?? 8, tools: patch.tools ?? data.tools ?? [],
    memoryEnabled: patch.memoryEnabled ?? data.memoryEnabled ?? true,
    webResearchEnabled: patch.webResearchEnabled ?? data.webResearchEnabled ?? true,
    documentGenerationEnabled: patch.documentGenerationEnabled ?? data.documentGenerationEnabled ?? true,
    voiceEnabled: patch.voiceEnabled ?? data.voiceEnabled ?? false,
    voiceConfig: patch.voiceConfig ?? data.voiceConfig,
    status: patch.status ?? data.status ?? "active",
    persona: patch.persona ?? data.persona,
  });
  // Si l'identité ou le périmètre change et qu'aucun prompt explicite n'est
  // fourni, la charte est régénérée pour refléter la nouvelle configuration.
  if (patch.systemPrompt === undefined && (!merged.systemPrompt || merged.systemPrompt.trim().length < 10)) {
    merged.systemPrompt = buildAgentCharter(merged);
  }
  await adminDb.collection(COLLECTION).doc(agentId).set({ ...merged, ownerId: data.ownerId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return getAgentForUser(userId, agentId);
}

/** Suppression org-aware : écriture propriétaire OU owner/admin de l'org. */
export async function deleteAgentForUser(userId: string, agentId: string): Promise<boolean> {
  const snap = await adminDb.collection(COLLECTION).doc(agentId).get(); if (!snap.exists) return false;
  const data = snap.data() as AgentDoc | undefined; if (!data) return false;
  try {
    await assertResourceWrite(userId, { ownerId: data.ownerId, orgId: typeof data.orgId === "string" ? data.orgId : null });
  } catch {
    return false;
  }
  await adminDb.collection(COLLECTION).doc(agentId).delete(); return true;
}
export async function countActiveAgentsOfType(ownerId: string, type: string): Promise<number> {
  const snapshot = await adminDb.collection(COLLECTION).where("ownerId", "==", ownerId).where("type", "==", type).where("status", "==", "active").limit(5).get(); return snapshot.size;
}
export function toSummary(record: AgentRecord): AgentSummary {
  return { id: record.id, name: record.name, description: record.description, type: record.type, typeLabel: record.typeLabel, skills: record.skills, agentMode: record.agentMode, memoryFile: record.memoryFile, projectId: record.projectId, orgId: record.orgId, status: record.status,
    modelStrategy: record.modelStrategy, preferredProvider: record.preferredProvider, preferredModel: record.preferredModel, autonomous: record.autonomous,
    subagentsEnabled: record.subagentsEnabled,
    maxSubagents: record.maxSubagents,
    maxIterations: record.maxIterations, tools: record.tools, memoryEnabled: record.memoryEnabled, webResearchEnabled: record.webResearchEnabled,
    documentGenerationEnabled: record.documentGenerationEnabled, voiceEnabled: record.voiceEnabled, voiceConfig: record.voiceConfig,
    persona: record.persona,
    createdAt: record.createdAt, updatedAt: record.updatedAt };
}
