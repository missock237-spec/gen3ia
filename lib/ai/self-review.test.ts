import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./router", () => ({
  generate: vi.fn(),
}));

import { generate } from "./router";
import {
  reviewVisibleAnswer,
  SELF_REVIEW_MAX_LENGTH,
  SELF_REVIEW_MIN_LENGTH,
  selfReviewEnabled,
  shouldSelfReview,
} from "./self-review";

const mockedGenerate = vi.mocked(generate);

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  mockedGenerate.mockReset();
  delete process.env.GEN3IA_SELF_REVIEW;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function longAnswer(length = 900): string {
  // Se termine TOUJOURS par un caractère non-blanc : les gardes de périmètre
  // et le filtre anti-balises tronquent les espaces de fin — le contenu du
  // test doit survivre à ces trims.
  return "Réponse substantielle. ".repeat(Math.ceil(length / 23) + 1).slice(0, Math.max(length - 1, 1)) + ".";
}

describe("selfReviewEnabled — interrupteur sans redéploiement", () => {
  it("activé par défaut (toute valeur autre que les désactivations)", () => {
    expect(selfReviewEnabled()).toBe(true);
    process.env.GEN3IA_SELF_REVIEW = "on";
    expect(selfReviewEnabled()).toBe(true);
  });

  it("désactivé par off / disabled / false / 0", () => {
    for (const value of ["off", "disabled", "false", "0", " OFF "]) {
      process.env.GEN3IA_SELF_REVIEW = value;
      expect(selfReviewEnabled()).toBe(false);
    }
  });
});

describe("shouldSelfReview — périmètre de la révision", () => {
  it("une réponse courte n'est pas révisée (latence prioritaire sur le chat)", () => {
    expect(shouldSelfReview("ok")).toBe(false);
    expect(shouldSelfReview("Réponse professionnelle.")).toBe(false);
  });

  it("une réponse substantielle est révisée", () => {
    expect(shouldSelfReview(longAnswer(SELF_REVIEW_MIN_LENGTH))).toBe(true);
  });

  it("une réponse démesurée n'est pas révisée (coût du juge)", () => {
    expect(shouldSelfReview(longAnswer(SELF_REVIEW_MAX_LENGTH + 1))).toBe(false);
  });
});

describe("reviewVisibleAnswer — passe de self-reflection", () => {
  it("réponse trop courte : livrée telle quelle, AUCUN appel LLM", async () => {
    const result = await reviewVisibleAnswer({ question: "Bonjour ?", answer: "Bonjour ! Comment puis-je aider ?" });
    expect(result.verdict).toBe("conforme");
    expect(result.text).toBe("Bonjour ! Comment puis-je aider ?");
    expect(result.skipped).toBe("too_short");
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("désactivée via l'environnement : AUCUN appel LLM", async () => {
    process.env.GEN3IA_SELF_REVIEW = "off";
    const answer = longAnswer();
    const result = await reviewVisibleAnswer({ question: "Explique le R2.", answer });
    expect(result.text).toBe(answer);
    expect(result.skipped).toBe("disabled");
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("verdict CONFORME : la proposition est livrée telle quelle", async () => {
    const answer = longAnswer();
    mockedGenerate.mockResolvedValueOnce({
      text: JSON.stringify({ verdict: "conforme", issues: [], text: answer }),
    } as Awaited<ReturnType<typeof generate>>);
    const result = await reviewVisibleAnswer({ question: "Explique le R2.", answer });
    expect(result.verdict).toBe("conforme");
    expect(result.text).toBe(answer);
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
  });

  it("verdict AMÉLIORÉ avec texte valide : la version corrigée remplace la proposition", async () => {
    const answer = longAnswer();
    const improved = `${longAnswer(1000)}\n\n## Structure ajoutée`;
    mockedGenerate.mockResolvedValueOnce({
      text: JSON.stringify({ verdict: "ameliore", issues: ["réponse incomplète"], text: improved }),
    } as Awaited<ReturnType<typeof generate>>);
    const result = await reviewVisibleAnswer({ question: "Explique le R2.", answer });
    expect(result.verdict).toBe("ameliore");
    expect(result.text).toBe(improved);
    expect(result.issues).toEqual(["réponse incomplète"]);
  });

  it("garde ANTI-DÉGRADATION : une version corrompue (vide/tronquée) ne remplace jamais la proposition", async () => {
    const answer = longAnswer();
    mockedGenerate.mockResolvedValueOnce({
      text: JSON.stringify({ verdict: "ameliore", issues: ["x"], text: "42" }),
    } as Awaited<ReturnType<typeof generate>>);
    const result = await reviewVisibleAnswer({ question: "Explique le R2.", answer });
    expect(result.text).toBe(answer);
    expect(result.verdict).toBe("conforme");
  });

  it("JSON dans un bloc de code fenced : parsé normalement", async () => {
    const answer = longAnswer();
    const improved = longAnswer(1100);
    mockedGenerate.mockResolvedValueOnce({
      text: "```json\n" + JSON.stringify({ verdict: "ameliore", issues: [], text: improved }) + "\n```",
    } as Awaited<ReturnType<typeof generate>>);
    const result = await reviewVisibleAnswer({ question: "Explique le R2.", answer });
    expect(result.verdict).toBe("ameliore");
    expect(result.text).toBe(improved);
  });

  it("réviseur illisible (JSON invalide) : la proposition d'origine est livrée", async () => {
    const answer = longAnswer();
    mockedGenerate.mockResolvedValueOnce({ text: "je ne peux pas répondre en JSON" } as Awaited<ReturnType<typeof generate>>);
    const result = await reviewVisibleAnswer({ question: "Explique le R2.", answer });
    expect(result.text).toBe(answer);
    expect(result.skipped).toBe("error");
  });

  it("FAIL-SOFT : une panne du réviseur ne casse JAMAIS la réponse existante", async () => {
    const answer = longAnswer();
    mockedGenerate.mockRejectedValueOnce(new Error("Fournisseur indisponible"));
    const result = await reviewVisibleAnswer({ question: "Explique le R2.", answer });
    expect(result.text).toBe(answer);
    expect(result.skipped).toBe("error");
  });

  it("les balises de raisonnement internes sont retirées de la version améliorée", async () => {
    const answer = longAnswer();
    const improved = longAnswer(1100);
    const withThink = `<thinking>je réfléchis longuement</thinking>\n${improved}`;
    mockedGenerate.mockResolvedValueOnce({
      text: JSON.stringify({ verdict: "ameliore", issues: [], text: withThink }),
    } as Awaited<ReturnType<typeof generate>>);
    const result = await reviewVisibleAnswer({ question: "Explique le R2.", answer });
    expect(result.text).toBe(improved);
  });

  it("transmet la question et le contexte au réviseur (demande visible par le juge)", async () => {
    const answer = longAnswer();
    mockedGenerate.mockResolvedValueOnce({
      text: JSON.stringify({ verdict: "conforme", issues: [], text: answer }),
    } as Awaited<ReturnType<typeof generate>>);
    await reviewVisibleAnswer({ question: "Explique le R2.", answer, contextNote: "[Fichier: notes.pdf]" });
    const call = mockedGenerate.mock.calls[0][0];
    const payload = JSON.parse(call.messages[1].content);
    expect(payload.demande).toBe("Explique le R2.");
    expect(payload.contexte).toBe("[Fichier: notes.pdf]");
    expect(payload.proposition).toBe(answer);
    // Le réviseur est un rôle DÉDIÉ (pas le même prompt que la réponse).
    expect(call.messages[0].content).toContain("réviseur qualité");
  });
});
