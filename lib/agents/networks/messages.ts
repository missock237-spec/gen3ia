import "server-only";

import { randomUUID } from "node:crypto";

import { adminDb } from "@/lib/firebase/admin";

import { getNetwork } from "./repository";
import type { NetworkView } from "./types";

/**
 * MESSAGERIE AGENT-À-AGENT (concepts #3/#8) : le bus qui manquait pour
 * qu'une équipe d'agents COLLABORE au-delà d'une exécution — un agent peut
 * adresser un message à un coéquipier (outil `network.send_message`) et lire
 * sa boîte de réception (`network.read_inbox`). Les messages sont Firestore
 * (collection `agentMessages`), propriétaire-scopés, et valident que
 * l'ÉMETTEUR et le DESTINATAIRE sont membres du MÊME réseau — aucune
 * conversation inter-propriétaires n'est possible.
 */

const COLLECTION = "agentMessages";
const BODY_LIMIT = 8_000;
const SUBJECT_LIMIT = 200;

export interface AgentMessageDoc {
  id: string;
  networkId: string;
  userId: string;
  orgId?: string;
  fromAgentId: string;
  toAgentId: string;
  subject?: string;
  body: string;
  threadId?: string;
  readAtMs?: number;
  createdAtMs: number;
}

export interface AgentMessageView {
  id: string;
  networkId: string;
  fromAgentId: string;
  toAgentId: string;
  subject?: string;
  body: string;
  threadId?: string;
  readAtMs?: number;
  createdAtMs: number;
}

function toView(doc: AgentMessageDoc): AgentMessageView {
  return {
    id: doc.id,
    networkId: doc.networkId,
    fromAgentId: doc.fromAgentId,
    toAgentId: doc.toAgentId,
    ...(doc.subject ? { subject: doc.subject } : {}),
    body: doc.body,
    ...(doc.threadId ? { threadId: doc.threadId } : {}),
    ...(doc.readAtMs ? { readAtMs: doc.readAtMs } : {}),
    createdAtMs: doc.createdAtMs,
  };
}

export interface SendAgentMessageInput {
  userId: string;
  networkId: string;
  fromAgentId: string;
  toAgentId: string;
  body: string;
  subject?: string;
  threadId?: string;
}

/**
 * Envoie un message d'un agent à un coéquipier. Lève si l'un des deux agents
 * n'appartient pas au réseau (jamais de message hors équipe).
 */
export async function sendAgentMessage(input: SendAgentMessageInput): Promise<AgentMessageView> {
  const body = input.body.trim();
  if (!body) throw new Error("Le corps du message est requis.");
  if (body.length > BODY_LIMIT) throw new Error(`Corps du message trop long (maximum ${BODY_LIMIT} caractères).`);
  if (input.fromAgentId === input.toAgentId) throw new Error("Un agent ne peut pas s'adresser un message à lui-même.");

  const network = await getNetwork(input.userId, input.networkId);
  if (!network || network.status !== "active") throw new Error("Réseau introuvable, inactif ou inaccessible.");
  const memberIds = new Set(network.members.map((member) => member.agentId));
  if (!memberIds.has(input.fromAgentId)) throw new Error("L'agent émetteur n'est pas membre du réseau.");
  if (!memberIds.has(input.toAgentId)) throw new Error("L'agent destinataire n'est pas membre du réseau.");

  const doc: AgentMessageDoc = {
    id: randomUUID(),
    networkId: network.id,
    userId: input.userId,
    ...(network.orgId ? { orgId: network.orgId } : {}),
    fromAgentId: input.fromAgentId,
    toAgentId: input.toAgentId,
    ...(input.subject?.trim() ? { subject: input.subject.trim().slice(0, SUBJECT_LIMIT) } : {}),
    body,
    ...(input.threadId?.trim() ? { threadId: input.threadId.trim().slice(0, 128) } : {}),
    createdAtMs: Date.now(),
  };
  await adminDb.collection(COLLECTION).doc(doc.id).set(doc);
  return toView(doc);
}

/** Boîte de réception d'un agent (messages dont il est le destinataire). */
export async function listAgentInbox(
  userId: string,
  options: { agentId: string; networkId?: string; unreadOnly?: boolean; limit?: number },
): Promise<AgentMessageView[]> {
  let query = adminDb
    .collection(COLLECTION)
    .where("userId", "==", userId)
    .where("toAgentId", "==", options.agentId);
  if (options.networkId) query = query.where("networkId", "==", options.networkId);
  const snapshot = await query.orderBy("createdAtMs", "desc").limit(Math.min(options.limit ?? 25, 50)).get();
  const views = snapshot.docs
    .map((doc) => toView(doc.data() as AgentMessageDoc))
    .filter((message) => (options.unreadOnly ? !message.readAtMs : true));
  return views;
}

/** Marque un message comme lu (propriétaire-scopé, idempotent). */
export async function markMessageRead(userId: string, messageId: string): Promise<void> {
  const ref = adminDb.collection(COLLECTION).doc(messageId);
  const snapshot = await ref.get();
  const data = snapshot.data() as Partial<AgentMessageDoc> | undefined;
  if (!data || data.userId !== userId) throw new Error("Message introuvable ou inaccessible.");
  if (data.readAtMs) return;
  await ref.update({ readAtMs: Date.now() });
}

/** Fil complet (tous les messages d'un même thread, ordre chronologique). */
export async function listThread(userId: string, threadId: string): Promise<AgentMessageView[]> {
  const snapshot = await adminDb
    .collection(COLLECTION)
    .where("userId", "==", userId)
    .where("threadId", "==", threadId)
    .orderBy("createdAtMs", "asc")
    .limit(50)
    .get();
  return snapshot.docs.map((doc) => toView(doc.data() as AgentMessageDoc));
}

/**
 * Décision PURE de sécurité de la messagerie (testée sans Firestore) :
 * un message est possible seulement ENTRE DEUX MEMBRES du même réseau.
 */
export function canAgentsExchange(network: Pick<NetworkView, "members">, fromAgentId: string, toAgentId: string): boolean {
  const ids = new Set(network.members.map((member) => member.agentId));
  return fromAgentId !== toAgentId && ids.has(fromAgentId) && ids.has(toAgentId);
}
