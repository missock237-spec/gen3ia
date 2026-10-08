import { logger } from "@/lib/observability/logger";
import { buildAgentCharter } from "./charter";
import { AgentRecord, AgentRecordSchema, AgentRecordInput, AgentSummary } from "./schema";
import {
  assertOrgAttach,
  assertOrgTransfer,
  assertResourceRead,
  assertResourceWrite,
  listUserOrgIds,
} from "@/lib/tenants/resource-access";
import {
  listJson,
  newUlid,
  readJsonIfExists,
  removeKey,
  userDir,
  userKey,
  writeJson,
} from "@/lib/storage/user-data-store";

/**
 * Dépôt agents — backend Cloudflare R2 (Task 109).
 *
 * Clés canoniques (CONTRAT TASK 109) :
 *  - document agent      : `users/{uid}/agents/{agentId}.json` — doc { v:1, id, ownerId, …champs AgentRecord } ;
 *  - index org           : `orgs/{orgId}/agents/{agentId}.json` — pointeur { v:1, ownerId, agentId },
 *                          écrit/mis à jour/supprimé EN MÊME TEMPS que l'agent (pas de transaction R2 :
 *                          séquence doc → pointeur → index, chaque écriture idempotente) ;
 *  - index global léger  : `agents-index/{agentId}.json` — pointeur { v:1, ownerId, agentId },
 *                          écrit à la création et nettoyé à la suppression.
 *
 * Pourquoi l'index global : getAgentById est appelé SANS contexte utilisateur
 * par les deux seuls appelants réels (app/api/public/agents/[agentId] et
 * app/api/public/commercial/[slug] — chats clients publics). Sur R2, aucune
 * résolution par id seul n'est possible sans index ; un scan de `users/`
 * (coût global, croisé multi-tenant) est interdit. L'index global est la
 * contrepartie minimale : un objet de ~50 octets par agent, maintenu aux
 * mêmes points que le pointeur org.
 *
 * Surface d'API STRICTEMENT identique au backend Firestore (Task 108) :
 * mêmes exports, mêmes signatures, mêmes formes de retour — zéro
 * modification de route nécessaire.
 */

interface AgentDoc { [key: string]: unknown; id?: string; ownerId: string; orgId?: string; createdAt?: string | Date; updatedAt?: string | Date; }

/** Plafond du listing union (identique au LIST_CAP historique). */
const AGENT_LIST_CAP = 100;
/** Comportement Firestore conservé : la requête historique était plafonnée à limit(5). */
const COUNT_CAP = 5;

/* ------------------------------------------------------------------ */
/* Clés R2                                                             */
/* ------------------------------------------------------------------ */

/** Segment de clé R2 sûr (même règle que la fondation user-data-store). */
function assertSegment(value: string, label: string): string {
  const clean = value.trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(clean) || clean.includes("..")) {
    throw new Error(`Identifiant ${label} invalide pour une clé R2.`);
  }
  return clean;
}

/** Document agent chez son propriétaire : users/{uid}/agents/{agentId}.json */
function agentDocKey(ownerId: string, agentId: string): string {
  return userKey(ownerId, "agents", assertSegment(agentId, "agentId"));
}

/** Pointeur d'org : orgs/{orgId}/agents/{agentId}.json */
function orgPointerKey(orgId: string, agentId: string): string {
  return `orgs/${assertSegment(orgId, "orgId")}/agents/${assertSegment(agentId, "agentId")}.json`;
}

/** Index global léger : agents-index/{agentId}.json → { ownerId, agentId }. */
function globalIndexKey(agentId: string): string {
  return `agents-index/${assertSegment(agentId, "agentId")}.json`;
}

/**
 * Horodatage lisible d'un document agent : chaîne ISO (écritures R2) ou
 * Date (défensive) — jamais d'horodatage perdu.
 */
function recordTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  return new Date().toISOString();
}

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
    createdAt: recordTimestamp(data.createdAt),
    updatedAt: recordTimestamp(data.updatedAt),
  };
}

/**
 * Ignore les valeurs undefined d'une couche de fusion — réplique exacte de
 * `ignoreUndefinedProperties: true` (lib/firebase/admin) + set(merge) :
 * un champ fourni à undefined NE ÉCRASE PAS la valeur déjà stockée.
 */
function definedEntries(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/**
 * Résout un agent par son id SEUL via l'index global (appelants sans
 * contexte utilisateur) : index → document chez son propriétaire. Le
 * propriétaire du document doit coïncider avec l'index (fail-closed si
 * incohérence — anti-énumération, indiscernable d'une ressource absente).
 */
async function resolveAgentDocById(agentId: string): Promise<{ ownerId: string; doc: AgentDoc } | null> {
  const pointer = await readJsonIfExists<{ ownerId?: unknown }>(globalIndexKey(agentId));
  const ownerId = typeof pointer?.ownerId === "string" ? pointer.ownerId.trim() : "";
  if (!ownerId) return null;
  const doc = await readJsonIfExists<AgentDoc>(agentDocKey(ownerId, agentId));
  if (!doc || typeof doc.ownerId !== "string" || doc.ownerId !== ownerId) return null;
  return { ownerId, doc };
}

/** Supprime le document + pointeur org + index global (dans cet ordre). */
async function removeAgentArtifacts(ownerId: string, agentId: string, orgId?: string): Promise<void> {
  await removeKey(agentDocKey(ownerId, agentId));
  if (typeof orgId === "string" && orgId) await removeKey(orgPointerKey(orgId, agentId));
  await removeKey(globalIndexKey(agentId));
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
  // id ULID : tri lexicographique des clés R2 = ordre chronologique.
  const id = newUlid();
  const now = new Date().toISOString();
  const payload = { v: 1, ...values, id, ownerId, createdAt: now, updatedAt: now } satisfies AgentDoc;
  await writeJson(agentDocKey(ownerId, id), payload);
  // Pointeur org écrit en même temps que l'agent.
  if (orgId) await writeJson(orgPointerKey(orgId, id), { v: 1, ownerId, agentId: id });
  // Index global léger : résolution par id seul (routes publiques).
  await writeJson(globalIndexKey(id), { v: 1, ownerId, agentId: id });
  return toRecord(id, payload);
}

export async function listAgentsByOwner(ownerId: string, projectId?: string): Promise<AgentRecord[]> {
  // Scan préfixe borné (cap 500 clés par la fondation R2) + filtres mémoire +
  // tri createdAt desc + plafond 100 : index-safe par construction (aucun
  // index composite requis, contrairement à Firestore).
  const docs = await listJson<AgentDoc>(userDir(ownerId, "agents"));
  return docs
    .filter(d => d.status !== "archived")
    .filter(d => !projectId || d.projectId === projectId)
    .map(d => toRecord(typeof d.id === "string" && d.id ? d.id : "", d))
    .filter(r => r.id !== "")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, AGENT_LIST_CAP);
}

/**
 * Liste union org-aware (recommandation C) : agents personnels + agents des
 * organisations dont l'utilisateur est membre. Le listing des agents d'une
 * org passe par les pointeurs `orgs/{orgId}/agents/` puis la lecture de
 * chaque agent CHEZ SON PROPRIÉTAIRE ; fusion dédupliquée par id, tri
 * createdAt desc, plafond 100.
 */
export async function listAgentsForUser(userId: string, projectId?: string): Promise<AgentRecord[]> {
  const personal = await listAgentsByOwner(userId, projectId);
  // Fail-soft conservé : si l'index d'appartenance aux organisations est
  // injoignable, on livre AU MOINS les agents personnels au lieu d'un 500 —
  // la section Agent IA reste ouverte.
  let orgIds: string[] = [];
  try {
    orgIds = await listUserOrgIds(userId);
  } catch (error) {
    logger.warn({ err: error }, "list_user_org_ids_failed_failsoft");
    return personal;
  }
  if (orgIds.length === 0) return personal;

  const byId = new Map<string, AgentRecord>();
  for (const record of personal) byId.set(record.id, record);
  try {
    for (const orgId of orgIds) {
      // Pointeurs de l'org (cap 500 par la fondation) ; un pointeur orphelin
      // (agent déjà supprimé) est simplement ignoré.
      const pointers = await listJson<{ ownerId?: unknown; agentId?: unknown }>(
        `orgs/${assertSegment(orgId, "orgId")}/agents`,
      );
      for (const pointer of pointers) {
        const ownerId = typeof pointer.ownerId === "string" ? pointer.ownerId : "";
        const agentId = typeof pointer.agentId === "string" ? pointer.agentId : "";
        if (!ownerId || !agentId || byId.has(agentId)) continue;
        const doc = await readJsonIfExists<AgentDoc>(agentDocKey(ownerId, agentId));
        if (!doc || doc.status === "archived") continue;
        if (projectId && doc.projectId !== projectId) continue;
        byId.set(agentId, toRecord(agentId, doc));
      }
    }
  } catch (error) {
    logger.warn({ err: error }, "list_org_agents_failed_failsoft");
    return personal;
  }
  return [...byId.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, AGENT_LIST_CAP);
}

/**
 * Lecture globale par id (SANS contexte utilisateur) : résolue via l'index
 * global léger `agents-index/{agentId}.json` — les appelants réels sont les
 * routes publiques (chats clients). Seul un agent `active` est renvoyé
 * (comportement historique conservé).
 */
export async function getAgentById(agentId: string): Promise<AgentRecord | null> {
  const resolved = await resolveAgentDocById(agentId);
  if (!resolved || resolved.doc.status !== "active") return null;
  return toRecord(agentId, resolved.doc);
}

export async function getAgentForOwner(ownerId: string, agentId: string): Promise<AgentRecord | null> {
  // Lecture par clé directe chez le propriétaire déclaré : un autre uid
  // ne peut même pas localiser le document (cloisonnement par préfixe).
  const data = await readJsonIfExists<AgentDoc>(agentDocKey(ownerId, agentId));
  if (!data || data.ownerId !== ownerId) return null;
  return toRecord(agentId, data);
}

/**
 * Accès org-aware (recommandation C) : le propriétaire garde l'accès
 * intégral ; une ressource rattachée à une organisation est lisible par ses
 * membres (rôle member) et gérable par owner/admin de l'org. La dénégation
 * renvoie null (indiscernable d'une ressource absente — anti-énumération).
 */
export async function getAgentForUser(userId: string, agentId: string): Promise<AgentRecord | null> {
  const resolved = await resolveAgentDocById(agentId);
  if (!resolved) return null;
  try {
    // Ressource personnelle : la politique (ownerId === userId) tranche sans
    // I/O org. Ressource d'org : le contexte org est consulté ; son échec
    // interne renvoie null (fail-closed).
    await assertResourceRead(userId, { ownerId: resolved.doc.ownerId, orgId: typeof resolved.doc.orgId === "string" ? resolved.doc.orgId : null });
  } catch {
    return null;
  }
  return toRecord(agentId, resolved.doc);
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
  // Sémantique Firestore conservée : set(merge) + ignoreUndefinedProperties —
  // les champs non fournis (persona, orgId, createdAt…) sont PRÉSERVÉS.
  const nextDoc = {
    v: 1,
    ...current,
    ...definedEntries(merged as unknown as Record<string, unknown>),
    id: agentId,
    ownerId,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  } satisfies AgentDoc;
  await writeJson(agentDocKey(ownerId, agentId), nextDoc);
  return getAgentForOwner(ownerId, agentId);
}

export async function deleteAgentForOwner(ownerId: string, agentId: string): Promise<boolean> {
  const current = await getAgentForOwner(ownerId, agentId); if (!current) return false;
  await removeAgentArtifacts(ownerId, agentId, current.orgId); return true;
}

/** Mise à jour org-aware : écriture propriétaire OU owner/admin de l'org. */
export async function updateAgentForUser(userId: string, agentId: string, patch: Partial<AgentRecordInput> & { orgId?: string }): Promise<AgentRecord | null> {
  const resolved = await resolveAgentDocById(agentId); if (!resolved) return null;
  const { ownerId, doc: data } = resolved;
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
  // Sémantique Firestore conservée (set(merge) + ignoreUndefinedProperties) :
  // orgId n'est remplacé QUE si nextOrgId est défini — le détachement via
  // "" conserve le rattachement courant, exactement comme avant la migration.
  const nextDoc = {
    v: 1,
    ...data,
    ...definedEntries(merged as unknown as Record<string, unknown>),
    id: agentId,
    ownerId: data.ownerId,
    createdAt: recordTimestamp(data.createdAt),
    updatedAt: new Date().toISOString(),
  } satisfies AgentDoc;
  await writeJson(agentDocKey(ownerId, agentId), nextDoc);
  // Réindexation org sur les pointeurs R2 : l'ancien pointeur est retiré, le
  // nouveau écrit — en même temps que le document (aucun pointeur résiduel
  // vers un agent qui n'y est plus rattaché).
  if (nextOrgId && nextOrgId !== data.orgId) {
    if (typeof data.orgId === "string" && data.orgId) await removeKey(orgPointerKey(data.orgId, agentId));
    await writeJson(orgPointerKey(nextOrgId, agentId), { v: 1, ownerId: data.ownerId, agentId });
  }
  return getAgentForUser(userId, agentId);
}

/** Suppression org-aware : écriture propriétaire OU owner/admin de l'org. */
export async function deleteAgentForUser(userId: string, agentId: string): Promise<boolean> {
  const resolved = await resolveAgentDocById(agentId); if (!resolved) return false;
  try {
    await assertResourceWrite(userId, { ownerId: resolved.doc.ownerId, orgId: typeof resolved.doc.orgId === "string" ? resolved.doc.orgId : null });
  } catch {
    return false;
  }
  await removeAgentArtifacts(resolved.ownerId, agentId, typeof resolved.doc.orgId === "string" ? resolved.doc.orgId : undefined);
  return true;
}

export async function countActiveAgentsOfType(ownerId: string, type: string): Promise<number> {
  // Comportement Firestore conservé : la requête historique était plafonnée
  // à limit(5) — le compteur s'arrête donc à 5 (le seul appelant, la garde
  // « agent de code », ne teste que count === 0).
  const docs = await listJson<AgentDoc>(userDir(ownerId, "agents"));
  return Math.min(docs.filter(d => d.type === type && d.status === "active").length, COUNT_CAP);
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
