import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";
import { listAgentInbox, markMessageRead, sendAgentMessage } from "./messages";
import { listNetworks } from "./repository";
import type { NetworkView } from "./types";

/**
 * OUTILS D'ÉQUIPE (concepts #3 « Agent-as-a-Company » et #8 « Personal AI
 * Network ») : les agents du Studio peuvent DÉCOUVRIR leurs équipes,
 * S'ADRESSER des messages entre coéquipiers et LIRE leur boîte de réception.
 * Opérations internes (Firestore, aucun réseau ni fichier) : le risque HITL
 * de l'écriture est porté par la définition de sécurité (tool-permissions).
 *
 * Sécurité : tout est propriétaire-scopé via les fonctions de dépôt — un
 * agent ne peut écrire que DANS ses réseaux réels, à un coéquipier du MÊME
 * réseau. L'identité de l'ÉMETTEUR est fournie par l'appelant outillé
 * (runtime / route) et revérifiée contre la composition du réseau.
 */

const SEND_INPUT = z.object({
  /** Réseau dans lequel le message circule (les deux agents doivent être membres). */
  networkId: z.string().trim().min(1).max(128),
  /** Agent ÉMETTEUR (membre du réseau). */
  fromAgentId: z.string().trim().min(1).max(128),
  /** Agent DESTINATAIRE (membre du même réseau). */
  toAgentId: z.string().trim().min(1).max(128),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1).max(8_000),
  threadId: z.string().trim().max(128).optional(),
});

const LIST_INPUT = z.object({});

const INBOX_INPUT = z.object({
  agentId: z.string().trim().min(1).max(128),
  networkId: z.string().trim().max(128).optional(),
  unreadOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const MARK_READ_INPUT = z.object({ messageId: z.string().trim().min(1).max(128) });

function networkSummary(network: NetworkView) {
  return {
    id: network.id,
    name: network.name,
    topology: network.topology,
    status: network.status,
    ...(network.description ? { description: network.description } : {}),
    ...(network.coordinatorAgentId ? { coordinatorAgentId: network.coordinatorAgentId } : {}),
    members: network.members.map((member) => ({
      agentId: member.agentId,
      role: member.role,
      ...(member.department ? { department: member.department } : {}),
    })),
  };
}

/** Liste les équipes de l'utilisateur (découverte : « avec qui travaillé-je ? »). */
export const networkListTool: ToolDefinition<z.infer<typeof LIST_INPUT>, unknown> = {
  name: "network.list",
  description: "Liste les équipes (réseaux) d'agents du propriétaire : membres, rôles, départements, topologie.",
  category: "system",
  risk: "low",
  inputSchema: LIST_INPUT,
  async execute(_input, context) {
    const networks = await listNetworks(context.userId, { includeArchived: false });
    return { networks: networks.map(networkSummary) };
  },
};

export const networkSendMessageTool: ToolDefinition<z.infer<typeof SEND_INPUT>, unknown> = {
  name: "network.send_message",
  description: "Envoie un message à un agent coéquipier du MÊME réseau (collaboration agent-à-agent persistante).",
  category: "system",
  risk: "medium",
  inputSchema: SEND_INPUT,
  async execute(input, context) {
    const message = await sendAgentMessage({
      userId: context.userId,
      networkId: input.networkId,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      body: input.body,
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });
    return { sent: true, messageId: message.id, toAgentId: message.toAgentId, createdAtMs: message.createdAtMs };
  },
};

export const networkReadInboxTool: ToolDefinition<z.infer<typeof INBOX_INPUT>, unknown> = {
  name: "network.read_inbox",
  description: "Lit la boîte de réception d'un agent (messages reçus de ses coéquipiers).",
  category: "system",
  risk: "low",
  inputSchema: INBOX_INPUT,
  async execute(input, context) {
    const messages = await listAgentInbox(context.userId, {
      agentId: input.agentId,
      ...(input.networkId ? { networkId: input.networkId } : {}),
      ...(input.unreadOnly !== undefined ? { unreadOnly: input.unreadOnly } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    });
    return { messages };
  },
};

export const networkMarkReadTool: ToolDefinition<z.infer<typeof MARK_READ_INPUT>, unknown> = {
  name: "network.mark_read",
  description: "Marque un message d'équipe comme lu.",
  category: "system",
  risk: "low",
  inputSchema: MARK_READ_INPUT,
  async execute(input, context) {
    await markMessageRead(context.userId, input.messageId);
    return { ok: true };
  },
};

/** Compteur de boîte de réception non lue (plafonné 50 — sonde UI). */
export async function countUnreadMessages(userId: string, agentId: string): Promise<number> {
  const messages = await listAgentInbox(userId, { agentId, unreadOnly: true, limit: 50 });
  return messages.length;
}
