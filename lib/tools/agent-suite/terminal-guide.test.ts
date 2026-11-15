import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Outil agent « terminal.guide » — Interactive Terminal Simulation Recorder (Task 140).
 *
 * Verrous :
 *  1. schéma d'entrée strict (transcription bornée 30→100 000, public énuméré,
 *     titre borné) ;
 *  2. l'appel LLM passe par generateStructuredForUser — facturé au NOM de
 *     l'utilisateur (userId transmis, task « document », maxTokens 3500),
 *     jamais d'appel direct à un fournisseur ;
 *  3. le guide respecte le schéma zod, les étapes sont triées par ordre, et le
 *     markdown rendu contient TOUTES les sections françaises imposées
 *     (prérequis, « Étape N », commandes encadrées, Pourquoi, sortie attendue,
 *     avertissements ⚠️, pour aller plus loin) ;
 *  4. le livrable est PERSISTÉ via la voie réelle (generateArtifact →
 *     storeArtifactBuffer) avec le userId du contexte ;
 *  5. relance corrective : un premier LLM invalide (texte sans JSON) est
 *     rattrapé au 2e appel ;
 *  6. après épuisement des tentatives, l'erreur française de format remonte
 *     sans masquage et RIEN n'est persisté.
 *
 * Frontières mockées (convention du dépôt) : voie de facturation LLM et
 * moteurs de documents — le sujet testé est le pipeline de l'outil.
 */

const generateForUserMock = vi.fn();
vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: (...args: unknown[]) => generateForUserMock(...args),
}));

const generateArtifactMock = vi.fn();
vi.mock("@/lib/documents/engine", () => ({
  generateArtifact: (...args: unknown[]) => generateArtifactMock(...args),
}));

const storeArtifactBufferMock = vi.fn();
vi.mock("@/lib/documents/artifact-store", () => ({
  storeArtifactBuffer: (...args: unknown[]) => storeArtifactBufferMock(...args),
}));

import { renderTerminalGuideMarkdown, terminalGuideTool, type TerminalGuide } from "./terminal-guide";

const CONTEXT = { userId: "user-1", executionId: "exec-guide-1" };

const VALID_GUIDE: TerminalGuide = {
  title: "Déployer une application Next.js en production",
  prerequisites: ["Node.js 20 installé", "Accès au dépôt Git"],
  steps: [
    {
      order: 1,
      command: "npm ci",
      explanation: "Installe exactement les dépendances verrouillées dans package-lock.json : builds reproductibles.",
      expectedOutput: "added 412 packages in 18s",
      warnings: ["N'utilisez pas npm install : il peut décaler les versions."],
    },
    {
      order: 2,
      command: "npm run build",
      explanation: "Compile l'application et détecte les erreurs de types AVANT le déploiement.",
    },
  ],
  nextSteps: ["Configurer un domaine personnalisé", "Activer les analyses de bundle"],
};

const TRANSCRIPT =
  "$ npm ci\nadded 412 packages in 18s\n$ npm run build\n✓ Compiled successfully in 42s\n$ vercel deploy --prod";

function llmJson(payload: unknown) {
  return { response: { text: JSON.stringify(payload) } };
}

function mockArtifactPipeline() {
  generateArtifactMock.mockResolvedValue({
    filename: "guide-session-terminal.md",
    format: "md",
    mimeType: "text/markdown",
    data: Buffer.from("# Guide de session terminal"),
  });
  storeArtifactBufferMock.mockResolvedValue({
    artifactId: "stored-guide-1",
    name: "guide-session-terminal.md",
    storageKey: "users/user-1/artifacts/stored-guide-1/guide-session-terminal.md",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("outil terminal.guide — schéma d'entrée", () => {
  it("accepte une entrée minimale valide avec le public débutant par défaut", () => {
    const parsed = terminalGuideTool.inputSchema.parse({ sessionTranscript: TRANSCRIPT });
    expect(parsed.audience).toBe("beginner");
    expect(parsed.title).toBeUndefined();
  });

  it("refuse une transcription trop courte (< 30) ou trop longue (> 100 000)", () => {
    expect(() => terminalGuideTool.inputSchema.parse({ sessionTranscript: "trop court" })).toThrow();
    expect(() =>
      terminalGuideTool.inputSchema.parse({ sessionTranscript: "x".repeat(100_001) }),
    ).toThrow();
  });

  it("refuse un public hors énumération et un titre trop long", () => {
    expect(() =>
      terminalGuideTool.inputSchema.parse({ sessionTranscript: TRANSCRIPT, audience: "ninja" }),
    ).toThrow();
    expect(() =>
      terminalGuideTool.inputSchema.parse({ sessionTranscript: TRANSCRIPT, title: "t".repeat(201) }),
    ).toThrow();
  });
});

describe("outil terminal.guide — rendu markdown déterministe", () => {
  it("produit toutes les sections françaises imposées avec la commande encadrée", () => {
    const markdown = renderTerminalGuideMarkdown(VALID_GUIDE, "Mon guide de déploiement");
    expect(markdown).toContain("# Mon guide de déploiement");
    expect(markdown).toContain("## Prérequis");
    expect(markdown).toContain("- Node.js 20 installé");
    expect(markdown).toContain("## Étape 1 — npm ci");
    expect(markdown).toContain("```");
    expect(markdown).toContain("npm ci");
    expect(markdown).toContain("**Pourquoi** : Installe exactement les dépendances");
    expect(markdown).toContain("**Sortie attendue** :");
    expect(markdown).toContain("added 412 packages in 18s");
    expect(markdown).toContain("⚠️ N'utilisez pas npm install");
    expect(markdown).toContain("## Pour aller plus loin");
    expect(markdown).toContain("- Configurer un domaine personnalisé");
  });

  it("dégrade proprement les sections vides (prérequis, suites) sans casse du rendu", () => {
    const markdown = renderTerminalGuideMarkdown(
      { ...VALID_GUIDE, prerequisites: [], nextSteps: [] },
      "Guide minimal",
    );
    expect(markdown).toContain("- Aucun prérequis particulier.");
    expect(markdown).toContain("- Reproduisez la session dans un environnement de test");
  });
});

describe("outil terminal.guide — exécution (LLM facturé + persistance réelle)", () => {
  it("(a) transforme la session en guide complet et PERSISTE le livrable pour l'utilisateur", async () => {
    generateForUserMock.mockResolvedValueOnce(llmJson(VALID_GUIDE));
    mockArtifactPipeline();

    const output = await terminalGuideTool.execute(
      { sessionTranscript: TRANSCRIPT, title: "Mon guide de déploiement" },
      CONTEXT,
    );

    // — Appel LLM facturé au nom de l'utilisateur (task document, 3500 tokens) —
    expect(generateForUserMock).toHaveBeenCalledTimes(1);
    const call = generateForUserMock.mock.calls[0][0];
    expect(call.userId).toBe("user-1");
    expect(call.executionId).toBe("exec-guide-1");
    expect(call.request.task).toBe("document");
    expect(call.request.maxTokens).toBe(3500);
    // Adaptation du niveau au public débutant (défaut) + transcription transmise.
    expect(call.request.system).toContain("DÉBUTANT");
    expect(call.request.messages[0].content).toContain("$ npm ci");

    // — Guide normalisé : étapes triées par ordre croissant —
    expect(output.guide.steps).toHaveLength(2);
    expect(output.guide.steps[0].order).toBe(1);
    expect(output.guide.steps[1].order).toBe(2);

    // — Persistance réelle avec le titre utilisateur prioritaire —
    expect(generateArtifactMock).toHaveBeenCalledTimes(1);
    expect(generateArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        executionId: "exec-guide-1",
        plan: expect.objectContaining({ title: "Mon guide de déploiement", format: "md" }),
      }),
    );
    expect(storeArtifactBufferMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "user-1",
        name: "guide-session-terminal.md",
        mimeType: "text/markdown",
      }),
    );
    expect(output.artifactId).toBe("stored-guide-1");
    expect(output.filename).toBe("guide-session-terminal.md");
    expect(output.storageKey).toBe("users/user-1/artifacts/stored-guide-1/guide-session-terminal.md");
  });

  it("sans titre utilisateur, le titre proposé par le LLM sert au livrable", async () => {
    generateForUserMock.mockResolvedValueOnce(llmJson(VALID_GUIDE));
    mockArtifactPipeline();

    await terminalGuideTool.execute({ sessionTranscript: TRANSCRIPT }, CONTEXT);

    expect(generateArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({ title: "Déployer une application Next.js en production" }),
      }),
    );
  });

  it("adapte le prompt système au public expert (concision exigée)", async () => {
    generateForUserMock.mockResolvedValueOnce(llmJson(VALID_GUIDE));
    mockArtifactPipeline();

    await terminalGuideTool.execute(
      { sessionTranscript: TRANSCRIPT, audience: "expert" },
      CONTEXT,
    );

    const system = generateForUserMock.mock.calls[0][0].request.system;
    expect(system).toContain("EXPERT");
    expect(system).not.toContain("DÉBUTANT");
  });

  it("(b) relance corrective : un premier LLM sans JSON est rattrapé au 2e appel", async () => {
    generateForUserMock
      .mockResolvedValueOnce({ response: { text: "Voici votre guide, sans le moindre JSON." } })
      .mockResolvedValueOnce(llmJson(VALID_GUIDE));
    mockArtifactPipeline();

    const output = await terminalGuideTool.execute({ sessionTranscript: TRANSCRIPT }, CONTEXT);

    expect(generateForUserMock).toHaveBeenCalledTimes(2);
    // La relance injecte l'écart constaté au modèle.
    expect(generateForUserMock.mock.calls[1][0].request.messages[0].content).toContain(
      "ta réponse précédente était invalide",
    );
    expect(output.artifactId).toBe("stored-guide-1");
    expect(storeArtifactBufferMock).toHaveBeenCalledTimes(1);
  });

  it("(d) deux tentatives invalides : erreur française de format, rien n'est persisté", async () => {
    generateForUserMock.mockResolvedValue({ response: { text: "toujours aucun json ici" } });

    await expect(
      terminalGuideTool.execute({ sessionTranscript: TRANSCRIPT }, CONTEXT),
    ).rejects.toThrow(/format attendu/);
    expect(generateForUserMock).toHaveBeenCalledTimes(2);
    expect(generateArtifactMock).not.toHaveBeenCalled();
    expect(storeArtifactBufferMock).not.toHaveBeenCalled();
  });
});
