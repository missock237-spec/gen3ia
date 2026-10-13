import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/router", () => ({
  generate: vi.fn(),
}));

import { generate } from "@/lib/ai/router";
import {
  buildRecoveryDirective,
  classifyExecutionError,
  MAX_RECOVERY_NOTES_PER_STEP,
  repairGeneratedCode,
  repairToolInput,
} from "./error-recovery";

const mockedGenerate = vi.mocked(generate);

beforeEach(() => {
  mockedGenerate.mockReset();
});

describe("classifyExecutionError — classification des erreurs d'étape", () => {
  it("BUDGET épuisé : non retentable (le plafond ne remonte pas au réessai)", () => {
    const result = classifyExecutionError("Budget de l'agent atteint pour cette exécution (plafond 5.00 EUR). Augmentez le budget.");
    expect(result.kind).toBe("budget");
    expect(result.retryable).toBe(false);
  });

  it("WALLET / solde insuffisant : non retentable", () => {
    expect(classifyExecutionError("Insufficient wallet balance.").kind).toBe("budget");
    expect(classifyExecutionError("Solde insuffisant pour exécuter").retryable).toBe(false);
  });

  it("AUTH (401/403/permission refusée) : non retentable", () => {
    expect(classifyExecutionError("401 Unauthorized: invalid API key").kind).toBe("auth");
    expect(classifyExecutionError("Permission denied for tool file.delete").retryable).toBe(false);
    expect(classifyExecutionError("403 Forbidden").kind).toBe("auth");
  });

  it("ENTRÉE INVALIDE (schéma zod) : retentable — après correction de l'entrée", () => {
    const result = classifyExecutionError("expected string, received undefined at input.query");
    expect(result.kind).toBe("invalid_input");
    expect(result.retryable).toBe(true);
    expect(result.strategy).toMatch(/CORRIGE/i);
  });

  it("ÉCHEC DE COMPILATION de code : retentable — après réparation du code", () => {
    const result = classifyExecutionError("SyntaxError: unexpected token 'in' at line 3");
    expect(result.kind).toBe("compilation");
    expect(result.retryable).toBe(true);
    expect(result.strategy).toMatch(/corrige le code/i);
  });

  it("RuntimeError / exit code : échec d'exécution de code", () => {
    expect(classifyExecutionError("RuntimeError: division by zero").kind).toBe("compilation");
    expect(classifyExecutionError("Script failed with exit code 1").kind).toBe("compilation");
    expect(classifyExecutionError("Traceback (most recent call last): ...").kind).toBe("compilation");
  });

  it("TRANSITOIRE (réseau / 429 / 503) : retentable", () => {
    expect(classifyExecutionError("429 Too Many Requests").kind).toBe("transient");
    expect(classifyExecutionError("fetch failed").kind).toBe("transient");
    expect(classifyExecutionError("ECONNRESET").kind).toBe("transient");
    expect(classifyExecutionError("Service temporarily unavailable").retryable).toBe(true);
  });

  it("TIMEOUT du runtime : classé timeout (le runner le traite avant comme non-retentable)", () => {
    expect(classifyExecutionError("Step timeout after 30000ms").kind).toBe("timeout");
  });

  it("PRIORITÉ DES PATTERNS : un budget contenant « 429 » reste BUDGET (ordre spécifique → générique)", () => {
    const result = classifyExecutionError("429 rate limit atteint, budget de l'agent épuisé");
    expect(result.kind).toBe("budget");
    expect(result.retryable).toBe(false);
  });

  it("ERREUR INCONNUE : retentable (comportement historique conservé, jamais de régression)", () => {
    const result = classifyExecutionError("quelque chose d'étrange s'est produit");
    expect(result.kind).toBe("unknown");
    expect(result.retryable).toBe(true);
  });

  it("message vide : retentable (conservateur)", () => {
    expect(classifyExecutionError("").retryable).toBe(true);
  });
});

describe("buildRecoveryDirective — journal de reprise", () => {
  it("aucune erreur : directive vide (aucune section fantôme)", () => {
    expect(buildRecoveryDirective([])).toBe("");
  });

  it("rend le journal RÉEL des erreurs avec la consigne d'ajustement", () => {
    const directive = buildRecoveryDirective(["SyntaxError at line 3", "TypeError: x is not a function"]);
    expect(directive).toContain("TENTATIVE(S) PRÉCÉDENTE(S)");
    expect(directive).toContain("Essai 1 — erreur : SyntaxError at line 3");
    expect(directive).toContain("Essai 2 — erreur : TypeError: x is not a function");
    expect(directive).toMatch(/AJUSTE/i);
    expect(directive).toContain("CORRIGER la cause");
  });

  it("borne le journal aux MAX_RECOVERY_NOTES_PER_STEP dernières erreurs", () => {
    const errors = ["erreur-1", "erreur-2", "erreur-3", "erreur-4", "erreur-5"];
    const directive = buildRecoveryDirective(errors);
    expect(directive).not.toContain("erreur-1");
    expect(directive).not.toContain("erreur-2");
    expect(directive).toContain("erreur-5");
    expect(MAX_RECOVERY_NOTES_PER_STEP).toBe(3);
  });

  it("les erreurs vides sont ignorées", () => {
    expect(buildRecoveryDirective(["", "   "])).toBe("");
  });
});

describe("repairGeneratedCode — réparation d'un échec de compilation", () => {
  it("renvoie le code CORRIGÉ extrait du bloc de code", async () => {
    mockedGenerate.mockResolvedValueOnce({
      text: "Voici la correction :\n```python\nprint('corrigé')\n```\n",
    } as Awaited<ReturnType<typeof generate>>);
    const repaired = await repairGeneratedCode({
      code: "print('faux')",
      error: "SyntaxError at line 1",
      objective: "Afficher un message",
    });
    expect(repaired).toBe("print('corrigé')");
    // Le réparateur reçoit l'objectif, le journal d'erreur ET le code fautif.
    const call = mockedGenerate.mock.calls[0][0];
    expect(call.messages[1].content).toContain("Afficher un message");
    expect(call.messages[1].content).toContain("SyntaxError at line 1");
    expect(call.messages[1].content).toContain("print('faux')");
  });

  it("FAIL-SOFT : une panne du réparateur conserve le code d'origine", async () => {
    mockedGenerate.mockRejectedValueOnce(new Error("Fournisseur indisponible"));
    const repaired = await repairGeneratedCode({ code: "print('faux')", error: "SyntaxError" });
    expect(repaired).toBe("print('faux')");
  });

  it("garde : une « réparation » vide ou squelettique ne remplace pas le code", async () => {
    mockedGenerate.mockResolvedValueOnce({ text: "ok" } as Awaited<ReturnType<typeof generate>>);
    const repaired = await repairGeneratedCode({ code: "print('faux')", error: "SyntaxError" });
    expect(repaired).toBe("print('faux')");
  });
});

describe("repairToolInput — réparation d'une entrée d'outil invalide", () => {
  it("renvoie l'entrée corrigée (JSON)", async () => {
    mockedGenerate.mockResolvedValueOnce({
      text: '```json\n{"query": "prix des vélos"}\n```',
    } as Awaited<ReturnType<typeof generate>>);
    const repaired = await repairToolInput({
      toolName: "web.search",
      input: { query: 42 },
      error: "expected string, received number at input.query",
    });
    expect(repaired).toEqual({ query: "prix des vélos" });
    // Le réparateur reçoit le contrat de l'outil (description du registre).
    const call = mockedGenerate.mock.calls[0][0];
    expect(call.messages[1].content).toContain("web.search");
    expect(call.messages[1].content).toContain("expected string, received number");
  });

  it("FAIL-SOFT : JSON illisible → entrée d'origine conservée", async () => {
    mockedGenerate.mockResolvedValueOnce({ text: "pas de json ici" } as Awaited<ReturnType<typeof generate>>);
    const original = { query: 42 };
    const repaired = await repairToolInput({ toolName: "web.search", input: original, error: "expected string" });
    expect(repaired).toBe(original);
  });

  it("FAIL-SOFT : panne du réparateur → entrée d'origine conservée", async () => {
    mockedGenerate.mockRejectedValueOnce(new Error("Erreur réseau"));
    const original = { q: "recherche" };
    const repaired = await repairToolInput({ toolName: "web.search", input: original, error: "schema" });
    expect(repaired).toBe(original);
  });

  it("un tableau JSON n'est PAS une entrée valide d'outil → origine conservée", async () => {
    mockedGenerate.mockResolvedValueOnce({ text: '["query", "recherche"]' } as Awaited<ReturnType<typeof generate>>);
    const original = { query: 42 };
    const repaired = await repairToolInput({ toolName: "web.search", input: original, error: "expected string" });
    expect(repaired).toBe(original);
  });
});
