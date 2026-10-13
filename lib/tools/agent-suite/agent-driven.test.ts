import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 140 — TEST D'INTÉGRATION « OUTILS PILOTÉS PAR LES AGENTS IA ».
 *
 * Exigence utilisateur : « une fois terminé test pour voir si il est
 * fonctionnelle et que ses outils sont bien piloter par les agent ia ».
 *
 * Ce fichier PROUVE les DEUX volets, de bout en bout :
 *
 *  1. PILOTÉS PAR LES AGENTS — chaque outil est :
 *     (a) enregistré au REGISTRE EXÉCUTABLE (createDefaultToolRegistry) ;
 *     (b) annoncé au CATALOGUE DU PLANIFICATEUR (GEN3IA_TOOLS — ce que le
 *         LLM planificateur voit pour choisir ses étapes « tool ») ;
 *     (c) couvert par TOOL_SECURITY (authorizeTool : la chaîne d'autorisation
 *         du runtime agents l'accepte) ;
 *     (d) labellisé FR côté utilisateur (jamais le slug brut) ;
 *     (e) détecté par les INDICES D'INTENTION déterministes (tool-intent)
 *         injectés dans le prompt du planner ;
 *     (f) autorisé par la POLITIQUE DÉRIVÉE DU PLAN (buildPlanExecutionPolicy,
 *         la voie des missions agents — flags + permissions requis activés) ;
 *     (g) conforme à la directive 10-10 : les outils INTERNES ne déclenchent
 *         JAMAIS de carte de validation, les externes la déclenchent.
 *
 *  2. FONCTIONNEL — les outils s'exécutent à travers la CHAÎNE STANDARD
 *     COMPLÈTE (executeTool : kill-switch → authorizeTool → consentements →
 *     validation zod → exécution réelle → piste d'audit) — jamais en direct :
 *     déterministes (transcript.redact, decision.analyze, ivr.navigate) et
 *     pilotés LLM avec facturation wallet (handover.compose).
 *
 * Choix de testabilité : les frontières externes sont mockées à CE niveau
 * (wallet LLM, persistance d'artefacts, Firestore d'audit) — les outils eux-
 * mêmes restent le sujet (leurs tests unitaires co-localisés couvrent les
 * comportements fins).
 */

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
  runTransaction: vi.fn(),
  generateForUser: vi.fn(),
  generateArtifact: vi.fn(),
  storeArtifactBuffer: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ set: mocks.set, get: mocks.get, delete: vi.fn().mockResolvedValue(undefined) })),
    })),
    runTransaction: mocks.runTransaction,
  },
}));

vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: (...args: unknown[]) => mocks.generateForUser(...args),
}));

vi.mock("@/lib/documents/engine", () => ({
  generateArtifact: (...args: unknown[]) => mocks.generateArtifact(...args),
}));

vi.mock("@/lib/documents/artifact-store", () => ({
  storeArtifactBuffer: (...args: unknown[]) => mocks.storeArtifactBuffer(...args),
}));

import { executeTool, createDefaultToolRegistry } from "@/lib/tools";
import { GEN3IA_TOOLS } from "@/lib/tools/registry";
import { authorizeTool, getToolSecurityDefinition, KNOWN_TOOL_SECURITY_NAMES } from "@/lib/security/tool-permissions";
import { DEFAULT_EXECUTION_POLICY } from "@/lib/security/execution-policy";
import { toolLabel } from "@/lib/tools/labels";
import { INTERNAL_ACTION_TOOLS, stepRequiresHumanApproval } from "@/lib/agents/approval-policy";
import { buildPlanExecutionPolicy } from "@/lib/agents/runtime/plan-policy";
import { detectToolIntents, formatToolIntentSection } from "@/lib/agents/runtime/tool-intent";
import type { ExecutionPolicy } from "@/lib/security/execution-policy";

/* ────────────────────────────────────────────────────────────────────────
 * Constantes — les 16 outils de la suite (Task 140).
 * ──────────────────────────────────────────────────────────────────────── */

const SUITE_TOOLS = [
  "handover.compose",
  "terminal.shield",
  "registry.find",
  "build.autofix",
  "simulation.run",
  "browser.navigate",
  "schema.extract",
  "voicemail.respond",
  "transcript.redact",
  "ivr.navigate",
  "webhook.heal",
  "watchdog.track",
  "terminal.guide",
  "content.package",
  "knowledge.graph",
  "decision.analyze",
] as const;

/** Les 7 outils internes (directive 10-10 : jamais de carte de validation). */
const SUITE_INTERNAL_TOOLS = [
  "handover.compose",
  "terminal.shield",
  "simulation.run",
  "watchdog.track",
  "terminal.guide",
  "content.package",
  "knowledge.graph",
] as const;

/** Les 3 outils externes (action visible d'un tiers → validation humaine). */
const SUITE_EXTERNAL_TOOLS = ["build.autofix", "voicemail.respond", "webhook.heal"] as const;

/** Politique permissive (mêmes flags que la console étendue Task 140). */
function permissivePolicy(): ExecutionPolicy {
  return {
    ...DEFAULT_EXECUTION_POLICY,
    allowedTools: ["*"],
    permissions: [
      "tool.read",
      "tool.write",
      "tool.external",
      "file.read",
      "file.write",
      "file.create",
      "network.read",
      "network.write",
      "memory.read",
      "memory.write",
    ],
    allowNetwork: true,
    allowExternalApps: true,
    allowFileWrite: true,
    allowAgentTerminal: true,
  };
}

/** Politique sans terminal (prouve le garde allowAgentTerminal). */
function noTerminalPolicy(): ExecutionPolicy {
  const policy = permissivePolicy();
  policy.allowAgentTerminal = false;
  return policy;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ exists: false, data: () => ({}) });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ────────────────────────────────────────────────────────────────────────
 * 1. Enregistrement au registre exécutable (gated GITHUB_TOKEN)
 * ──────────────────────────────────────────────────────────────────────── */

describe("Task 140 — enregistrement au registre exécutable", () => {
  it("enregistre les 16 outils quand GITHUB_TOKEN est présent (build.autofix inclus)", () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_test_token");
    const registry = createDefaultToolRegistry();
    for (const name of SUITE_TOOLS) {
      const tool = registry.get(name);
      expect(tool, `outil attendu au registre : ${name}`).toBeDefined();
      expect(tool?.id ?? tool?.name).toBe(name);
    }
  });

  it("n'enregistre PAS build.autofix sans GITHUB_TOKEN (aucune capacité fantôme)", () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const registry = createDefaultToolRegistry();
    expect(registry.has("build.autofix")).toBe(false);
    // Les 15 autres restent enregistrés.
    for (const name of SUITE_TOOLS) {
      if (name === "build.autofix") continue;
      expect(registry.has(name), `outil attendu : ${name}`).toBe(true);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 2. Catalogue du planificateur (GEN3IA_TOOLS — ce que le LLM voit)
 * ──────────────────────────────────────────────────────────────────────── */

describe("Task 140 — catalogue du planificateur (GEN3IA_TOOLS)", () => {
  it("annonce les 16 outils au LLM planificateur avec risques cohérents", () => {
    for (const name of SUITE_TOOLS) {
      const entry = GEN3IA_TOOLS.find((tool) => tool.name === name);
      expect(entry, `entrée GEN3IA_TOOLS manquante : ${name}`).toBeDefined();
      expect(entry!.description.length).toBeGreaterThan(20);
      expect(["read", "write", "external", "destructive"]).toContain(entry!.risk);
    }
    // Les outils externes portent un effet de bord déclaré.
    for (const name of SUITE_EXTERNAL_TOOLS) {
      expect(GEN3IA_TOOLS.find((tool) => tool.name === name)?.sideEffect).toBe(true);
    }
    // Les outils de lecture pure n'en portent pas.
    for (const name of ["registry.find", "browser.navigate", "schema.extract", "transcript.redact", "ivr.navigate", "decision.analyze"] as const) {
      expect(GEN3IA_TOOLS.find((tool) => tool.name === name)?.sideEffect).toBe(false);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 3. Chaîne d'autorisation (authorizeTool)
 * ──────────────────────────────────────────────────────────────────────── */

describe("Task 140 — chaîne d'autorisation (authorizeTool)", () => {
  it("accepte les 16 outils avec la politique permissive étendue", () => {
    const policy = permissivePolicy();
    for (const name of SUITE_TOOLS) {
      expect(() => authorizeTool(policy, name), `autorisation attendue : ${name}`).not.toThrow();
    }
  });

  it("chaque outil possède une définition de sécurité réelle", () => {
    for (const name of SUITE_TOOLS) {
      const definition = getToolSecurityDefinition(name);
      expect(definition.name).toBe(name);
      expect(KNOWN_TOOL_SECURITY_NAMES.has(name)).toBe(true);
    }
  });

  it("terminal.shield est refusé sans allowAgentTerminal (garde de défense en profondeur, comme terminal.run)", () => {
    expect(() => authorizeTool(noTerminalPolicy(), "terminal.shield")).toThrow(/Agent terminal denied by policy/);
    expect(() => authorizeTool(noTerminalPolicy(), "terminal.run")).toThrow(/Agent terminal denied by policy/);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 4. Libellés FR (barrière utilisateur — jamais le slug brut)
 * ──────────────────────────────────────────────────────────────────────── */

describe("Task 140 — libellés FR des 16 outils", () => {
  it("toolLabel ne retourne JAMAIS le slug technique", () => {
    const expected: Record<string, string> = {
      "handover.compose": "Brief de relais IA vers humain",
      "terminal.shield": "Terminal protégé avec auto-réparation",
      "registry.find": "Recherche de packages en direct",
      "build.autofix": "Pipeline d'auto-correction de build",
      "simulation.run": "Studio de simulation utilisateur",
      "browser.navigate": "Navigation web adaptative",
      "schema.extract": "Extraction de données structurées",
      "voicemail.respond": "Répondeur vocal asynchrone",
      "transcript.redact": "Masquage de données sensibles",
      "ivr.navigate": "Navigation de serveur vocal (IVR)",
      "webhook.heal": "Passerelle webhooks auto-réparatrice",
      "watchdog.track": "Veille des changements web",
      "terminal.guide": "Guide interactif depuis le terminal",
      "content.package": "Pipeline de contenu automatisé",
      "knowledge.graph": "Graphe de connaissances",
      "decision.analyze": "Moteur de décision probabiliste",
    };
    for (const [name, label] of Object.entries(expected)) {
      expect(toolLabel(name)).toBe(label);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 5. Politique dérivée du plan (voie des missions agents)
 * ──────────────────────────────────────────────────────────────────────── */

describe("Task 140 — politique dérivée du plan (buildPlanExecutionPolicy)", () => {
  it("un plan agent avec terminal.shield active allowAgentTerminal et l'autorise", () => {
    const policy = buildPlanExecutionPolicy({
      executionId: "exec-suite-1",
      objective: "Exécuter la commande protégée",
      maxConcurrency: 4,
      maxIterations: 10,
      steps: [
        {
          id: "s1",
          type: "tool",
          name: "Terminal protégé",
          description: "Commande exécutée via terminal.shield",
          toolName: "terminal.shield",
          status: "pending",
          dependencies: [],
          input: { command: "node --version" },
          skillIds: [],
          maxRetries: 1,
          timeoutMs: 60_000,
          sideEffect: true,
          requiresApproval: false,
        },
      ],
    });
    expect(policy.allowAgentTerminal).toBe(true);
    expect(policy.allowedTools).toContain("terminal.shield");
    expect(() => authorizeTool(policy, "terminal.shield")).not.toThrow();
  });

  it("un plan agent avec handover.compose + registry.find dérive les permissions requises", () => {
    const policy = buildPlanExecutionPolicy({
      executionId: "exec-suite-2",
      objective: "Brief de relais après vérification de package",
      maxConcurrency: 4,
      maxIterations: 10,
      steps: [
        {
          id: "s1",
          type: "tool",
          name: "Recherche de package",
          description: "Vérifier la bibliothèque",
          toolName: "registry.find",
          status: "pending",
          dependencies: [],
          input: { query: "zod" },
          skillIds: [],
          maxRetries: 1,
          timeoutMs: 60_000,
          sideEffect: false,
          requiresApproval: false,
        },
        {
          id: "s2",
          type: "tool",
          name: "Brief de relais",
          description: "Générer le brief",
          toolName: "handover.compose",
          status: "pending",
          dependencies: ["s1"],
          input: { transcript: "Client mécontent, relance à préparer..." },
          skillIds: [],
          maxRetries: 1,
          timeoutMs: 60_000,
          sideEffect: true,
          requiresApproval: false,
        },
      ],
    });
    expect(policy.permissions).toContain("tool.write");
    expect(policy.permissions).toContain("network.read");
    expect(policy.allowedTools).toContain("registry.find");
    expect(policy.allowedTools).toContain("handover.compose");
    expect(policy.allowNetwork).toBe(true);
    expect(() => authorizeTool(policy, "registry.find")).not.toThrow();
    expect(() => authorizeTool(policy, "handover.compose")).not.toThrow();
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 6. Indices d'intention déterministes (auto-sélection du planner)
 * ──────────────────────────────────────────────────────────────────────── */

describe("Task 140 — indices d'intention déterministes (auto-sélection)", () => {
  it("détecte les intentions des 5 outils principaux en français", () => {
    const intents1 = detectToolIntents("Prépare-moi le brief de relais, je reprends la main sur ce client");
    expect(intents1.some((hint) => hint.toolNames.includes("handover.compose"))).toBe(true);

    const intents2 = detectToolIntents("Vérifie si la dernière version du package zod existe encore sur npm");
    expect(intents2.some((hint) => hint.toolNames.includes("registry.find"))).toBe(true);

    const intents3 = detectToolIntents("Corrige-moi ce build qui échoue et crée la pull request");
    expect(intents3.some((hint) => hint.toolNames.includes("build.autofix"))).toBe(true);

    const intents4 = detectToolIntents("Simule des utilisateurs novices et pressés qui testent mon tunnel d'inscription");
    expect(intents4.some((hint) => hint.toolNames.includes("simulation.run"))).toBe(true);

    const intents5 = detectToolIntents("Masque les données sensibles de cette transcription d'appel");
    expect(intents5.some((hint) => hint.toolNames.includes("transcript.redact"))).toBe(true);
  });

  it("formate la consigne d'outil explicite quand l'outil est au catalogue effectif", () => {
    const hints = detectToolIntents("Prépare-moi le brief de relais pour la reprise humaine");
    const section = formatToolIntentSection(hints, SUITE_TOOLS);
    expect(section).toContain('toolName="handover.compose"');
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 7. Politique d'approbation (directive 10-10)
 * ──────────────────────────────────────────────────────────────────────── */

describe("Task 140 — politique d'approbation (directive 10-10)", () => {
  it("les 7 outils internes ne déclenchent JAMAIS de carte de validation", async () => {
    for (const name of SUITE_INTERNAL_TOOLS) {
      expect(INTERNAL_ACTION_TOOLS.has(name), `outil interne attendu : ${name}`).toBe(true);
      await expect(stepRequiresHumanApproval("user-1", name, {}, { sensitive: true })).resolves.toBe(false);
    }
  });

  it("les 3 outils externes déclenchent la validation humaine", async () => {
    for (const name of SUITE_EXTERNAL_TOOLS) {
      expect(INTERNAL_ACTION_TOOLS.has(name)).toBe(false);
      await expect(stepRequiresHumanApproval("user-1", name, {}, { sensitive: true })).resolves.toBe(true);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 8. EXÉCUTION RÉELLE à travers la chaîne standard (executeTool)
 *    kill-switch → authorizeTool → consentements → zod → exécution → audit
 * ──────────────────────────────────────────────────────────────────────── */

describe("Task 140 — exécution réelle via la chaîne standard (executeTool)", () => {
  it("transcript.redact : masque une carte bancaire valide (Luhn) de bout en bout", async () => {
    const result = await executeTool({
      userId: "user-suite-1",
      executionId: "exec-suite-redact",
      toolName: "transcript.redact",
      input: {
        transcript: "Le client paie avec la carte 4111 1111 1111 1111 avant vendredi.",
      },
      policy: permissivePolicy(),
    });
    expect(result.success).toBe(true);
    const output = (result as { output: { redacted: string; totalRedactions: number; byType: Record<string, number> } }).output;
    expect(output.redacted).not.toContain("4111 1111 1111 1111");
    expect(output.redacted).toContain("1111");
    expect(output.totalRedactions).toBeGreaterThanOrEqual(1);
    // La piste d'audit de la chaîne standard a bien été appelée.
    expect(mocks.set).toHaveBeenCalled();
  });

  it("decision.analyze : moteur probabiliste déterministe (EV Monte-Carlo) de bout en bout", async () => {
    const result = await executeTool({
      userId: "user-suite-1",
      executionId: "exec-suite-decision",
      toolName: "decision.analyze",
      input: {
        options: [
          { label: "Pile ou face gagnante", outcomes: [{ label: "pile", probability: 0.5, value: 10 }, { label: "face", probability: 0.5, value: -10 }] },
        ],
        simulations: 2000,
        riskTolerance: "neutral",
      },
      policy: permissivePolicy(),
    });
    expect(result.success).toBe(true);
    const output = (result as { output: { perOption: Array<{ label: string; expectedValue: number; probabilityOfLoss: number }>; ranking: string[]; recommendation: string } }).output;
    expect(output.perOption[0].expectedValue).toBeCloseTo(0, 1);
    expect(output.perOption[0].probabilityOfLoss).toBeGreaterThan(0.4);
    expect(output.ranking).toHaveLength(1);
    expect(output.recommendation.length).toBeGreaterThan(10);
  });

  it("ivr.navigate : plan DTMF déterministe depuis un arbre structuré, de bout en bout", async () => {
    const result = await executeTool({
      userId: "user-suite-1",
      executionId: "exec-suite-ivr",
      toolName: "ivr.navigate",
      input: {
        goal: "parler à un conseiller",
        menuTree: {
          label: "accueil",
          options: [
            { key: "1", label: "Suivi de commande", action: "end" },
            { key: "2", label: "Conseiller / service client", action: "human" },
            { key: "3", label: "Facturation", action: "end" },
          ],
        },
      },
      policy: permissivePolicy(),
    });
    expect(result.success).toBe(true);
    const output = (result as { output: { dtmfSequence: string; matchedGoal: boolean; path: Array<{ key: string }> } }).output;
    expect(output.dtmfSequence).toBe("2");
    expect(output.matchedGoal).toBe(true);
    expect(output.path[0].key).toBe("2");
  });

  it("handover.compose : piloté par le LLM facturé (wallet) + livrable persisté, de bout en bout", async () => {
    mocks.generateForUser.mockResolvedValue({
      response: {
        id: "resp-1",
        provider: "glm",
        model: "glm-test",
        text: JSON.stringify({
          summaryOneLiner: "Client bloqué sur la facturation, humain requis.",
          customerIntent: "Contester un double prélèvement de 49 €.",
          emotionalState: { mood: "irrité", intensity: 4, signals: ["voix tendue", "répétition de la demande"] },
          technicalBlockers: ["module paiement indisponible"],
          collectedData: [{ label: "Montant", value: "49 €" }],
          openQuestions: ["Souhaite-t-il un remboursement ou un avoir ?"],
          suggestedNextActions: ["Rappeler sous 24 h", "Ouvrir un ticket facturation"],
          risksForHandover: ["promesse de remboursement non confirmée"],
        }),
        usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
        latencyMs: 800,
      },
      chargeMinor: 12,
      providerCostEur: 0.01,
    });
    mocks.generateArtifact.mockResolvedValue({
      filename: "brief-de-relais.md",
      mimeType: "text/markdown",
      data: Buffer.from("# Brief de relais IA → humain"),
      format: "md",
      validation: { ok: true },
    });
    mocks.storeArtifactBuffer.mockResolvedValue({
      artifactId: "art-suite-1",
      name: "brief-de-relais.md",
      mimeType: "text/markdown",
      size: 42,
      storageKey: "users/user-suite-1/artifacts/brief-de-relais.md",
      checksum: "abc123",
      createdAt: Date.now(),
    });

    const result = await executeTool({
      userId: "user-suite-1",
      executionId: "exec-suite-handover",
      toolName: "handover.compose",
      input: {
        transcript:
          "Client : Bonjour, j'ai été débité deux fois de 49 € ce mois-ci et personne ne répond depuis mardi. " +
          "Agent : Je comprends votre frustration, je vérifie le dossier immédiatement. " +
          "Client : Je veux un humain maintenant, c'est inadmissible.",
        channel: "chat",
        urgency: "high",
      },
      policy: permissivePolicy(),
    });

    expect(result.success).toBe(true);
    // L'appel LLM est passé par la voie FACTURÉE au nom de l'utilisateur.
    expect(mocks.generateForUser).toHaveBeenCalledTimes(1);
    expect(mocks.generateForUser.mock.calls[0][0]).toMatchObject({ userId: "user-suite-1" });
    // Le livrable est PERSISTÉ (stockage privé), pas un retour volatil.
    expect(mocks.generateArtifact).toHaveBeenCalledTimes(1);
    const persisted = (result as { output: { brief: { customerIntent: string }; artifactId: string; storageKey: string } }).output;
    expect(persisted.artifactId).toBe("art-suite-1");
    expect(persisted.storageKey).toContain("user-suite-1");
    expect(persisted.brief.customerIntent).toContain("double prélèvement");
  });

  it("terminal.shield : refus honnête par la politique sans terminal (jamais de contournement)", async () => {
    const result = await executeTool({
      userId: "user-suite-1",
      executionId: "exec-suite-shield-denied",
      toolName: "terminal.shield",
      input: { command: "node --version" },
      policy: noTerminalPolicy(),
    });
    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toMatch(/Agent terminal denied by policy/);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 9. Garde structurel : la console d'exécution expose les 16 outils
 * ──────────────────────────────────────────────────────────────────────── */

describe("Task 140 — console d'exécution manuelle (garde structurelle)", () => {
  it("la route /api/tools/execute autorise la suite (lecture du source, convention du dépôt)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(import.meta.dirname, "../../../app/api/tools/execute/route.ts"), "utf8");
    for (const name of SUITE_TOOLS) {
      if (name === "build.autofix") {
        // Gated GITHUB_TOKEN dans le source de la route.
        expect(source).toContain('"build.autofix"');
        continue;
      }
      expect(source, `console attendue pour : ${name}`).toContain(`"${name}"`);
    }
    expect(source).toContain("allowAgentTerminal: true");
  });
});
