import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../ai/router", () => ({
  generate: vi.fn(),
}));

// Le grounding (contexte de vérité) interroge l'index vectoriel : mocké ici
// pour garder ce test unitaire hermétique (aucun Firestore/Qdrant réel).
vi.mock("@/lib/chat/vector-index", () => ({
  searchConversationMessages: vi.fn(async () => []),
}));

import { generate } from "../ai/router";
import { answerAsAgent, classifyRequest, heuristicClassification, unavailableCapabilityReply, planAgentTask } from "./chat-engine";
import type { AgentRecord } from "./schema";

const mockedGenerate = vi.mocked(generate);

const agent = {
  id: "agent-1",
  ownerId: "user-1",
  name: "CodeMaster",
  description: "Agent développeur senior.",
  type: "code" as const,
  typeLabel: "Développement & Code",
  skills: ["React", "Débogage"],
  agentMode: "standard" as const,
  memoryFile: undefined,
  systemPrompt: "charte",
  projectId: undefined,
  modelStrategy: "automatic" as const,
  preferredProvider: undefined,
  preferredModel: undefined,
  autonomous: true,
  maxIterations: 8,
  tools: ["code.execute"],
  memoryEnabled: true,
  webResearchEnabled: true,
  documentGenerationEnabled: true,
  voiceEnabled: false,
  status: "active" as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as AgentRecord;

beforeEach(() => {
  mockedGenerate.mockReset();
});

describe("classifyRequest", () => {
  it("retourne le mode chat pour une salutation (réponse claire et simple)", async () => {
    mockedGenerate.mockResolvedValueOnce({
      text: JSON.stringify({ mode: "chat", inScope: true, reason: "Salutation" }),
    } as Awaited<ReturnType<typeof generate>>);
    const result = await classifyRequest(agent, "Bonjour, qui es-tu ?");
    expect(result.mode).toBe("chat");
    expect(result.inScope).toBe(true);
  });

  it("retourne le mode task pour une demande d'exécution dans le périmètre", async () => {
    mockedGenerate.mockResolvedValueOnce({
      text: '```json\n{"mode":"task","inScope":true,"reason":"Création de composant"}\n```',
    } as Awaited<ReturnType<typeof generate>>);
    const result = await classifyRequest(agent, "Crée un composant React de bouton primaire.");
    expect(result.mode).toBe("task");
    expect(result.inScope).toBe(true);
  });

  it("détecte une demande hors périmètre", async () => {
    mockedGenerate.mockResolvedValueOnce({
      text: JSON.stringify({ mode: "chat", inScope: false, reason: "Marketing, hors domaine code" }),
    } as Awaited<ReturnType<typeof generate>>);
    const result = await classifyRequest(agent, "Rédige une stratégie marketing complète pour 2027.");
    expect(result.inScope).toBe(false);
  });

  it("replie heuristique quand le classificateur échoue", async () => {
    mockedGenerate.mockRejectedValueOnce(new Error("provider down"));
    const result = await classifyRequest(agent, "Construis une API REST complète.");
    expect(result.mode).toBe("task");
    expect(result.reason).toContain("heuristique");
  });

  it("gère une réponse LLM malformée par le repli heuristique", async () => {
    mockedGenerate.mockResolvedValueOnce({ text: "je ne comprends pas" } as Awaited<ReturnType<typeof generate>>);
    const result = await classifyRequest(agent, "Bonjour");
    expect(result.mode).toBe("chat");
  });

  it("propage la clarifyingQuestion du classificateur (canal de clarification)", async () => {
    mockedGenerate.mockResolvedValueOnce({
      text: JSON.stringify({
        mode: "chat",
        inScope: true,
        reason: "Ambiguïté réelle",
        clarifyingQuestion: "Voulez-vous que je rédige le plan de lancement ou que j'envoie la campagne ?",
      }),
    } as Awaited<ReturnType<typeof generate>>);
    const result = await classifyRequest(agent, "Prépare le lancement");
    expect(result.mode).toBe("chat");
    expect(result.clarifyingQuestion).toContain("plan de lancement");
  });

  it("laisse clarifyingQuestion absente quand le classificateur n'en propose pas", async () => {
    mockedGenerate.mockResolvedValueOnce({
      text: JSON.stringify({ mode: "task", inScope: true, reason: "Exécution claire" }),
    } as Awaited<ReturnType<typeof generate>>);
    const result = await classifyRequest(agent, "Crée un bouton React.");
    expect(result.clarifyingQuestion).toBeUndefined();
  });
});

describe("heuristicClassification (repli déterministe)", () => {
  it("classe les questions conversationnelles en chat", () => {
    expect(heuristicClassification("Bonjour, comment ça va ?").mode).toBe("chat");
    expect(heuristicClassification("Qu'est-ce que tu sais faire ?").mode).toBe("chat");
    expect(heuristicClassification("Explique-moi le TypeScript.").mode).toBe("chat");
  });

  it("classe les demandes d'action en task", () => {
    expect(heuristicClassification("Crée un site vitrine complet.").mode).toBe("task");
    expect(heuristicClassification("Analyse ce fichier et prépare un rapport.").mode).toBe("task");
    expect(heuristicClassification("Génère un PDF de 10 pages.").mode).toBe("task");
  });

  it("détection de question INDÉPENDANTE DE LA LANGUE (audit : marqueurs FR uniquement)", () => {
    expect(heuristicClassification("What can you do for me?").mode).toBe("chat");
    expect(heuristicClassification("How does the billing work on Gen3ia?").mode).toBe("chat");
    expect(heuristicClassification("Who created you?").mode).toBe("chat");
  });

  it("une LONGUE question française reste une question (plafond 400 → 1200)", () => {
    const longQuestion = `${"Explique-moi en détail comment fonctionne le système de facturation de la plateforme, ".repeat(9)}et donne-moi des exemples ?`;
    expect(longQuestion.length).toBeGreaterThan(400);
    expect(longQuestion.length).toBeLessThanOrEqual(1200);
    expect(heuristicClassification(longQuestion).mode).toBe("chat");
  });

  it("un « ? » dans les 200 derniers caractères suffit (question longue à préambule)", () => {
    const preamble = `${"Voici le contexte de mon projet : je gère une boutique de vêtements en ligne avec plusieurs fournisseurs. ".repeat(4)}`;
    const message = `${preamble}peux-tu m'expliquer comment suivre mes stocks ?`;
    expect(message.length).toBeGreaterThan(400);
    expect(heuristicClassification(message).mode).toBe("chat");
  });

  it("les verbes d'action EXPLICITES forcent task, même polis ou avec un « ? »", () => {
    expect(heuristicClassification("Peux-tu générer un rapport complet des ventes ?").mode).toBe("task");
    expect(heuristicClassification("Please generate a full report for Q3").mode).toBe("task");
    expect(heuristicClassification("Can you send the invoice to the client?").mode).toBe("task");
    expect(heuristicClassification("envoie le fichier au client").mode).toBe("task");
  });
});

describe("unavailableCapabilityReply", () => {
  it("explique honnêtement la capacité manquante SANS refuser le domaine (exigence utilisateur : agent polyvalent)", () => {
    const reply = unavailableCapabilityReply(agent, "Rédige une campagne publicitaire pour mon restaurant.");
    expect(reply).toContain("CodeMaster");
    expect(reply).toContain("Développement & Code");
    expect(reply).toContain("campagne publicitaire");
    expect(reply).toContain("capacité qui n'est pas disponible");
    expect(reply).toContain("outils fournis");
    // L'ancien refus hors-domaine ne doit plus apparaître.
    expect(reply).not.toContain("sort de mon périmètre");
    expect(reply).not.toContain("reformuler votre besoin dans mon domaine");
    expect(reply).not.toContain("créez un agent dédié");
  });
});

describe("answerAsAgent", () => {
  it("injecte la charte comme message système et transmet l'historique", async () => {
    mockedGenerate.mockResolvedValueOnce({ text: "  Réponse professionnelle.  " } as Awaited<ReturnType<typeof generate>>);
    const reply = await answerAsAgent("user-1", agent, [{ role: "user", content: "Salut" }, { role: "assistant", content: "Bonjour !" }], "Comment tu fonctionnes ?");
    expect(reply).toBe("Réponse professionnelle.");
    const call = mockedGenerate.mock.calls[0][0];
    expect(call.messages[0].role).toBe("system");
    expect(call.messages[0].content).toContain("CodeMaster");
    expect(call.messages[0].content).toContain("PÉRIMÈTRE & POLYVALENCE");
    // Le message utilisateur est préfixé par le grounding (contexte de vérité).
    expect(call.messages.at(-1)?.content).toContain("Comment tu fonctionnes ?");
    expect(call.messages).toHaveLength(4);
  });

  it("préfixe la note de contexte au message utilisateur", async () => {
    mockedGenerate.mockResolvedValueOnce({ text: "ok" } as Awaited<ReturnType<typeof generate>>);
    await answerAsAgent("user-1", agent, [], "Résume ce document.", "[Fichier disponible : notes.pdf]");
    const call = mockedGenerate.mock.calls[0][0];
    expect(call.messages.at(-1)?.content).toContain("[Fichier disponible : notes.pdf]");
    expect(call.messages.at(-1)?.content).toContain("Résume ce document.");
  });
});

describe("planAgentTask", () => {
  it("réserve le catalogue d'outils à la whitelist de l'agent", async () => {
    mockedGenerate.mockResolvedValueOnce({
      text: JSON.stringify({
        executionId: "exec-1",
        objective: "Crée un bouton",
        steps: [{ id: "s1", type: "tool", toolName: "code.execute", name: "Exécution", description: "Exécute" }],
        maxConcurrency: 1,
        maxIterations: 5,
      }),
    } as Awaited<ReturnType<typeof generate>>);
    const plan = await planAgentTask("user-1", agent, "Crée un bouton");
    // La charte doit être injectée dans le prompt du planificateur.
    const call = mockedGenerate.mock.calls[0][0];
    expect(call.messages[0].content).toContain("AGENT PERSONNALISÉ — CHARTE OBLIGATOIRE");
    expect(call.messages[0].content).toContain("CodeMaster");
    // Les capacités présentées au planificateur sont restreintes (catalogue texte).
    const presented = JSON.parse(call.messages[1].content as string);
    expect(typeof presented.availableCapabilities).toBe("string");
    expect(presented.availableCapabilities).toContain("code.execute");
    expect(presented.availableCapabilities).not.toContain("camera.capture");
    expect(plan.steps[0].type).toBe("tool");
    expect(plan.steps[0].toolName).toBe("code.execute");
  });
});
