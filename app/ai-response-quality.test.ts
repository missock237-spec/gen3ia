import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 52 — QUALITÉ DES RÉPONSES IA (exigence utilisateur : réponses claires,
 * précises selon le sujet saisi, comparables à ChatGPT à chaque requête).
 *
 * Ces tests verrouillent le CÂBLAGE réel de la qualité :
 *  1. `answerAsAgent` (chat d'agent) : contrat de présentation injecté,
 *     routage qualité (plus de préférence « modèles gratuits » en mode
 *     premium), budget de sortie suffisant ;
 *  2. les chemins VISIBLES du moteur conversationnel ne contiennent plus
 *     AUCUN `preferFree: true` codé en dur (garde structurel anti-régression
 *     : une nouvelle surface visible doit passer par la politique de
 *     qualité) ;
 *  3. la route de chat générique a un system prompt de qualité + nettoyage
 *     <think> + fenêtre de contexte assemblée ;
 *  4. le renderer markdown rend les tableaux et séparateurs exigés par le
 *     contrat (aucune syntaxe demandée au modèle sans rendu réel).
 */

import { generate } from "@/lib/ai/router";
import { answerAsAgent } from "@/lib/agents/chat-engine";
import type { AgentRecord } from "@/lib/agents/schema";

vi.mock("@/lib/ai/router", () => ({
  generate: vi.fn(),
}));

// Le grounding (contexte de vérité) interroge l'index vectoriel : mocké ici
// pour garder ce test hermétique (aucun Firestore/Qdrant réel).
vi.mock("@/lib/chat/vector-index", () => ({
  searchConversationMessages: vi.fn(async () => []),
}));

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

const ENGINE_SOURCE = readFileSync(
  path.resolve(process.cwd(), "lib/domain/conversations/engine.ts"),
  "utf8",
);
const CHAT_MESSAGE_SOURCE = readFileSync(
  path.resolve(process.cwd(), "app/api/chat/message/route.ts"),
  "utf8",
);
const RUNNER_SOURCE = readFileSync(
  path.resolve(process.cwd(), "lib/agents/runtime/runner.ts"),
  "utf8",
);
const MARKDOWN_SOURCE = readFileSync(
  path.resolve(process.cwd(), "components/workspace/markdown.tsx"),
  "utf8",
);
const MARKDOWN_PARSER_SOURCE = readFileSync(
  path.resolve(process.cwd(), "lib/ui/markdown-blocks.ts"),
  "utf8",
);
const CHAT_ENGINE_SOURCE = readFileSync(
  path.resolve(process.cwd(), "lib/agents/chat-engine.ts"),
  "utf8",
);

beforeEach(() => {
  delete process.env.GEN3IA_RESPONSE_QUALITY;
  mockedGenerate.mockReset();
  mockedGenerate.mockResolvedValue({ text: "Réponse structurée." } as Awaited<ReturnType<typeof generate>>);
});

describe("answerAsAgent — chat d'agent personnalisé (visible)", () => {
  it("injecte le contrat de présentation APRÈS la charte (charte intacte en tête)", async () => {
    await answerAsAgent("user-1", agent, [], "Bonjour");
    const call = mockedGenerate.mock.calls[0][0];
    const system = call.messages[0]?.content ?? "";
    expect(system).toContain("CodeMaster");
    expect(system).toContain("PÉRIMÈTRE & POLYVALENCE");
    expect(system).toContain("FORMAT DE RÉPONSE");
    expect(system.indexOf("PÉRIMÈTRE & POLYVALENCE")).toBeLessThan(system.indexOf("FORMAT DE RÉPONSE"));
  });

  it("routage qualité : PAS de préférence gratuite en mode premium (défaut)", async () => {
    await answerAsAgent("user-1", agent, [], "Bonjour");
    const call = mockedGenerate.mock.calls[0][0];
    expect(call.preferFree).toBe(false);
  });

  it("mode free explicite : le comportement gratuit historique reste accessible", async () => {
    process.env.GEN3IA_RESPONSE_QUALITY = "free";
    await answerAsAgent("user-1", agent, [], "Bonjour");
    const call = mockedGenerate.mock.calls[0][0];
    expect(call.preferFree).toBe(true);
  });

  it("budget de sortie 4096 tokens (les longues réponses ne sont plus tronquées à 3000)", async () => {
    await answerAsAgent("user-1", agent, [], "Bonjour");
    const call = mockedGenerate.mock.calls[0][0];
    expect(call.maxTokens).toBe(4096);
  });

  it("les tâches de COMPRÉHENSION (classification) suivent la politique de qualité (plus de gratuit forcé)", () => {
    // FIX compréhension : le classificateur conditionne la qualité de la
    // réponse finale — il ne force PLUS `preferFree: true` : il suit la
    // politique `preferFreeForUnderstanding()` (gratuit uniquement en mode
    // free explicite, meilleur fournisseur en premium). Garde structurel :
    // un retour au gratuit forcé serait une régression qualité.
    expect(CHAT_ENGINE_SOURCE).toMatch(/preferFree: preferFreeForUnderstanding\(\)[\s\S]{0,200}?purpose: "agent-chat-classification"/s);
  });
});

describe("moteur conversationnel — chemins visibles sans préférence gratuite", () => {
  it("AUCUN `preferFree: true` codé en dur dans engine.ts (toutes les réponses visibles passent par la politique de qualité)", () => {
    expect(ENGINE_SOURCE).not.toMatch(/preferFree:\s*true/);
    expect(ENGINE_SOURCE).toContain("preferFreeForVisibleAnswers()");
  });

  it("le contrat de présentation est injecté dans le system du tour chat", () => {
    expect(ENGINE_SOURCE).toContain("RESPONSE_FORMAT_RULES");
    // Import réel du module de qualité.
    expect(ENGINE_SOURCE).toContain("@/lib/ai/response-quality");
  });

  it("la synthèse de plan garde un budget de sortie lisible (1200 tokens)", () => {
    expect(ENGINE_SOURCE).toContain("maxTokens: 1200");
  });
});

describe("route /api/chat/message — chat générique (visible)", () => {
  it("possède un system prompt de qualité dès la première réponse", () => {
    expect(CHAT_MESSAGE_SOURCE).toContain("withResponseStyle()");
    expect(CHAT_MESSAGE_SOURCE).toContain("@/lib/ai/response-quality");
  });

  it("assemble l'historique dans la fenêtre du modèle (plus d'empilement brut)", () => {
    expect(CHAT_MESSAGE_SOURCE).toContain("assembleMessages(");
  });

  it("nettoie les balises de raisonnement avant persistance", () => {
    expect(CHAT_MESSAGE_SOURCE).toContain("stripThinkTags(response.text)");
  });

  it("routage par défaut = politique de qualité (sauf choix explicite du client)", () => {
    expect(CHAT_MESSAGE_SOURCE).toContain("preferFree: body.preferFree ?? preferFreeForVisibleAnswers()");
  });

  it("budget de sortie par défaut 4096 tokens", () => {
    expect(CHAT_MESSAGE_SOURCE).toContain("body.maxTokens ?? 4_096");
  });
});

describe("runtime de mission — livrables des étapes llm et sous-agents", () => {
  it("executeLLM et executeSubAgent reçoivent le contrat de présentation", () => {
    expect(RUNNER_SOURCE).toContain("systemWithStyle");
    expect(RUNNER_SOURCE).toContain("subSystemWithStyle");
    expect(RUNNER_SOURCE).toContain("@/lib/ai/response-quality");
  });

  it("les appels JSON STRUCTURÉS (plannificateur, artefacts) ne sont PAS altérés par le contrat de présentation", () => {
    // Le contrat ne doit s'appliquer qu'aux réponses narrées : les prompts
    // JSON stricts (planner, rédaction artefact) restent inchangés.
    expect(RUNNER_SOURCE).not.toMatch(/ARTIFACT_PLAN_SYSTEM[\s\S]{0,400}RESPONSE_FORMAT_RULES/s);
  });
});

describe("renderer markdown — tout ce que le contrat exige est réellement rendu", () => {
  it("supporte les TABLEAUX (ligne d'en-tête + séparateur + lignes)", () => {
    expect(MARKDOWN_PARSER_SOURCE).toContain('kind: "table"');
    expect(MARKDOWN_PARSER_SOURCE).toContain("TABLE_DELIMITER");
    expect(MARKDOWN_PARSER_SOURCE).toContain("splitTableRow");
    // Rendu réel en éléments React sûrs dans le composant (aucun usage du
    // HTML brut : jamais de dangerouslySetInnerHTML={{…}}).
    expect(MARKDOWN_SOURCE).toContain("<table");
    expect(MARKDOWN_SOURCE).not.toMatch(/dangerouslySetInnerHTML=\{\{/);
    // Le composant consomme bien le parser pur (une seule source de vérité).
    expect(MARKDOWN_SOURCE).toContain("@/lib/ui/markdown-blocks");
  });

  it("supporte les SÉPARATEURS horizontaux (---)", () => {
    expect(MARKDOWN_PARSER_SOURCE).toContain('kind: "hr"');
    expect(MARKDOWN_PARSER_SOURCE).toContain("HORIZONTAL_RULE");
    expect(MARKDOWN_SOURCE).toContain('case "hr"');
  });
});
