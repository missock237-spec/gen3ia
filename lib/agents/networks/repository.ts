import "server-only";

import { randomUUID } from "node:crypto";

import { adminDb } from "@/lib/firebase/admin";
import { assertOrgAttach } from "@/lib/tenants/resource-access";
import { getAgentForUser } from "@/lib/agents/repository";

import {
  CreateNetworkSchema,
  UpdateNetworkSchema,
  toNetworkView,
  validateNetworkInvariants,
  type NetworkDoc,
  type NetworkView,
} from "./types";

/**
 * Dépôt des réseaux d'agents persistants (collection Firestore
 * `agentNetworks`). Chaque agent membre est VALIDÉ à l'écriture : il doit
 * exister, être actif et être accessible au propriétaire (getAgentForUser —
 * couvre le cloisonnement multi-tenant via assertResourceRead). Les vues
 * sont propriétaire-scopées ; l'orgId est validé par assertOrgAttach AVANT
 * toute écriture (même garde que /api/agents/run, Task 58).
 */

const COLLECTION = "agentNetworks";

function networkRef(id: string) {
  return adminDb.collection(COLLECTION).doc(id);
}

/** Vérifie tous les membres : existants, actifs, accessibles au propriétaire. */
export async function validateNetworkMembers(userId: string, agentIds: string[]): Promise<void> {
  for (const agentId of agentIds) {
    const agent = await getAgentForUser(userId, agentId);
    if (!agent || agent.status !== "active") {
      throw new Error(`Agent membre introuvable ou inactif : ${agentId.slice(0, 64)}`);
    }
  }
}

export async function createNetwork(
  userId: string,
  input: unknown,
): Promise<NetworkView> {
  const parsed = CreateNetworkSchema.parse(input);
  const invariants = validateNetworkInvariants({
    topology: parsed.topology,
    members: parsed.members,
    ...(parsed.coordinatorAgentId ? { coordinatorAgentId: parsed.coordinatorAgentId } : {}),
  });
  if (!invariants.ok) throw new Error(invariants.error);

  // Organisation : l'appelant doit en être membre (404 anti-énumération sinon).
  if (parsed.orgId) await assertOrgAttach(userId, parsed.orgId);

  await validateNetworkMembers(userId, parsed.members.map((member) => member.agentId));

  const now = Date.now();
  const doc: NetworkDoc = {
    id: randomUUID(),
    userId,
    ...(parsed.orgId ? { orgId: parsed.orgId } : {}),
    name: parsed.name,
    ...(parsed.description ? { description: parsed.description } : {}),
    topology: parsed.topology,
    members: parsed.members,
    ...(parsed.coordinatorAgentId ? { coordinatorAgentId: parsed.coordinatorAgentId } : {}),
    status: "active",
    createdAtMs: now,
    updatedAtMs: now,
  };
  await networkRef(doc.id).set(doc);
  return toNetworkView(doc);
}

export async function getNetwork(userId: string, networkId: string): Promise<NetworkView | null> {
  const snapshot = await networkRef(networkId).get();
  if (!snapshot.exists) return null;
  const data = snapshot.data() as Partial<NetworkDoc> | undefined;
  if (!data || data.userId !== userId) return null; // 404 anti-énumération
  return toNetworkView(data as NetworkDoc);
}

export async function listNetworks(
  userId: string,
  options: { orgId?: string; includeArchived?: boolean } = {},
): Promise<NetworkView[]> {
  let query = adminDb.collection(COLLECTION).where("userId", "==", userId);
  if (options.orgId) query = query.where("orgId", "==", options.orgId);
  const snapshot = await query.orderBy("createdAtMs", "desc").limit(100).get();
  const views = snapshot.docs
    .map((doc) => toNetworkView(doc.data() as NetworkDoc))
    .filter((network) => options.includeArchived || network.status === "active");
  return views;
}

export async function updateNetwork(
  userId: string,
  networkId: string,
  patch: unknown,
): Promise<NetworkView> {
  const parsed = UpdateNetworkSchema.parse(patch);
  const current = await getNetwork(userId, networkId);
  if (!current) throw new Error("Réseau introuvable ou inaccessible.");

  const members = parsed.members ?? current.members;
  const topology = parsed.topology ?? current.topology;
  const coordinatorAgentId = "coordinatorAgentId" in parsed ? parsed.coordinatorAgentId : current.coordinatorAgentId;
  const invariants = validateNetworkInvariants({
    topology,
    members,
    ...(coordinatorAgentId ? { coordinatorAgentId } : {}),
  });
  if (!invariants.ok) throw new Error(invariants.error);

  if (parsed.members) {
    await validateNetworkMembers(userId, parsed.members.map((member) => member.agentId));
  }

  const now = Date.now();
  const updated: Partial<NetworkDoc> = {
    ...(parsed.name ? { name: parsed.name } : {}),
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    ...(parsed.topology ? { topology: parsed.topology } : {}),
    ...(parsed.members ? { members: parsed.members } : {}),
    ...(parsed.coordinatorAgentId !== undefined ? { coordinatorAgentId: parsed.coordinatorAgentId } : {}),
    ...(parsed.status ? { status: parsed.status } : {}),
    updatedAtMs: now,
  };
  await networkRef(networkId).update(updated);
  const refreshed = await getNetwork(userId, networkId);
  if (!refreshed) throw new Error("Réseau introuvable après mise à jour.");
  return refreshed;
}

/** Suppression réelle (le propriétaire garde ses agents — seul le lien d'équipe disparaît). */
export async function deleteNetwork(userId: string, networkId: string): Promise<void> {
  const current = await getNetwork(userId, networkId);
  if (!current) throw new Error("Réseau introuvable ou inaccessible.");
  await networkRef(networkId).delete();
}
