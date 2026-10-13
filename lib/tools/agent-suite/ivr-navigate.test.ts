import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tool « ivr.navigate » (Task 140) — navigation optimale dans un arbre SVI.
 *
 * Verrous :
 *  1. arbre structuré fourni → chemin déterministe (BFS + score lexical),
 *     raccourci « human » (+5) pour les objectifs conseiller/opérateur ;
 *  2. transcription → l'arbre est reconstruit par le LLM (tâche « agent »)
 *     puis marché exactement comme un arbre fourni ;
 *  3. confiance insuffisante → repli LLM one-shot dont les touches sont
 *     REVALIDÉES en remarchant l'arbre : touche inexistante → chemin tronqué
 *     + avertissement honnête (jamais d'invention) ;
 *  4. garde de profondeur : arbre trop profond → erreur française ;
 *  5. correspondance insensible aux accents (réclamation ≡ reclamation).
 *
 * Le LLM est moqué à la frontière generateForUser (même voie que le
 * runtime) : les réponses sont des JSON valides consommés par
 * generateStructuredForUser (lib/tools/agent-suite/llm-json.ts).
 */

const generateMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: (...args: unknown[]) => generateMock(...args),
}));

import { ivrNavigateTool, type IvrMenuNode } from "./ivr-navigate";

/** Fonction moquée (frontière generateForUser) — même objet que generateMock. */
const mockedGenerate = generateMock;

interface LlmCall {
  userId: string;
  request: {
    task: string;
    system: string;
    messages: Array<{ role: string; content: string }>;
    requiresStructuredOutput: boolean;
    maxTokens: number;
  };
}

/** Répond au LLM selon la tâche demandée (parseur SVI vs repli de touches). */
function respondToLlm(handlers: { transcript?: unknown; fallback?: unknown }) {
  generateMock.mockImplementation((async (call: LlmCall) => {
    let payload: unknown;
    if (call.request.system.includes("analyseur de serveurs vocaux")) {
      if (handlers.transcript === undefined) throw new Error("parseur SVI inattendu dans ce test");
      payload = handlers.transcript;
    } else {
      if (handlers.fallback === undefined) throw new Error("repli SVI inattendu dans ce test");
      payload = handlers.fallback;
    }
    return {
      chargeMinor: 1,
      providerCostEur: 0,
      response: { text: JSON.stringify(payload), usage: { inputTokens: 10, outputTokens: 5 } },
    };
  }) as unknown as never);
}

const CONTEXT = { userId: "user-1", executionId: "exec-ivr-1" };

/* ──────────────────────────────────────────────────────────────────── */
/* Arbres de test                                                      */
/* ──────────────────────────────────────────────────────────────────── */

const SUPPORT_TREE: IvrMenuNode = {
  label: "Accueil",
  prompt: "Bienvenue au service client. Pour un conseiller tapez 1, facturation tapez 2, réclamations tapez 3.",
  options: [
    { key: "1", label: "Parler à un conseiller", action: "human" },
    {
      key: "2",
      label: "Service facturation",
      action: "submenu",
      submenu: {
        prompt: "Facturation : consulter une facture tapez 1, contester tapez 2.",
        options: [
          { key: "1", label: "Consulter mes factures", action: "info" },
          {
            key: "2",
            label: "Contester une facture",
            action: "submenu",
            submenu: {
              options: [{ key: "1", label: "Contacter le service litiges", action: "human" }],
            },
          },
        ],
      },
    },
    {
      key: "3",
      label: "Réclamations et litiges",
      action: "submenu",
      submenu: {
        options: [{ key: "1", label: "Déposer une réclamation", action: "info" }],
      },
    },
    { key: "0", label: "Réécouter le menu", action: "info" },
  ],
};

const SIMPLE_TREE: IvrMenuNode = {
  options: [{ key: "1", label: "Commander une pizza", action: "info" }],
};

function deepTree(levels: number): IvrMenuNode {
  let node: IvrMenuNode = { options: [{ key: "9", label: "Sortie", action: "end" }] };
  for (let i = 0; i < levels; i += 1) {
    node = { label: `Niveau ${i}`, options: [{ key: "1", label: `Sous-menu ${i}`, action: "submenu", submenu: node }] };
  }
  return node;
}

beforeEach(() => {
  generateMock.mockReset();
});

/* ──────────────────────────────────────────────────────────────────── */
/* Schéma d'entrée                                                     */
/* ──────────────────────────────────────────────────────────────────── */

describe("ivr.navigate — schéma d'entrée", () => {
  it("exige menuTranscript OU menuTree", () => {
    expect(() => ivrNavigateTool.inputSchema.parse({ goal: "parler à un conseiller" })).toThrow(
      /menuTranscript|menuTree/,
    );
  });

  it("refuse une transcription trop courte, un objectif trop court et des touches invalides", () => {
    expect(() =>
      ivrNavigateTool.inputSchema.parse({ goal: "parler à un conseiller", menuTranscript: "trop court" }),
    ).toThrow();
    expect(() => ivrNavigateTool.inputSchema.parse({ goal: "ab", menuTree: SIMPLE_TREE })).toThrow();
    expect(() =>
      ivrNavigateTool.inputSchema.parse({
        goal: "parler à un conseiller",
        menuTree: { options: [{ key: "A", label: "invalide", action: "info" }] },
      }),
    ).toThrow();
  });

  it("accepte un arbre imbriqué valide (lazy récursif)", () => {
    const parsed = ivrNavigateTool.inputSchema.parse({
      goal: "contester une facture",
      menuTree: SUPPORT_TREE,
    });
    expect(parsed.menuTree?.options).toHaveLength(4);
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* (a) Arbre fourni — chemin déterministe                              */
/* ──────────────────────────────────────────────────────────────────── */

describe("ivr.navigate — arbre fourni (déterministe)", () => {
  it("(a) trouve le chemin human avec une confiance maximale pour « parler à un conseiller »", async () => {
    const result = await ivrNavigateTool.execute(
      { goal: "parler à un conseiller", menuTree: SUPPORT_TREE },
      CONTEXT,
    );
    expect(result.matchedGoal).toBe(true);
    expect(result.confidence).toBe(1);
    expect(result.dtmfSequence).toBe("1");
    expect(result.path).toEqual([
      { step: 1, key: "1", label: "Parler à un conseiller", action: "human" },
    ]);
    expect(result.estimatedDurationSeconds).toBe(5);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("descend dans les sous-menus quand l'objectif y correspond mieux (BFS)", async () => {
    const result = await ivrNavigateTool.execute(
      { goal: "contester une facture", menuTree: SUPPORT_TREE },
      CONTEXT,
    );
    expect(result.matchedGoal).toBe(true);
    expect(result.confidence).toBe(1);
    expect(result.dtmfSequence).toBe("2,2");
    expect(result.path.map((step) => step.key)).toEqual(["2", "2"]);
    expect(result.path[1]?.label).toBe("Contester une facture");
    expect(result.estimatedDurationSeconds).toBe(8);
  });

  it("(e) correspond insensible aux accents : « réclamation urgente » ≡ « Reclamations urgentes »", async () => {
    const tree: IvrMenuNode = {
      options: [
        { key: "1", label: "Horaires des magasins", action: "info" },
        { key: "2", label: "Reclamations urgentes", action: "submenu", submenu: { options: [{ key: "1", label: "Formulaire", action: "info" }] } },
      ],
    };
    const result = await ivrNavigateTool.execute({ goal: "réclamation urgente", menuTree: tree }, CONTEXT);
    expect(result.matchedGoal).toBe(true);
    expect(result.confidence).toBe(1);
    expect(result.dtmfSequence).toBe("2");
    // Aucun repli LLM nécessaire.
    expect(mockedGenerate).not.toHaveBeenCalled();
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* (b) Transcription → arbre LLM                                       */
/* ──────────────────────────────────────────────────────────────────── */

describe("ivr.navigate — transcription analysée par le LLM", () => {
  it("(b) reconstruit l'arbre (tâche agent, 2500 tokens) puis marche l'arbre obtenu", async () => {
    respondToLlm({ transcript: { root: SUPPORT_TREE } });
    const result = await ivrNavigateTool.execute(
      {
        goal: "parler à un conseiller",
        menuTranscript:
          "Bienvenue au service client. Pour un conseiller tapez 1. Pour la facturation tapez 2. Pour les réclamations tapez 3.",
      },
      CONTEXT,
    );
    expect(result.matchedGoal).toBe(true);
    expect(result.dtmfSequence).toBe("1");
    expect(result.path[0]?.action).toBe("human");

    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    const call = mockedGenerate.mock.calls[0]?.[0] as LlmCall;
    expect(call.request.task).toBe("agent");
    expect(call.request.maxTokens).toBe(2_500);
    expect(call.request.system).toContain("analyseur de serveurs vocaux");
    expect(call.request.messages[0]?.content).toContain("Bienvenue au service client");
    expect(call.userId).toBe("user-1");
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* (c) Repli LLM + revalidation du chemin                              */
/* ──────────────────────────────────────────────────────────────────── */

describe("ivr.navigate — repli LLM et revalidation des touches", () => {
  it("(c) aucune correspondance déterministe → repli LLM validé, confiance 0,3 honnête", async () => {
    respondToLlm({ fallback: { keys: ["1"] } });
    const result = await ivrNavigateTool.execute(
      { goal: "résilier mon abonnement", menuTree: SIMPLE_TREE },
      CONTEXT,
    );
    expect(result.matchedGoal).toBe(false);
    expect(result.confidence).toBe(0.3);
    expect(result.dtmfSequence).toBe("1");
    expect(result.path).toEqual([
      { step: 1, key: "1", label: "Commander une pizza", action: "info" },
    ]);

    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    const call = mockedGenerate.mock.calls[0]?.[0] as LlmCall;
    expect(call.request.task).toBe("automation");
    expect(call.request.maxTokens).toBe(600);
    expect(call.request.messages[0]?.content).toContain("résilier mon abonnement");
    expect(call.request.messages[0]?.content).toContain("\"key\"");
  });

  it("(c) touches du repli INVALIDES (absentes du niveau) → chemin tronqué + avertissement, confiance réduite", async () => {
    respondToLlm({ fallback: { keys: ["1", "7"] } });
    const result = await ivrNavigateTool.execute(
      { goal: "résilier mon abonnement", menuTree: SIMPLE_TREE },
      CONTEXT,
    );
    expect(result.matchedGoal).toBe(false);
    expect(result.confidence).toBe(0.15);
    expect(result.path.map((step) => step.key)).toEqual(["1"]);
    expect(result.warnings.some((warning) => warning.includes("« 7 »"))).toBe(true);
  });

  it("(c-bis) touches du repli au-delà d'une feuille → avertissement dédié", async () => {
    respondToLlm({ fallback: { keys: ["1", "2"] } });
    const result = await ivrNavigateTool.execute(
      { goal: "résilier mon abonnement", menuTree: SIMPLE_TREE },
      CONTEXT,
    );
    expect(result.path.map((step) => step.key)).toEqual(["1"]);
    expect(result.warnings.some((warning) => warning.includes("n'ouvre aucun sous-menu"))).toBe(true);
  });

  it("échec du repli LLM → meilleur chemin déterministe retourné avec avertissement", async () => {
    generateMock.mockImplementation(async () => {
      throw new Error("Le modèle n'a pas produit une réponse conforme au format attendu après 2 tentative(s).");
    });
    const result = await ivrNavigateTool.execute(
      { goal: "résilier mon abonnement", menuTree: SIMPLE_TREE },
      CONTEXT,
    );
    expect(result.matchedGoal).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.dtmfSequence).toBe("1");
    expect(result.warnings.some((warning) => warning.includes("Le repli IA n'a pas abouti"))).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* (d) Garde de profondeur                                             */
/* ──────────────────────────────────────────────────────────────────── */

describe("ivr.navigate — garde de profondeur", () => {
  it("(d) refuse un arbre de plus de 6 niveaux avec l'erreur française", async () => {
    await expect(
      ivrNavigateTool.execute({ goal: "parler à un conseiller", menuTree: deepTree(7) }, CONTEXT),
    ).rejects.toThrow(/trop profond/);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("accepte un arbre d'exactement 6 niveaux (racine = 0)", async () => {
    respondToLlm({ fallback: { keys: ["1"] } });
    const result = await ivrNavigateTool.execute(
      { goal: "résilier mon abonnement", menuTree: deepTree(6) },
      CONTEXT,
    );
    expect(result.dtmfSequence).toBe("1");
  });
});
