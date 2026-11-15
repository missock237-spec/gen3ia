import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TEMPLATES D'AGENTS SECTORIELS (Task 132) :
 *  - registre complet (6 entrées uniques, champs remplis, allowlists
 *    d'outils RÉELLES — union du catalogue GEN3IA_TOOLS et des définitions
 *    de sécurité KNOWN_TOOL_SECURITY_NAMES) ;
 *  - instanciation via la FABRIQUE (createAgent espionnée mais réelle) puis
 *    le dépôt validant createAgentRecord — exercé contre un R2 simulé en
 *    mémoire, même approche que lib/agents/repository.test.ts (la
 *    personnalité multi-tenant y reste mockée) : la validation zod
 *    AgentRecordSchema s'exécute POUR DE VRAI ;
 *  - surcharges appliquées (nom, description, organisation).
 */

// ---------------------------------------------------------------------------
// État hoisted — R2 factice (Map clé → Buffer), cf. repository.test.ts
// ---------------------------------------------------------------------------

const r2State = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
  uploads: [] as string[],
  deletes: [] as string[],
}));

vi.mock("@/lib/storage/r2", () => {
  function notFound(key: string): Error {
    const error = new Error(`The specified key does not exist. (${key})`);
    error.name = "NoSuchKey";
    (error as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 404 };
    return error;
  }
  return {
    putObject: async (options: { key: string; body: Uint8Array | Buffer }) => {
      r2State.store.set(options.key, Buffer.from(options.body));
      r2State.uploads.push(options.key);
    },
    uploadToR2: async (key: string, body: Uint8Array | Buffer) => {
      r2State.store.set(key, Buffer.from(body));
      r2State.uploads.push(key);
    },
    downloadFromR2: async (key: string) => {
      const body = r2State.store.get(key);
      if (!body) throw notFound(key);
      return body;
    },
    deleteObject: async (key: string) => {
      r2State.store.delete(key);
      r2State.deletes.push(key);
    },
    deleteFromR2: async (key: string) => {
      r2State.store.delete(key);
      r2State.deletes.push(key);
    },
    listObjectsUnderPrefix: async (prefix: string, maxResults?: number) =>
      [...r2State.store.keys()]
        .filter((key) => key.startsWith(prefix))
        .slice(0, maxResults ?? 500)
        .map((key) => ({ key, sizeBytes: r2State.store.get(key)!.length, updatedAt: "" })),
  };
});

// ---------------------------------------------------------------------------
// Politique d'accès multi-tenant mockée (dépôt testé isolément)
// ---------------------------------------------------------------------------

const accessState = vi.hoisted(() => ({
  assertOrgAttach: vi.fn<(uid: string, orgId: string) => Promise<unknown>>(),
}));

vi.mock("@/lib/tenants/resource-access", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/tenants/resource-access")>();
  return {
    ...original,
    assertOrgAttach: accessState.assertOrgAttach,
  };
});

// ---------------------------------------------------------------------------
// Fabrique espionnée mais RÉELLE : on vérifie le passage par createAgent
// sans en altérer le comportement (pattern importOriginal de hire.test.ts).
// ---------------------------------------------------------------------------

const factoryState = vi.hoisted(() => ({
  createAgent: vi.fn<(input: import("@/lib/agents/factory").CreateAgentInput) => import("@/lib/agents/factory").Agent>(),
}));

vi.mock("@/lib/agents/factory", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/agents/factory")>();
  return { ...original, createAgent: factoryState.createAgent.mockImplementation(original.createAgent) };
});

import { AGENT_TYPES } from "@/lib/agents/agent-types";
import { createAgent } from "@/lib/agents/factory";
import { GEN3IA_TOOLS } from "@/lib/tools/registry";
import { KNOWN_TOOL_SECURITY_NAMES } from "@/lib/security/tool-permissions";
import {
  AGENT_TEMPLATES,
  getTemplate,
  type AgentTemplate,
} from "./index";
import { agentNameFromTemplate, buildTemplateSystemPrompt, instantiateFromTemplate } from "./instantiate";

/** Union canonique des outils réellement connus du registre (cf. personalized-plan). */
const REGISTRY_TOOL_SET: ReadonlySet<string> = new Set([
  ...GEN3IA_TOOLS.map((tool) => tool.name),
  ...KNOWN_TOOL_SECURITY_NAMES,
]);

function readDoc(key: string): Record<string, unknown> {
  const body = r2State.store.get(key);
  expect(body, `clé attendue dans R2 : ${key}`).toBeDefined();
  return JSON.parse(body!.toString("utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  r2State.store.clear();
  r2State.uploads.length = 0;
  r2State.deletes.length = 0;
  accessState.assertOrgAttach.mockReset().mockResolvedValue(undefined);
  factoryState.createAgent.mockClear();
});

/* ------------------------------------------------------------------ */
/* Registre                                                            */
/* ------------------------------------------------------------------ */

describe("registre des templates (données pures)", () => {
  it("contient exactement 6 templates sectoriels distincts", () => {
    expect(AGENT_TEMPLATES).toHaveLength(6);
    const ids = AGENT_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(6);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it("couvre les 6 secteurs attendus du rapport", () => {
    const ids = AGENT_TEMPLATES.map((template) => template.id).sort();
    expect(ids).toEqual(
      ["analyste-finance", "marketing-contenu", "prospection-vente", "screening-rh", "support-client", "veille-juridique"].sort(),
    );
  });

  it("chaque template est complet et en français", () => {
    for (const template of AGENT_TEMPLATES) {
      expect(template.nom.trim().length).toBeGreaterThanOrEqual(2);
      expect(template.description.trim().length).toBeGreaterThanOrEqual(20);
      expect(template.description.length).toBeLessThanOrEqual(300);
      expect(template.secteur.trim().length).toBeGreaterThanOrEqual(3);
      // Persona substantielle + amorces de connaissances.
      expect(template.persona.length).toBeGreaterThanOrEqual(300);
      expect(template.amorcesConnaissances.length).toBeGreaterThanOrEqual(3);
      // Type technique réel.
      expect(AGENT_TYPES).toContain(template.typeAgent);
    }
  });

  it("les allowlists d'outils ne contiennent QUE des outils réels du registre", () => {
    for (const template of AGENT_TEMPLATES) {
      expect(template.outilsAutorises.length).toBeGreaterThanOrEqual(4);
      expect(new Set(template.outilsAutorises).size).toBe(template.outilsAutorises.length);
      for (const outil of template.outilsAutorises) {
        expect(REGISTRY_TOOL_SET.has(outil), `outil inconnu « ${outil} » (${template.id})`).toBe(true);
      }
    }
  });

  it("préférences de modèle dans les bornes du schéma agent", () => {
    for (const template of AGENT_TEMPLATES) {
      expect(["automatic", "fixed"]).toContain(template.preferencesModele.strategie);
      expect(template.preferencesModele.temperature).toBeGreaterThanOrEqual(0);
      expect(template.preferencesModele.temperature).toBeLessThanOrEqual(2);
      expect(template.preferencesModele.maxIterations).toBeGreaterThanOrEqual(1);
      expect(template.preferencesModele.maxIterations).toBeLessThanOrEqual(20);
    }
  });

  it("compétences dans les bornes du schéma (≤ 24, libellés non vides)", () => {
    for (const template of AGENT_TEMPLATES) {
      expect(template.competences.length).toBeGreaterThanOrEqual(3);
      expect(template.competences.length).toBeLessThanOrEqual(24);
      for (const competence of template.competences) {
        expect(competence.trim().length).toBeGreaterThanOrEqual(2);
        expect(competence.length).toBeLessThanOrEqual(80);
      }
    }
  });
});

describe("getTemplate", () => {
  it("résout chaque template par son identifiant", () => {
    for (const template of AGENT_TEMPLATES) {
      expect(getTemplate(template.id)?.nom).toBe(template.nom);
    }
  });

  it("identifiant inconnu ou vide → undefined", () => {
    expect(getTemplate("inconnu")).toBeUndefined();
    expect(getTemplate("")).toBeUndefined();
    expect(getTemplate("   ")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Helpers purs                                                        */
/* ------------------------------------------------------------------ */

describe("agentNameFromTemplate (pur)", () => {
  const template = AGENT_TEMPLATES[0];

  it("préfixe le nom du template par « Agent »", () => {
    expect(agentNameFromTemplate(template)).toBe(`Agent ${template.nom}`);
  });

  it("la surcharge remplace le nom, normalisée proprement", () => {
    expect(agentNameFromTemplate(template, "  SAV  Nuit ")).toBe("SAV Nuit");
  });

  it("borne le nom à 80 caractères (maximum du schéma agent)", () => {
    const long: AgentTemplate = { ...template, nom: "N".repeat(120) };
    const name = agentNameFromTemplate(long);
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.endsWith("…")).toBe(true);
  });
});

describe("buildTemplateSystemPrompt (pur)", () => {
  it("persona + amorces de connaissances intégrées", () => {
    const template = AGENT_TEMPLATES[0];
    const prompt = buildTemplateSystemPrompt(template);
    expect(prompt.startsWith(template.persona)).toBe(true);
    expect(prompt).toContain("AMORCES DE CONNAISSANCE");
    for (const amorce of template.amorcesConnaissances) expect(prompt).toContain(amorce);
  });
});

/* ------------------------------------------------------------------ */
/* instantiateFromTemplate (fabrique + dépôt R2 simulé)                */
/* ------------------------------------------------------------------ */

describe("instantiateFromTemplate", () => {
  it("passe par la FABRIQUE puis le dépôt validant : agent actif, complet, persisté", async () => {
    const template = getTemplate("support-client")!;
    const record = await instantiateFromTemplate("user-1", "support-client");

    // Passage par la fabrique (createAgent) avec le nom préfixé.
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "user-1",
        name: `Agent ${template.nom}`,
        systemPrompt: expect.stringContaining(template.persona.slice(0, 60)),
        tools: template.outilsAutorises,
        skills: template.competences,
        maxIterations: template.preferencesModele.maxIterations,
      }),
    );

    // Enregistrement persisté et complet.
    expect(record.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(record.ownerId).toBe("user-1");
    expect(record.name).toBe("Agent Support Client");
    expect(record.status).toBe("active");
    expect(record.type).toBe("custom");
    expect(record.typeLabel).toBe("Template sectoriel — Service client & SAV");
    expect(record.tools).toEqual(template.outilsAutorises);
    expect(record.skills).toEqual(template.competences);
    expect(record.temperature).toBe(template.preferencesModele.temperature);
    expect(record.maxIterations).toBe(template.preferencesModele.maxIterations);
    expect(record.systemPrompt).toContain(template.persona);
    expect(record.systemPrompt).toContain("AMORCES DE CONNAISSANCE");

    // Persistance R2 réelle : document propriétaire + index global.
    const doc = readDoc(`users/user-1/agents/${record.id}.json`);
    expect(doc.ownerId).toBe("user-1");
    expect(doc.name).toBe("Agent Support Client");
    const index = readDoc(`agents-index/${record.id}.json`);
    expect(index).toMatchObject({ ownerId: "user-1", agentId: record.id });
  });

  it("surcharges appliquées : nom et description personnalisés", async () => {
    const record = await instantiateFromTemplate("user-1", "marketing-contenu", {
      name: "Rédaction Nuit & Week-end",
      description: "Ma description personnalisée pour l'équipe de nuit.",
    });
    expect(record.name).toBe("Rédaction Nuit & Week-end");
    expect(record.description).toBe("Ma description personnalisée pour l'équipe de nuit.");
    // Le reste reste issu du template.
    expect(record.type).toBe("content");
    expect(record.tools).toContain("social.publish");
  });

  it("organisation cible : garde d'attachement appelée + pointeur org écrit", async () => {
    const record = await instantiateFromTemplate("user-1", "prospection-vente", { orgId: "org-9" });
    expect(accessState.assertOrgAttach).toHaveBeenCalledWith("user-1", "org-9");
    expect(record.orgId).toBe("org-9");
    const pointer = readDoc(`orgs/org-9/agents/${record.id}.json`);
    expect(pointer).toMatchObject({ ownerId: "user-1", agentId: record.id });
  });

  it("template inconnu → HttpError 404, aucune écriture", async () => {
    await expect(instantiateFromTemplate("user-1", "inexistant")).rejects.toMatchObject({ status: 404 });
    expect(r2State.store.size).toBe(0);
  });

  it("utilisateur vide → HttpError 401", async () => {
    await expect(instantiateFromTemplate("  ", "support-client")).rejects.toMatchObject({ status: 401 });
  });

  it("les 6 templates s'instancient et passent la validation du dépôt", async () => {
    for (const template of AGENT_TEMPLATES) {
      const record = await instantiateFromTemplate("user-1", template.id);
      expect(record.status).toBe("active");
      expect(record.name).toBe(`Agent ${template.nom}`);
      expect(record.systemPrompt!.length).toBeGreaterThan(template.persona.length);
    }
    // 6 agents personnels distincts persistés.
    const agents = r2State.uploads.filter((key) => key.startsWith("users/user-1/agents/"));
    expect(agents).toHaveLength(6);
  });
});
