import { z } from "zod";

import type {
  ToolContext,
  ToolDefinition,
} from "@/lib/tools/types";

import {
  getComposio,
} from "./client";
import { listHubConnections } from "./connections";
import { ConnectorMissingError } from "./errors";

export interface ComposioToolInfo {
  slug: string;
  name?: string;
  description?: string;
  toolkit?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export async function getComposioTools(
  userId: string,
  toolkits?: string[],
): Promise<unknown> {
  const composio =
    getComposio();

  return composio.tools.get(
    userId,
    toolkits && toolkits.length > 0
      ? { toolkits }
      : { toolkits: [] },
  );
}

export async function executeComposioTool(
  params: {
    userId: string;
    toolSlug: string;
    arguments: Record<
      string,
      unknown
    >;
    connectedAccountId?: string;
    version?: string;
    signal?: AbortSignal;
  },
) {
  const composio =
    getComposio();

  const version =
    params.version ??
    process.env.COMPOSIO_TOOLKIT_VERSION;

  if (version) {
    return composio.tools.execute(
      params.toolSlug,
      {
        userId:
          params.userId,

        ...(params.connectedAccountId ? { connectedAccountId: params.connectedAccountId } : {}),

        version,

        arguments:
          params.arguments,
      },
      {
        signal:
          params.signal,
      },
    );
  }

  return composio.tools.execute(
    params.toolSlug,
    {
      userId:
        params.userId,

      ...(params.connectedAccountId ? { connectedAccountId: params.connectedAccountId } : {}),

      arguments:
        params.arguments,

      dangerouslySkipVersionCheck:
        true,
    },
    {
      signal:
        params.signal,
    },
  );
}

// ─── Task 133 — connecteurs entreprise Zendesk & ServiceNow ─────────────────
//
// Outils dérivés typés (même famille que social.publish) : chaque outil cible
// UNE action du toolkit connecté via le Hub de Connexions, avec un schéma zod
// strict en français. L'exécution passe par le MÊME verrou que composio.execute :
// la connexion OAuth doit être active ET vérifiée côté Composio, et un projet
// développeur peut restreindre l'outil à une connectionId précise.

/**
 * Résout le compte connecté Composio à utiliser pour un toolkit : connexion du
 * hub ACTIVE et vérifiée obligatoire, restreinte à la connexion du projet
 * développeur si ce dernier l'a explicitement désignée. Logique mutualisée
 * avec l'adaptateur générique (composio.execute) — source unique.
 */
export async function resolveVerifiedComposioAccount(
  userId: string,
  toolkit: string,
  projectId?: string,
): Promise<string> {
  const normalized = toolkit.trim().toLowerCase();

  // Un connecteur n'est utilisable que si le compte externe est réellement
  // actif et vérifié côté Composio. Un projet développeur peut ensuite
  // restreindre cette connexion à une connectionId précise.
  const hubConnections = await listHubConnections(userId);
  const verifiedHub = hubConnections.find(
    (item) => item.toolkit === normalized && item.verified && item.enabled,
  );
  if (!verifiedHub) {
    // Task 143 — erreur TYLÉE : le moteur conversationnel reconnaît ce cas
    // et attache la carte « Connecter <App> » (bouton OAuth) à la réponse au
    // lieu de noyer l'échec dans la timeline (voir composio/errors.ts).
    throw new ConnectorMissingError(normalized);
  }

  let connectedAccountId = verifiedHub.id;
  if (projectId) {
    const { listDeveloperProjectConnectors } = await import("@/lib/developer/connectors");
    const connectors = await listDeveloperProjectConnectors(userId, projectId);
    const projectConnector = connectors.find(
      (item) => item.toolkit === normalized && item.status === "active" && item.connectionId === verifiedHub.id,
    );
    if (projectConnector) connectedAccountId = projectConnector.connectionId;
  }
  return connectedAccountId;
}

/** Slugs des actions Composio Zendesk utilisées par les outils dérivés. */
export const ZENDESK_ACTIONS = {
  ticketCreate: "ZENDESK_CREATE_ZENDESK_TICKET",
  ticketUpdate: "ZENDESK_UPDATE_ZENDESK_TICKET",
  ticketSearch: "ZENDESK_SEARCH_ZENDESK",
} as const;

/** Slugs des actions Composio ServiceNow utilisées par les outils dérivés. */
export const SERVICENOW_ACTIONS = {
  incidentCreate: "SERVICENOW_CREATE_INCIDENT",
  incidentUpdate: "SERVICENOW_UPDATE_INCIDENT_BY_ID",
  incidentQuery: "SERVICENOW_GET_INCIDENTS",
} as const;

// ── Zendesk — tickets ────────────────────────────────────────────────────────

/** Priorités de ticket Zendesk (contrat API Zendesk). */
const ZENDESK_PRIORITIES = ["urgent", "high", "normal", "low"] as const;

const ZendeskTicketCreateSchema = z.object({
  subject: z.string().trim().min(3).max(300).describe("Sujet concis du ticket."),
  description: z.string().trim().min(1).max(20_000).describe("Description complète du problème ou de la demande."),
  priority: z.enum(ZENDESK_PRIORITIES).default("normal").describe("Priorité du ticket : urgent, high, normal ou low."),
  type: z.enum(["problem", "incident", "question", "task"]).optional().describe("Type de ticket Zendesk."),
  requesterEmail: z.string().trim().email().max(320).optional().describe("Email du demandeur (associe le ticket à l'utilisateur Zendesk correspondant)."),
  requesterName: z.string().trim().min(1).max(200).optional().describe("Nom du demandeur (utilisé avec l'email)."),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).optional().describe("Étiquettes à appliquer au ticket (20 max)."),
});

export const zendeskTicketCreateTool: ToolDefinition<z.infer<typeof ZendeskTicketCreateSchema>, unknown> = {
  id: "zendesk_ticket_create",
  name: "zendesk_ticket_create",
  description:
    "Crée un ticket Zendesk (sujet, description, priorité, demandeur) via la connexion OAuth établie par l'utilisateur dans le Hub de Connexions.",
  category: "composio",
  risk: "high",
  inputSchema: ZendeskTicketCreateSchema,
  async execute(input, context: ToolContext) {
    if (!context.userId) throw new Error("A user ID is required.");
    const connectedAccountId = await resolveVerifiedComposioAccount(context.userId, "zendesk", context.projectId);
    return executeComposioTool({
      userId: context.userId,
      toolSlug: ZENDESK_ACTIONS.ticketCreate,
      arguments: {
        subject: input.subject,
        description: input.description,
        priority: input.priority,
        ...(input.type ? { ticket_type: input.type } : {}),
        ...(input.requesterEmail ? { requester_email: input.requesterEmail } : {}),
        ...(input.requesterName ? { requester_name: input.requesterName } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
      },
      connectedAccountId,
      signal: context.signal,
    });
  },
};

const ZendeskTicketUpdateSchema = z.object({
  ticketId: z.number().int().positive().describe("Identifiant numérique du ticket Zendesk."),
  status: z.enum(["new", "open", "pending", "hold", "solved"]).optional().describe("Nouveau statut du ticket."),
  priority: z.enum(ZENDESK_PRIORITIES).optional().describe("Nouvelle priorité du ticket."),
  assigneeId: z.number().int().positive().optional().describe("Identifiant de l'agent Zendesk à assigner au ticket."),
  comment: z.string().trim().min(1).max(20_000).optional().describe("Commentaire à ajouter au ticket."),
  commentPublic: z.boolean().default(true).describe("true = commentaire visible par le demandeur ; false = note interne."),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).optional().describe("Nouvelles étiquettes du ticket."),
});

export const zendeskTicketUpdateTool: ToolDefinition<z.infer<typeof ZendeskTicketUpdateSchema>, unknown> = {
  id: "zendesk_ticket_update",
  name: "zendesk_ticket_update",
  description:
    "Met à jour un ticket Zendesk : statut, priorité, assignation, étiquettes et commentaire public ou note interne.",
  category: "composio",
  risk: "high",
  inputSchema: ZendeskTicketUpdateSchema,
  async execute(input, context: ToolContext) {
    if (!context.userId) throw new Error("A user ID is required.");
    const connectedAccountId = await resolveVerifiedComposioAccount(context.userId, "zendesk", context.projectId);
    return executeComposioTool({
      userId: context.userId,
      toolSlug: ZENDESK_ACTIONS.ticketUpdate,
      arguments: {
        ticket_id: input.ticketId,
        ...(input.status ? { status: input.status } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.assigneeId ? { assignee_id: input.assigneeId } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.comment ? { comment_body: input.comment, comment_public: input.commentPublic } : {}),
      },
      connectedAccountId,
      signal: context.signal,
    });
  },
};

const ZendeskTicketListSchema = z.object({
  user: z.string().trim().min(1).max(320).describe("Demandeur ou assigné : identifiant utilisateur Zendesk ou adresse email."),
  scope: z.enum(["requester", "assignee"]).default("requester").describe("Lister les tickets où l'utilisateur est demandeur (requester) ou assigné (assignee)."),
  perPage: z.number().int().min(1).max(100).default(25).describe("Nombre de tickets par page (100 max)."),
  page: z.number().int().min(1).max(100).default(1).describe("Numéro de page (100 max)."),
});

export const zendeskTicketListTool: ToolDefinition<z.infer<typeof ZendeskTicketListSchema>, unknown> = {
  id: "zendesk_ticket_list",
  name: "zendesk_ticket_list",
  description:
    "Liste les tickets ouverts (non résolus) d'un demandeur ou d'un assigné Zendesk, les plus récemment mis à jour d'abord.",
  category: "composio",
  risk: "low",
  inputSchema: ZendeskTicketListSchema,
  async execute(input, context: ToolContext) {
    if (!context.userId) throw new Error("A user ID is required.");
    const connectedAccountId = await resolveVerifiedComposioAccount(context.userId, "zendesk", context.projectId);
    // Syntaxe de recherche Zendesk : tickets non résolus de l'utilisateur,
    // triés par date de mise à jour décroissante.
    const query = `type:ticket status<solved ${input.scope}:${input.user} sort_by:updated_at`;
    return executeComposioTool({
      userId: context.userId,
      toolSlug: ZENDESK_ACTIONS.ticketSearch,
      arguments: {
        query,
        per_page: input.perPage,
        page: input.page,
        sort_by: "updated_at",
        sort_order: "desc",
      },
      connectedAccountId,
      signal: context.signal,
    });
  },
};

const ZendeskTicketSearchSchema = z.object({
  query: z.string().trim().min(2).max(500).describe("Recherche plein texte ; opérateurs Zendesk supportés (ex. « status:open priority:urgent »)."),
  perPage: z.number().int().min(1).max(100).default(10).describe("Nombre de résultats par page (100 max)."),
  page: z.number().int().min(1).max(100).default(1).describe("Numéro de page (100 max)."),
});

export const zendeskTicketSearchTool: ToolDefinition<z.infer<typeof ZendeskTicketSearchSchema>, unknown> = {
  id: "zendesk_ticket_search",
  name: "zendesk_ticket_search",
  description:
    "Recherche en plein texte les tickets Zendesk correspondant à une requête (mots-clés ou opérateurs Zendesk).",
  category: "composio",
  risk: "low",
  inputSchema: ZendeskTicketSearchSchema,
  async execute(input, context: ToolContext) {
    if (!context.userId) throw new Error("A user ID is required.");
    const connectedAccountId = await resolveVerifiedComposioAccount(context.userId, "zendesk", context.projectId);
    // Restreint la recherche aux tickets (l'API Zendesk couvre aussi users,
    // organizations, articles… — l'outil est dédié aux tickets).
    return executeComposioTool({
      userId: context.userId,
      toolSlug: ZENDESK_ACTIONS.ticketSearch,
      arguments: {
        query: `type:ticket ${input.query}`,
        per_page: input.perPage,
        page: input.page,
      },
      connectedAccountId,
      signal: context.signal,
    });
  },
};

// ── ServiceNow — incidents ITSM ───────────────────────────────────────────────

/** Urgences ServiceNow (contrat standard : 1 = haute, 2 = moyenne, 3 = basse). */
const SERVICENOW_URGENCY = ["1", "2", "3"] as const;
/** Impacts métier ServiceNow (1 = élevé, 2 = moyen, 3 = faible). */
const SERVICENOW_IMPACT = ["1", "2", "3"] as const;
/** États d'incident ServiceNow (contrat standard). */
const SERVICENOW_STATES = ["1", "2", "3", "4", "5", "6"] as const;

const ServiceNowIncidentCreateSchema = z.object({
  shortDescription: z.string().trim().min(3).max(500).describe("Brève description (résumé) de l'incident."),
  description: z.string().trim().min(1).max(20_000).optional().describe("Description détaillée de l'incident."),
  urgency: z.enum(SERVICENOW_URGENCY).default("2").describe("Urgence : 1 = haute, 2 = moyenne, 3 = basse."),
  impact: z.enum(SERVICENOW_IMPACT).default("2").describe("Impact métier : 1 = élevé, 2 = moyen, 3 = faible."),
  category: z.string().trim().min(2).max(100).optional().describe("Catégorie de l'incident (ex. « network », « hardware », « software », « database »)."),
  comments: z.string().trim().min(1).max(20_000).optional().describe("Commentaires visibles par l'utilisateur final."),
  workNotes: z.string().trim().min(1).max(20_000).optional().describe("Notes de travail internes (invisibles pour l'utilisateur final)."),
});

export const servicenowIncidentCreateTool: ToolDefinition<z.infer<typeof ServiceNowIncidentCreateSchema>, unknown> = {
  id: "servicenow_incident_create",
  name: "servicenow_incident_create",
  description:
    "Crée un incident ServiceNow (brève description, urgence, impact, description détaillée) via la connexion OAuth de l'utilisateur.",
  category: "composio",
  risk: "high",
  inputSchema: ServiceNowIncidentCreateSchema,
  async execute(input, context: ToolContext) {
    if (!context.userId) throw new Error("A user ID is required.");
    const connectedAccountId = await resolveVerifiedComposioAccount(context.userId, "servicenow", context.projectId);
    return executeComposioTool({
      userId: context.userId,
      toolSlug: SERVICENOW_ACTIONS.incidentCreate,
      arguments: {
        short_description: input.shortDescription,
        urgency: input.urgency,
        impact: input.impact,
        ...(input.description ? { description: input.description } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.comments ? { comments: input.comments } : {}),
        ...(input.workNotes ? { work_notes: input.workNotes } : {}),
      },
      connectedAccountId,
      signal: context.signal,
    });
  },
};

const ServiceNowIncidentUpdateSchema = z.object({
  sysId: z.string().trim().regex(/^[a-f0-9]{32}$/i, "sys_id ServiceNow : 32 caractères hexadécimaux.").describe("Identifiant sys_id de l'incident (32 caractères hexadécimaux)."),
  state: z.enum(SERVICENOW_STATES).optional().describe("Nouvel état : 1 = nouveau, 2 = en cours, 3 = en attente, 4 = résolu, 5 = clôturé, 6 = annulé."),
  urgency: z.enum(SERVICENOW_URGENCY).optional().describe("Nouvelle urgence : 1 = haute, 2 = moyenne, 3 = basse."),
  impact: z.enum(SERVICENOW_IMPACT).optional().describe("Nouvel impact métier : 1 = élevé, 2 = moyen, 3 = faible."),
  workNotes: z.string().trim().min(1).max(20_000).optional().describe("Notes de travail internes à ajouter à l'incident."),
  resolutionNotes: z.string().trim().min(1).max(20_000).optional().describe("Notes de résolution (clôture de l'incident)."),
  resolutionCode: z.string().trim().min(2).max(100).optional().describe("Code de résolution (ex. « Solved (Permanently) », « Workaround Provided »)."),
});

export const servicenowIncidentUpdateTool: ToolDefinition<z.infer<typeof ServiceNowIncidentUpdateSchema>, unknown> = {
  id: "servicenow_incident_update",
  name: "servicenow_incident_update",
  description:
    "Met à jour un incident ServiceNow : état, urgence, impact, notes de travail et résolution (notes et code de clôture).",
  category: "composio",
  risk: "high",
  inputSchema: ServiceNowIncidentUpdateSchema,
  async execute(input, context: ToolContext) {
    if (!context.userId) throw new Error("A user ID is required.");
    const connectedAccountId = await resolveVerifiedComposioAccount(context.userId, "servicenow", context.projectId);
    return executeComposioTool({
      userId: context.userId,
      toolSlug: SERVICENOW_ACTIONS.incidentUpdate,
      arguments: {
        sys_id: input.sysId,
        ...(input.state ? { state: input.state } : {}),
        ...(input.urgency ? { urgency: input.urgency } : {}),
        ...(input.impact ? { impact: input.impact } : {}),
        ...(input.workNotes ? { work_notes: input.workNotes } : {}),
        ...(input.resolutionNotes ? { close_notes: input.resolutionNotes } : {}),
        ...(input.resolutionCode ? { close_code: input.resolutionCode } : {}),
      },
      connectedAccountId,
      signal: context.signal,
    });
  },
};

const ServiceNowIncidentQuerySchema = z.object({
  state: z.enum(SERVICENOW_STATES).optional().describe("Filtrer par état : 1 = nouveau, 2 = en cours, 3 = en attente, 4 = résolu, 5 = clôturé, 6 = annulé."),
  urgency: z.enum(SERVICENOW_URGENCY).optional().describe("Filtrer par urgence : 1 = haute, 2 = moyenne, 3 = basse."),
  limit: z.number().int().min(1).max(100).default(25).describe("Nombre maximum d'incidents renvoyés (100 max)."),
  offset: z.number().int().min(0).max(10_000).default(0).describe("Décalage de pagination dans la liste des incidents."),
});

export const servicenowIncidentQueryTool: ToolDefinition<z.infer<typeof ServiceNowIncidentQuerySchema>, unknown> = {
  id: "servicenow_incident_query",
  name: "servicenow_incident_query",
  description:
    "Interroge les incidents ServiceNow, filtrés par état et/ou urgence, avec pagination.",
  category: "composio",
  risk: "low",
  inputSchema: ServiceNowIncidentQuerySchema,
  async execute(input, context: ToolContext) {
    if (!context.userId) throw new Error("A user ID is required.");
    const connectedAccountId = await resolveVerifiedComposioAccount(context.userId, "servicenow", context.projectId);
    // Requête encodée ServiceNow : « état^ET urgence » (opérateur AND).
    const filters = [
      ...(input.state ? [`state=${input.state}`] : []),
      ...(input.urgency ? [`urgency=${input.urgency}`] : []),
    ];
    return executeComposioTool({
      userId: context.userId,
      toolSlug: SERVICENOW_ACTIONS.incidentQuery,
      arguments: {
        sysparm_limit: input.limit,
        sysparm_offset: input.offset,
        ...(filters.length > 0 ? { sysparm_query: filters.join("^") } : {}),
      },
      connectedAccountId,
      signal: context.signal,
    });
  },
};
