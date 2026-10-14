import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECTIONS_CATALOG } from "./connections";
import {
  SERVICENOW_ACTIONS,
  ZENDESK_ACTIONS,
  resolveVerifiedComposioAccount,
  servicenowIncidentCreateTool,
  servicenowIncidentQueryTool,
  servicenowIncidentUpdateTool,
  zendeskTicketCreateTool,
  zendeskTicketListTool,
  zendeskTicketSearchTool,
  zendeskTicketUpdateTool,
} from "./tools";
import type { ToolContext, ToolDefinition } from "@/lib/tools/types";

/**
 * Task 133 — outils dérivés Zendesk (tickets) et ServiceNow (incidents ITSM).
 *
 * Contrats verrouillés :
 *  1. chaque schéma zod accepte un input type et REJETTE un input invalide ;
 *  2. chaque outil référence un toolkit réellement présent au catalogue ;
 *  3. l'exécution exige un userId ET une connexion hub vérifiée (même verrou
 *     que composio.execute) ;
 *  4. les arguments sont mappés vers les slugs d'actions Composio réels.
 */

const mocks = vi.hoisted(() => ({
  composioExecute: vi.fn(),
  listHubConnections: vi.fn(),
  listDeveloperProjectConnectors: vi.fn(),
}));

vi.mock("./client", () => ({
  getComposio: () => ({
    tools: {
      execute: (...args: unknown[]) => mocks.composioExecute(...args),
    },
  }),
}));

// Le catalogue réel est conservé (vérification 2) ; seul le parcours réseau
// Composio est remplacé par un stub déterministe.
vi.mock("./connections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./connections")>();
  return {
    ...actual,
    listHubConnections: (...args: unknown[]) => mocks.listHubConnections(...args),
  };
});

vi.mock("@/lib/developer/connectors", () => ({
  listDeveloperProjectConnectors: (...args: unknown[]) => mocks.listDeveloperProjectConnectors(...args),
}));

/** Les 7 outils Task 133 avec le toolkit hub attendu. */
const OUTILS_TASK_133: Array<{ tool: ToolDefinition<unknown, unknown>; toolkit: string }> = [
  { tool: zendeskTicketCreateTool, toolkit: "zendesk" },
  { tool: zendeskTicketUpdateTool, toolkit: "zendesk" },
  { tool: zendeskTicketListTool, toolkit: "zendesk" },
  { tool: zendeskTicketSearchTool, toolkit: "zendesk" },
  { tool: servicenowIncidentCreateTool, toolkit: "servicenow" },
  { tool: servicenowIncidentUpdateTool, toolkit: "servicenow" },
  { tool: servicenowIncidentQueryTool, toolkit: "servicenow" },
];

const CONTEXTE: ToolContext = { userId: "user-133" };

function connexionHub(toolkit: string) {
  return {
    id: `conn-${toolkit}`,
    toolkit,
    label: toolkit,
    category: "other",
    status: "ACTIVE",
    enabled: true,
    verified: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.composioExecute.mockResolvedValue({ successful: true, data: {} });
});

describe("outils Zendesk/ServiceNow — contrats de définition", () => {
  it("référence des toolkits présents au catalogue Connections Hub", () => {
    const catalogToolkits = new Set(CONNECTIONS_CATALOG.map((entry) => entry.toolkit));
    for (const { toolkit } of OUTILS_TASK_133) {
      expect(catalogToolkits.has(toolkit), `toolkit ${toolkit} absent du catalogue`).toBe(true);
    }
    expect(catalogToolkits.has("zendesk")).toBe(true);
    expect(catalogToolkits.has("servicenow")).toBe(true);
  });

  it("déclare des identifiants uniques, la catégorie composio et des risques cohérents", () => {
    const ids = new Set<string>();
    for (const { tool } of OUTILS_TASK_133) {
      const id = tool.id ?? tool.name;
      expect(ids.has(id), `doublon d'outil ${id}`).toBe(false);
      ids.add(id);
      expect(tool.category).toBe("composio");
      expect(["low", "high"]).toContain(tool.risk);
      // Les outils en lecture seule sont « low », les écritures externes « high ».
      if (id.includes("_list") || id.includes("_search") || id.includes("_query")) {
        expect(tool.risk).toBe("low");
      } else {
        expect(tool.risk).toBe("high");
      }
    }
    expect(ids.size).toBe(7);
  });

  it("cible des slugs d'actions Composio réels (majuscules, préfixe du toolkit)", () => {
    for (const slug of Object.values(ZENDESK_ACTIONS)) {
      expect(slug).toMatch(/^ZENDESK_[A-Z0-9_]+$/);
    }
    for (const slug of Object.values(SERVICENOW_ACTIONS)) {
      expect(slug).toMatch(/^SERVICENOW_[A-Z0-9_]+$/);
    }
  });
});

describe("zendesk_ticket_create — schéma et exécution", () => {
  it("accepte un input type et applique les valeurs par défaut", () => {
    const parsed = zendeskTicketCreateTool.inputSchema.parse({
      subject: "Impossible de se connecter",
      description: "L'utilisateur signale une erreur 500 depuis ce matin.",
    });
    expect(parsed).toMatchObject({ priority: "normal", subject: "Impossible de se connecter" });
  });

  it("rejette les entrées invalides (priorité, sujet, email)", () => {
    const base = { subject: "Sujet valide", description: "Description valide" };
    expect(() => zendeskTicketCreateTool.inputSchema.parse({ ...base, priority: "critique" })).toThrow();
    expect(() => zendeskTicketCreateTool.inputSchema.parse({ ...base, subject: "ok" })).toThrow();
    expect(() => zendeskTicketCreateTool.inputSchema.parse({ ...base, requesterEmail: "pas-un-email" })).toThrow();
  });

  it("mappe les arguments vers ZENDESK_CREATE_ZENDESK_TICKET via la connexion vérifiée", async () => {
    mocks.listHubConnections.mockResolvedValue([connexionHub("zendesk")]);
    await zendeskTicketCreateTool.execute(
      {
        subject: "Impossible de se connecter",
        description: "Erreur 500 depuis ce matin.",
        priority: "urgent",
        requesterEmail: "client@exemple.fr",
      },
      CONTEXTE,
    );
    expect(mocks.composioExecute).toHaveBeenCalledTimes(1);
    const [slug, params] = mocks.composioExecute.mock.calls[0] as [string, Record<string, unknown>];
    expect(slug).toBe(ZENDESK_ACTIONS.ticketCreate);
    expect(params).toMatchObject({
      userId: "user-133",
      connectedAccountId: "conn-zendesk",
      arguments: {
        subject: "Impossible de se connecter",
        description: "Erreur 500 depuis ce matin.",
        priority: "urgent",
        requester_email: "client@exemple.fr",
      },
    });
  });
});

describe("zendesk_ticket_update — schéma et exécution", () => {
  it("accepte un commentaire interne et le mappe en comment_public=false", async () => {
    const parsed = zendeskTicketUpdateTool.inputSchema.parse({
      ticketId: 42,
      comment: "Relancé le client par téléphone.",
      commentPublic: false,
    });
    expect(parsed.commentPublic).toBe(false);

    mocks.listHubConnections.mockResolvedValue([connexionHub("zendesk")]);
    await zendeskTicketUpdateTool.execute(parsed, CONTEXTE);
    const [slug, params] = mocks.composioExecute.mock.calls[0] as [string, Record<string, unknown>];
    expect(slug).toBe(ZENDESK_ACTIONS.ticketUpdate);
    expect(params).toMatchObject({
      arguments: {
        ticket_id: 42,
        comment_body: "Relancé le client par téléphone.",
        comment_public: false,
      },
    });
  });

  it("rejette un statut hors contrat (closed) et un identifiant non numérique", () => {
    expect(() => zendeskTicketUpdateTool.inputSchema.parse({ ticketId: 1, status: "closed" })).toThrow();
    expect(() => zendeskTicketUpdateTool.inputSchema.parse({ ticketId: "1" })).toThrow();
  });
});

describe("zendesk_ticket_list — schéma et exécution", () => {
  it("construit une requête Zendesk « tickets ouverts du demandeur/assigné »", async () => {
    const parsed = zendeskTicketListTool.inputSchema.parse({ user: "client@exemple.fr" });
    expect(parsed).toMatchObject({ scope: "requester", perPage: 25, page: 1 });

    mocks.listHubConnections.mockResolvedValue([connexionHub("zendesk")]);
    await zendeskTicketListTool.execute(parsed, CONTEXTE);
    const [slug, params] = mocks.composioExecute.mock.calls[0] as [string, { arguments: Record<string, unknown> }];
    expect(slug).toBe(ZENDESK_ACTIONS.ticketSearch);
    expect(String(params.arguments.query)).toContain("type:ticket");
    expect(String(params.arguments.query)).toContain("status<solved");
    expect(String(params.arguments.query)).toContain("requester:client@exemple.fr");
  });

  it("rejette un périmètre inconnu", () => {
    expect(() => zendeskTicketListTool.inputSchema.parse({ user: "client@exemple.fr", scope: "watcher" })).toThrow();
  });
});

describe("zendesk_ticket_search — schéma et exécution", () => {
  it("restreint la recherche plein texte aux tickets", async () => {
    const parsed = zendeskTicketSearchTool.inputSchema.parse({ query: "vpn lyon" });
    expect(parsed).toMatchObject({ perPage: 10, page: 1 });

    mocks.listHubConnections.mockResolvedValue([connexionHub("zendesk")]);
    await zendeskTicketSearchTool.execute(parsed, CONTEXTE);
    const [slug, params] = mocks.composioExecute.mock.calls[0] as [string, { arguments: Record<string, unknown> }];
    expect(slug).toBe(ZENDESK_ACTIONS.ticketSearch);
    expect(params.arguments.query).toBe("type:ticket vpn lyon");
  });

  it("rejette une requête trop courte", () => {
    expect(() => zendeskTicketSearchTool.inputSchema.parse({ query: "a" })).toThrow();
  });
});

describe("servicenow_incident_create — schéma et exécution", () => {
  it("accepte un input type et applique urgence/impact par défaut", () => {
    const parsed = servicenowIncidentCreateTool.inputSchema.parse({
      shortDescription: "Serveur mail indisponible",
    });
    expect(parsed).toMatchObject({ urgency: "2", impact: "2" });
  });

  it("rejette une urgence hors contrat", () => {
    expect(() =>
      servicenowIncidentCreateTool.inputSchema.parse({ shortDescription: "Serveur mail indisponible", urgency: "4" }),
    ).toThrow();
  });

  it("mappe les arguments vers SERVICENOW_CREATE_INCIDENT via la connexion vérifiée", async () => {
    mocks.listHubConnections.mockResolvedValue([connexionHub("servicenow")]);
    await servicenowIncidentCreateTool.execute(
      {
        shortDescription: "Serveur mail indisponible",
        description: "Aucune réponse du serveur SMTP depuis 09h00.",
        urgency: "1",
        impact: "1",
        workNotes: "Escaladé à l'équipe infrastructure.",
      },
      CONTEXTE,
    );
    const [slug, params] = mocks.composioExecute.mock.calls[0] as [string, Record<string, unknown>];
    expect(slug).toBe(SERVICENOW_ACTIONS.incidentCreate);
    expect(params).toMatchObject({
      userId: "user-133",
      connectedAccountId: "conn-servicenow",
      arguments: {
        short_description: "Serveur mail indisponible",
        description: "Aucune réponse du serveur SMTP depuis 09h00.",
        urgency: "1",
        impact: "1",
        work_notes: "Escaladé à l'équipe infrastructure.",
      },
    });
  });
});

describe("servicenow_incident_update — schéma et exécution", () => {
  it("mappe la résolution vers close_notes/close_code et l'état vers state", async () => {
    const parsed = servicenowIncidentUpdateTool.inputSchema.parse({
      sysId: "1c832706732023002728660c4cf6a7b9",
      state: "4",
      resolutionNotes: "Redémarrage du service SMTP.",
      resolutionCode: "Solved (Permanently)",
    });

    mocks.listHubConnections.mockResolvedValue([connexionHub("servicenow")]);
    await servicenowIncidentUpdateTool.execute(parsed, CONTEXTE);
    const [slug, params] = mocks.composioExecute.mock.calls[0] as [string, { arguments: Record<string, unknown> }];
    expect(slug).toBe(SERVICENOW_ACTIONS.incidentUpdate);
    expect(params.arguments).toMatchObject({
      sys_id: "1c832706732023002728660c4cf6a7b9",
      state: "4",
      close_notes: "Redémarrage du service SMTP.",
      close_code: "Solved (Permanently)",
    });
  });

  it("rejette un sys_id malformé et un état hors contrat", () => {
    expect(() => servicenowIncidentUpdateTool.inputSchema.parse({ sysId: "xyz" })).toThrow();
    expect(() => servicenowIncidentUpdateTool.inputSchema.parse({ sysId: "1c832706732023002728660c4cf6a7b9", state: "9" })).toThrow();
  });
});

describe("servicenow_incident_query — schéma et exécution", () => {
  it("construit la requête encodée ServiceNow depuis état et urgence", async () => {
    const parsed = servicenowIncidentQueryTool.inputSchema.parse({ state: "2", urgency: "1" });
    expect(parsed).toMatchObject({ limit: 25, offset: 0 });

    mocks.listHubConnections.mockResolvedValue([connexionHub("servicenow")]);
    await servicenowIncidentQueryTool.execute(parsed, CONTEXTE);
    const [slug, params] = mocks.composioExecute.mock.calls[0] as [string, { arguments: Record<string, unknown> }];
    expect(slug).toBe(SERVICENOW_ACTIONS.incidentQuery);
    expect(params.arguments).toMatchObject({
      sysparm_query: "state=2^urgency=1",
      sysparm_limit: 25,
      sysparm_offset: 0,
    });
  });

  it("n'envoie pas sysparm_query sans filtre et rejette une limite déraisonnable", async () => {
    const parsed = servicenowIncidentQueryTool.inputSchema.parse({});
    mocks.listHubConnections.mockResolvedValue([connexionHub("servicenow")]);
    await servicenowIncidentQueryTool.execute(parsed, CONTEXTE);
    const [, params] = mocks.composioExecute.mock.calls[0] as [string, { arguments: Record<string, unknown> }];
    expect(params.arguments).not.toHaveProperty("sysparm_query");

    expect(() => servicenowIncidentQueryTool.inputSchema.parse({ limit: 1000 })).toThrow();
  });
});

describe("verrou d'exécution partagé (resolveVerifiedComposioAccount)", () => {
  it("exige un userId", async () => {
    await expect(zendeskTicketCreateTool.execute({ subject: "Sujet", description: "Description" }, {} as ToolContext)).rejects.toThrow(
      "A user ID is required.",
    );
  });

  it("refuse un toolkit sans connexion hub vérifiée (erreur TYLÉE ConnectorMissingError — Task 143)", async () => {
    mocks.listHubConnections.mockResolvedValue([]);
    await expect(
      resolveVerifiedComposioAccount("user-133", "zendesk"),
    ).rejects.toThrow(/\[CONNECTOR_MISSING:zendesk\]/);
    await expect(
      servicenowIncidentCreateTool.execute({ shortDescription: "Serveur mail indisponible" }, CONTEXTE),
    ).rejects.toThrow(/\[CONNECTOR_MISSING:servicenow\]/);
  });

  it("ignore une connexion vérifiée mais désactivée", async () => {
    const desactivee = { ...connexionHub("zendesk"), enabled: false };
    mocks.listHubConnections.mockResolvedValue([desactivee]);
    await expect(resolveVerifiedComposioAccount("user-133", "zendesk")).rejects.toThrow(/\[CONNECTOR_MISSING:zendesk\]/);
  });

  it("consulte les connecteurs du projet développeur quand un projectId est fourni", async () => {
    mocks.listHubConnections.mockResolvedValue([connexionHub("zendesk")]);
    mocks.listDeveloperProjectConnectors.mockResolvedValue([]);
    const compte = await resolveVerifiedComposioAccount("user-133", "zendesk", "projet-1");
    expect(mocks.listDeveloperProjectConnectors).toHaveBeenCalledWith("user-133", "projet-1");
    expect(compte).toBe("conn-zendesk");
  });
});
