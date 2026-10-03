import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Contrat de résultat (concepts post-SaaS #1 « Goal-as-a-Service » et #2
 * « Outcome-as-a-Service ») : schéma, preuve (sorties réelles des étapes
 * livrables), critères déterministes locaux (contient / interdit / regex /
 * longueur / format), juge sémantique unique facturé, et honnêteté de
 * panne (`unavailable` — jamais de faux « critères atteints »).
 */

const generateForUserMock = vi.fn();

vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: (...args: unknown[]) => generateForUserMock(...args),
}));

import {
  collectOutcomeEvidence,
  OutcomeContractSchema,
  parseOutcomeContractInput,
  verifyOutcomeCriteria,
  type OutcomeContract,
} from "./outcome-contract";
import type { RuntimeExecutionState } from "./runtime/types";

function baseState(overrides: Partial<RuntimeExecutionState> = {}): RuntimeExecutionState {
  return {
    executionId: "exec-1",
    userId: "u1",
    objective: "Rédiger une note de synthèse sur le marché des agents autonomes",
    status: "completed",
    plan: {
      executionId: "exec-1",
      objective: "Rédiger une note de synthèse",
      steps: [
        {
          id: "s1", type: "llm", name: "Recherche", description: "Recherche marché",
          dependencies: [], status: "completed", input: {}, skillIds: [],
          maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false,
        },
        {
          id: "s2", type: "document", name: "Livrable", description: "Note finale",
          dependencies: ["s1"], status: "completed", input: { format: "pdf" }, skillIds: [],
          maxRetries: 2, timeoutMs: 120_000, sideEffect: false, requiresApproval: false,
        },
      ],
      maxConcurrency: 2,
      maxIterations: 10,
    },
    observations: [],
    evaluations: [],
    outputs: {
      s1: "Le marché des agents autonomes croît de 40 % par an.",
      s2: "NOTE DE SYNTHÈSE — marché des agents autonomes : croissance 40 %/an, acteurs principaux identifiés.",
    },
    iteration: 2,
    totalRetries: 0,
    maxTotalRetries: 15,
    billing: { currency: "XAF", totalChargeMinor: 0, totalProviderCostEur: 0, llmInputTokens: 0, llmOutputTokens: 0 },
    ...overrides,
  };
}

const JUDGE_USAGE = {
  chargeMinor: 3,
  providerCostEur: 0.001,
  response: { text: "", usage: { inputTokens: 120, outputTokens: 40 } },
};

beforeEach(() => {
  generateForUserMock.mockReset();
});

describe("schéma du contrat de résultat", () => {
  it("accepte un contrat valide (critères déterministes + sémantique)", () => {
    const parsed = OutcomeContractSchema.safeParse({
      criteria: [
        { id: "c1", description: "Le livrable cite la croissance", kind: "contains", pattern: "40 %" },
        { id: "c2", description: "Analyse structurée et sans invention", kind: "llm" },
      ],
      failPolicy: "retry_once",
    });
    expect(parsed.success).toBe(true);
  });

  it("exige un motif pour contains / not_contains / regex", () => {
    expect(OutcomeContractSchema.safeParse({ criteria: [{ id: "c1", description: "abc", kind: "contains" }] }).success).toBe(false);
    expect(OutcomeContractSchema.safeParse({ criteria: [{ id: "c1", description: "abc", kind: "not_contains" }] }).success).toBe(false);
    expect(OutcomeContractSchema.safeParse({ criteria: [{ id: "c1", description: "abc", kind: "regex" }] }).success).toBe(false);
  });

  it("exige minLength et format pour leurs types", () => {
    expect(OutcomeContractSchema.safeParse({ criteria: [{ id: "c1", description: "abc", kind: "min_length" }] }).success).toBe(false);
    expect(OutcomeContractSchema.safeParse({ criteria: [{ id: "c1", description: "abc", kind: "artifact_format" }] }).success).toBe(false);
  });

  it("refuse un identifiant de critère non alphanumérique (anti-injection d'affichage)", () => {
    expect(OutcomeContractSchema.safeParse({ criteria: [{ id: "c; drop", description: "abc", kind: "llm" }] }).success).toBe(false);
  });

  it("parseOutcomeContractInput renvoie une erreur lisible (jamais d'exception)", () => {
    const { contract, error } = parseOutcomeContractInput({ criteria: [] });
    expect(contract).toBeUndefined();
    expect(error).toBeTruthy();
    const ok = parseOutcomeContractInput({ criteria: [{ id: "c1", description: "abc def", kind: "llm" }] });
    expect(ok.contract?.criteria).toHaveLength(1);
  });
});

describe("preuve du contrat (collectOutcomeEvidence)", () => {
  it("concatène les sorties des étapes livrables complétées", () => {
    const evidence = collectOutcomeEvidence(baseState());
    expect(evidence).toContain("NOTE DE SYNTHÈSE");
    expect(evidence).toContain("croît de 40 %");
  });

  it("ignore les sorties d'étapes non complétées", () => {
    const state = baseState();
    state.plan.steps[1].status = "failed";
    const evidence = collectOutcomeEvidence(state);
    expect(evidence).not.toContain("NOTE DE SYNTHÈSE");
    expect(evidence).toContain("croît de 40 %");
  });

  it("replie sur toutes les sorties textuelles quand AUCUNE étape livrable n'a produit de sortie", () => {
    const state = baseState();
    state.plan.steps[0].type = "tool";
    state.plan.steps[1].type = "tool";
    state.plan.steps[1].input = {};
    const evidence = collectOutcomeEvidence(state);
    expect(evidence).toContain("NOTE DE SYNTHÈSE");
    expect(evidence).toContain("croît de 40 %");
  });
});

describe("critères déterministes (zéro appel LLM)", () => {
  const contract: OutcomeContract = {
    criteria: [
      { id: "present", description: "cite la croissance", kind: "contains", pattern: "40 %", required: true },
      { id: "forbidden", description: "ne promet pas de garantie absolue", kind: "not_contains", pattern: "garantie à 100 %", required: true },
      { id: "shape", description: "mentionne la croissance annuelle", kind: "regex", pattern: "croissance 40 %/an", required: true },
      { id: "length", description: "livrable substantiel", kind: "min_length", minLength: 50, required: true },
      { id: "format", description: "livrable pdf", kind: "artifact_format", format: "pdf", required: true },
    ],
    failPolicy: "fail",
  };

  it("contrat satisfait → passed sans aucun appel facturé", async () => {
    const { verification, usage } = await verifyOutcomeCriteria(contract, baseState(), { userId: "u1", executionId: "exec-1" });
    expect(verification.passed).toBe(true);
    expect(verification.unavailable).toBeUndefined();
    expect(verification.results).toHaveLength(5);
    expect(usage.chargeMinor).toBe(0);
    expect(generateForUserMock).not.toHaveBeenCalled();
  });

  it("critère contains manquant → refus avec motif factuel", async () => {
    const state = baseState({ outputs: { s1: "texte", s2: "NOTE DE SYNTHÈSE sans chiffre" } });
    const { verification } = await verifyOutcomeCriteria(contract, state, { userId: "u1", executionId: "exec-1" });
    expect(verification.passed).toBe(false);
    expect(verification.summary).toContain("present");
  });

  it("motif interdit encore présent → refus", async () => {
    const state = baseState({ outputs: { s1: "x", s2: "garantie à 100 % de réussite" } });
    const { verification } = await verifyOutcomeCriteria(contract, state, { userId: "u1", executionId: "exec-1" });
    expect(verification.passed).toBe(false);
    const forbidden = verification.results.find((result) => result.criterionId === "forbidden");
    expect(forbidden?.passed).toBe(false);
  });

  it("regex invalide → critère refusé (jamais d'exception propagée)", async () => {
    const broken: OutcomeContract = { criteria: [{ id: "bad", description: "regex cassée", kind: "regex", pattern: "([unclosed", required: true }], failPolicy: "fail" };
    const { verification } = await verifyOutcomeCriteria(broken, baseState(), { userId: "u1", executionId: "exec-1" });
    expect(verification.passed).toBe(false);
    expect(verification.results[0].detail).toContain("invalide");
  });

  it("format de livrable non déclaré → refus ; conforme → accepté", async () => {
    const pdfOnly: OutcomeContract = { criteria: [{ id: "fmt", description: "pdf attendu", kind: "artifact_format", format: "docx", required: true }], failPolicy: "fail" };
    const { verification } = await verifyOutcomeCriteria(pdfOnly, baseState(), { userId: "u1", executionId: "exec-1" });
    expect(verification.passed).toBe(false);
    const ok: OutcomeContract = { criteria: [{ id: "fmt", description: "pdf attendu", kind: "artifact_format", format: "PDF", required: true }], failPolicy: "fail" };
    const verdict = await verifyOutcomeCriteria(ok, baseState(), { userId: "u1", executionId: "exec-1" });
    expect(verdict.verification.passed).toBe(true);
  });

  it("critère non requis en échec : verdict enregistré, contrat non bloquant", async () => {
    const advisory: OutcomeContract = {
      criteria: [
        { id: "hard", description: "critère manquant", kind: "contains", pattern: "inexistant", required: true },
        { id: "advisory", description: "souhait", kind: "contains", pattern: "inexistant aussi", required: false },
      ],
      failPolicy: "fail",
    };
    const { verification } = await verifyOutcomeCriteria(advisory, baseState({ outputs: { s1: "x", s2: "y" } }), { userId: "u1", executionId: "exec-1" });
    expect(verification.results.find((result) => result.criterionId === "advisory")?.passed).toBe(false);
    expect(verification.passed).toBe(false); // « hard » requis bloque
    const onlyAdvisory: OutcomeContract = { ...advisory, criteria: [advisory.criteria[1]] };
    const verdict = await verifyOutcomeCriteria(onlyAdvisory, baseState({ outputs: { s1: "x", s2: "y" } }), { userId: "u1", executionId: "exec-1" });
    expect(verdict.verification.passed).toBe(true);
    expect(verdict.verification.results[0].passed).toBe(false);
  });
});

describe("critères sémantiques (juge LLM unique facturé)", () => {
  it("verdicts du juge mappés sur les critères", async () => {
    generateForUserMock.mockResolvedValue({
      ...JUDGE_USAGE,
      response: {
        ...JUDGE_USAGE.response,
        text: JSON.stringify({ criteria: [{ id: "quality", passed: true, detail: "Analyse complète et factuelle." }] }),
      },
    });
    const contract: OutcomeContract = { criteria: [{ id: "quality", description: "analyse de qualité professionnelle", kind: "llm" }], failPolicy: "fail" };
    const { verification, usage } = await verifyOutcomeCriteria(contract, baseState(), { userId: "u1", executionId: "exec-1" });
    expect(verification.passed).toBe(true);
    expect(verification.results[0].detail).toContain("factuelle");
    expect(usage.chargeMinor).toBe(3);
    expect(generateForUserMock).toHaveBeenCalledTimes(1);
    // Le juge reçoit les SORTIES RÉELLES, jamais les promesses du plan.
    const payload = JSON.parse(generateForUserMock.mock.calls[0][0].request.messages[1].content);
    expect(payload.evidence).toContain("NOTE DE SYNTHÈSE");
    expect(payload.criteria[0].id).toBe("quality");
  });

  it("critère sans verdict du juge → traité comme non satisfait (jamais l'inverse)", async () => {
    generateForUserMock.mockResolvedValue({
      ...JUDGE_USAGE,
      response: { ...JUDGE_USAGE.response, text: JSON.stringify({ criteria: [] }) },
    });
    const contract: OutcomeContract = { criteria: [{ id: "quality", description: "analyse", kind: "llm" }], failPolicy: "fail" };
    const { verification } = await verifyOutcomeCriteria(contract, baseState(), { userId: "u1", executionId: "exec-1" });
    expect(verification.passed).toBe(false);
  });

  it("panne du juge → unavailable (honnêteté : porte levée, jamais de faux atteint)", async () => {
    generateForUserMock.mockRejectedValue(new Error("provider indisponible"));
    const contract: OutcomeContract = { criteria: [{ id: "quality", description: "analyse", kind: "llm" }], failPolicy: "fail" };
    const { verification, usage } = await verifyOutcomeCriteria(contract, baseState(), { userId: "u1", executionId: "exec-1" });
    expect(verification.passed).toBe(false);
    expect(verification.unavailable).toBe(true);
    expect(verification.summary).toContain("provider indisponible");
    expect(usage.chargeMinor).toBe(0);
  });

  it("livrable vide → critères sémantiques refusés SANS appel de juge (économie réelle)", async () => {
    const contract: OutcomeContract = { criteria: [{ id: "quality", description: "analyse", kind: "llm" }], failPolicy: "fail" };
    const state = baseState({ outputs: {} });
    const { verification } = await verifyOutcomeCriteria(contract, state, { userId: "u1", executionId: "exec-1" });
    expect(verification.passed).toBe(false);
    expect(verification.results[0].detail).toContain("vide");
    expect(generateForUserMock).not.toHaveBeenCalled();
  });
});
