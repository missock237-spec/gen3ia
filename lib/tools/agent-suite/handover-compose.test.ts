import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Outil agent « handover.compose » — OmniContext Live Handover (Task 140).
 *
 * Verrous :
 *  1. schéma d'entrée strict (transcription bornée, canal/urgence énumérés) ;
 *  2. l'appel LLM passe par generateStructuredForUser — facturé au NOM de
 *     l'utilisateur (userId transmis, task « agent », maxTokens 2500), jamais
 *     d'appel direct à un fournisseur ;
 *  3. le brief généré respecte le schéma zod (validation) et le markdown
 *     rendu contient TOUTES les sections françaises imposées ;
 *  4. le livrable est PERSISTÉ via la voie réelle (generateArtifact →
 *     storeArtifactBuffer) avec le userId du contexte ;
 *  5. relance corrective : un premier LLM invalide (texte sans JSON) est
 *     rattrapé au 2e appel ;
 *  6. après épuisement des tentatives, l'erreur française remonte sans
 *     masquage et RIEN n'est persisté.
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

import { handoverComposeTool } from "./handover-compose";

const CONTEXT = { userId: "user-1", executionId: "exec-relais-1" };

const VALID_BRIEF = {
  summaryOneLiner: "Le client veut récupérer l'accès à son espace avant vendredi.",
  customerIntent: "Réinitialiser son accès et obtenir une facture rectificative.",
  emotionalState: {
    mood: "frustré",
    intensity: 4,
    signals: ["ton sec", "deux relances en dix minutes"],
  },
  technicalBlockers: ["Adresse e-mail de secours non validée"],
  collectedData: [{ label: "Identifiant client", value: "C-2041" }],
  openQuestions: ["Faut-il conserver l'ancien abonnement ?"],
  suggestedNextActions: ["Confirmer l'identité par SMS", "Émettre la facture rectificative"],
  risksForHandover: ["L'IA a promis un délai de 24 h non validé par le support"],
};

const TRANSCRIPT =
  "Client : je n'arrive plus à me connecter depuis ce matin, c'est la troisième fois ce mois-ci.\n" +
  "Agent IA : je comprends, vérifions ensemble votre adresse de secours…";

function mockLlmValidOnce() {
  generateForUserMock.mockResolvedValueOnce({
    response: { text: JSON.stringify(VALID_BRIEF) },
  });
}

function mockArtifactPipeline() {
  generateArtifactMock.mockResolvedValue({
    artifactId: "gen-1",
    filename: "Brief-de-relais.md",
    format: "md",
    mimeType: "text/markdown",
    data: Buffer.from("# Brief de relais IA → humain"),
  });
  storeArtifactBufferMock.mockResolvedValue({
    artifactId: "stored-1",
    name: "Brief-de-relais.md",
    storageKey: "users/user-1/artifacts/stored-1/Brief-de-relais.md",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("outil handover.compose — schéma d'entrée", () => {
  it("accepte une entrée minimale valide avec les défauts chat/normal", () => {
    const parsed = handoverComposeTool.inputSchema.parse({ transcript: TRANSCRIPT });
    expect(parsed.channel).toBe("chat");
    expect(parsed.urgency).toBe("normal");
  });

  it("refuse une transcription trop courte (<30) ou trop longue (>60 000)", () => {
    expect(() => handoverComposeTool.inputSchema.parse({ transcript: "trop court" })).toThrow();
    expect(() =>
      handoverComposeTool.inputSchema.parse({ transcript: "a".repeat(60_001) }),
    ).toThrow();
  });

  it("refuse un canal ou une urgence hors énumération", () => {
    expect(() =>
      handoverComposeTool.inputSchema.parse({ transcript: TRANSCRIPT, channel: "sms" }),
    ).toThrow();
    expect(() =>
      handoverComposeTool.inputSchema.parse({ transcript: TRANSCRIPT, urgency: "urgentissime" }),
    ).toThrow();
  });
});

describe("outil handover.compose — exécution (LLM facturé + persistance réelle)", () => {
  it("produit un brief conforme au schéma, rend le markdown français complet et PERSISTE le livrable pour l'utilisateur", async () => {
    mockLlmValidOnce();
    mockArtifactPipeline();

    const output = await handoverComposeTool.execute(
      { transcript: TRANSCRIPT, channel: "chat", urgency: "normal" },
      CONTEXT,
    );

    // — Brief validé par le schéma —
    expect(output.brief).toEqual(VALID_BRIEF);
    expect(output.brief.emotionalState.intensity).toBe(4);

    // — Appel LLM facturé au nom de l'utilisateur (task agent, maxTokens 2500) —
    expect(generateForUserMock).toHaveBeenCalledTimes(1);
    const billedCall = generateForUserMock.mock.calls[0][0] as {
      userId: string;
      executionId: string;
      request: { task: string; maxTokens: number; requiresStructuredOutput: boolean };
    };
    expect(billedCall.userId).toBe("user-1");
    expect(billedCall.executionId).toBe("exec-relais-1");
    expect(billedCall.request.task).toBe("agent");
    expect(billedCall.request.maxTokens).toBe(2_500);
    expect(billedCall.request.requiresStructuredOutput).toBe(true);

    // — Markdown : toutes les sections françaises imposées —
    expect(generateArtifactMock).toHaveBeenCalledTimes(1);
    const artifactCall = generateArtifactMock.mock.calls[0][0] as {
      userId: string;
      executionId: string;
      plan: { title: string; format: string; blocks: Array<{ type: string; text?: string }> };
    };
    expect(artifactCall.userId).toBe("user-1");
    expect(artifactCall.executionId).toBe("exec-relais-1");
    expect(artifactCall.plan.title).toBe("Brief de relais");
    expect(artifactCall.plan.format).toBe("md");

    const headings = artifactCall.plan.blocks
      .filter((block) => block.type === "heading")
      .map((block) => block.text);
    expect(headings).toContain("Brief de relais IA → humain");
    expect(headings).toContain("Résumé en une phrase");
    expect(headings).toContain("Intention du client");
    expect(headings).toContain("État émotionnel");
    expect(headings).toContain("Blocages techniques");
    expect(headings).toContain("Données collectées");
    expect(headings).toContain("Questions ouvertes");
    expect(headings).toContain("Actions suivantes recommandées");
    expect(headings).toContain("Risques pour la reprise");

    const paragraphs = artifactCall.plan.blocks
      .filter((block) => block.type === "paragraph")
      .map((block) => block.text);
    expect(paragraphs).toContain("Canal : chat · Urgence : normale");
    expect(paragraphs).toContain("Humeur : frustré — Intensité : 4/5");
    expect(paragraphs).toContain("| Donnée | Valeur |");
    expect(paragraphs).toContain("| Identifiant client | C-2041 |");

    // — Livrable stocké avec le userId du contexte —
    expect(storeArtifactBufferMock).toHaveBeenCalledTimes(1);
    expect(storeArtifactBufferMock.mock.calls[0][0]).toMatchObject({
      ownerId: "user-1",
      executionId: "exec-relais-1",
      name: "Brief-de-relais.md",
    });

    expect(output).toEqual({
      brief: VALID_BRIEF,
      artifactId: "stored-1",
      filename: "Brief-de-relais.md",
      storageKey: "users/user-1/artifacts/stored-1/Brief-de-relais.md",
    });
  });

  it("restitue le canal et l'urgence demandés (téléphone · critique) dans l'en-tête du brief", async () => {
    mockLlmValidOnce();
    mockArtifactPipeline();

    await handoverComposeTool.execute(
      { transcript: TRANSCRIPT, channel: "phone", urgency: "critical" },
      CONTEXT,
    );

    const artifactCall = generateArtifactMock.mock.calls[0][0] as {
      plan: { blocks: Array<{ type: string; text?: string }> };
    };
    const paragraphs = artifactCall.plan.blocks
      .filter((block) => block.type === "paragraph")
      .map((block) => block.text);
    expect(paragraphs).toContain("Canal : téléphone · Urgence : critique");
  });

  it("relance le LLM après un JSON invalide : le 2e appel valide réussit (2 appels facturés)", async () => {
    generateForUserMock
      .mockResolvedValueOnce({
        response: { text: "Désolé, voici une analyse en texte libre sans aucun JSON." },
      })
      .mockResolvedValueOnce({ response: { text: JSON.stringify(VALID_BRIEF) } });
    mockArtifactPipeline();

    const output = await handoverComposeTool.execute({ transcript: TRANSCRIPT }, CONTEXT);

    expect(generateForUserMock).toHaveBeenCalledTimes(2);
    // La relance corrective expose l'écart au modèle.
    const secondCall = generateForUserMock.mock.calls[1][0] as {
      request: { messages: Array<{ role: string; content: string }> };
    };
    expect(secondCall.request.messages[0].content).toContain("Corrige");
    expect(output.brief.summaryOneLiner).toBe(VALID_BRIEF.summaryOneLiner);
    expect(storeArtifactBufferMock).toHaveBeenCalledTimes(1);
  });

  it("remonte l'erreur française après épuisement des tentatives et ne PERSISTE rien", async () => {
    generateForUserMock.mockResolvedValue({
      response: { text: "Toujours pas de JSON, seulement du texte." },
    });

    await expect(
      handoverComposeTool.execute({ transcript: TRANSCRIPT }, CONTEXT),
    ).rejects.toThrow(/n'a pas produit une réponse conforme/);

    expect(generateForUserMock).toHaveBeenCalledTimes(2);
    expect(generateArtifactMock).not.toHaveBeenCalled();
    expect(storeArtifactBufferMock).not.toHaveBeenCalled();
  });

  it("propage l'erreur du LLM facturé sans masquage (wallet insuffisant)", async () => {
    generateForUserMock.mockRejectedValue(
      new Error("Insufficient balance. Required reserve: 100 cents; available: 0 cents."),
    );

    await expect(
      handoverComposeTool.execute({ transcript: TRANSCRIPT }, CONTEXT),
    ).rejects.toThrow(/Insufficient balance/);

    expect(generateArtifactMock).not.toHaveBeenCalled();
  });
});
