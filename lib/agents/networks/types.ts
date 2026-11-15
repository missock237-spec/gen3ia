import { z } from "zod";

/**
 * RÉSEAUX D'AGENTS PERSISTANTS (concepts post-SaaS #3 « Agent-as-a-Company »
 * et #8 « Personal AI Network »).
 *
 * Un réseau est une ÉQUIPE DURABLE d'agents du Studio d'un même propriétaire
 * (ou d'une même organisation) : rôles, départements, topologie
 * (coordinateur → exécutants ou pairs), mémoire d'équipe. Il survit aux
 * exécutions — contrairement aux équipes éphémères de l'orchestrateur — et
 * sert de vérité d'organisation pour les missions d'équipe, la messagerie
 * agent-à-agent et le partage de mémoire.
 */

export const NetworkTopologySchema = z.enum(["coordinator", "peer"]);
export type NetworkTopology = z.infer<typeof NetworkTopologySchema>;

export const NetworkMemberSchema = z.object({
  /** Agent réel du Studio (validé à l'écriture : possédé, actif). */
  agentId: z.string().trim().min(1).max(128),
  /** Rôle fonctionnel dans l'équipe (ex. « Rédacteur », « Relecteur »). */
  role: z.string().trim().min(1).max(80),
  /** Département optionnel (ex. « Marketing », « Support »). */
  department: z.string().trim().max(80).optional(),
});

export const NetworkStatusSchema = z.enum(["active", "archived"]);

export const CreateNetworkSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).optional(),
  topology: NetworkTopologySchema.default("coordinator"),
  members: z.array(NetworkMemberSchema).min(1).max(20),
  /** Agent coordinateur (topologie "coordinator") : doit être membre. */
  coordinatorAgentId: z.string().trim().min(1).max(128).optional(),
  /** Organisation propriétaire (Task 58) : l'appelant doit en être membre. */
  orgId: z.string().trim().min(1).max(128).optional(),
});

export const UpdateNetworkSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2_000).optional(),
    topology: NetworkTopologySchema.optional(),
    members: z.array(NetworkMemberSchema).min(1).max(20).optional(),
    coordinatorAgentId: z.string().trim().min(1).max(128).optional(),
    status: NetworkStatusSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Aucune modification fournie." });

export type NetworkMember = z.infer<typeof NetworkMemberSchema>;

export interface NetworkDoc {
  id: string;
  userId: string;
  /** Organisation propriétaire (Task 58) — présent si créée depuis un contexte d'organisation. */
  orgId?: string;
  name: string;
  description?: string;
  topology: NetworkTopology;
  members: NetworkMember[];
  coordinatorAgentId?: string;
  status: "active" | "archived";
  createdAtMs: number;
  updatedAtMs: number;
}

/** Vue réseau renvoyée au client (jamais de donnée interne supplémentaire). */
export interface NetworkView {
  id: string;
  name: string;
  description?: string;
  topology: NetworkTopology;
  members: NetworkMember[];
  coordinatorAgentId?: string;
  status: NetworkDoc["status"];
  orgId?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export function toNetworkView(doc: NetworkDoc): NetworkView {
  return {
    id: doc.id,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    topology: doc.topology,
    members: doc.members,
    ...(doc.coordinatorAgentId ? { coordinatorAgentId: doc.coordinatorAgentId } : {}),
    status: doc.status,
    ...(doc.orgId ? { orgId: doc.orgId } : {}),
    createdAtMs: doc.createdAtMs,
    updatedAtMs: doc.updatedAtMs,
  };
}

/** Invariants métier partagés création / mise à jour (testés sans Firestore). */
export function validateNetworkInvariants(input: {
  topology: NetworkTopology;
  members: NetworkMember[];
  coordinatorAgentId?: string;
}): { ok: true } | { ok: false; error: string } {
  const ids = input.members.map((member) => member.agentId);
  if (new Set(ids).size !== ids.length) {
    return { ok: false, error: "Un même agent ne peut figurer qu'une fois dans le réseau." };
  }
  if (input.topology === "coordinator") {
    if (!input.coordinatorAgentId) {
      return { ok: false, error: "La topologie « coordinator » exige un agent coordinateur." };
    }
    if (!ids.includes(input.coordinatorAgentId)) {
      return { ok: false, error: "L'agent coordinateur doit être membre du réseau." };
    }
  }
  return { ok: true };
}
