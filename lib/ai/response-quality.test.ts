import { afterEach, describe, expect, it } from "vitest";

import {
  RESPONSE_FORMAT_RULES,
  RESPONSE_QUALITY_SYSTEM,
  preferFreeForUnderstanding,
  preferFreeForVisibleAnswers,
  responseQualityMode,
  withResponseStyle,
} from "./response-quality";

const ENV_KEY = "GEN3IA_RESPONSE_QUALITY";

function restore(value: string | undefined): void {
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
}

describe("responseQualityMode", () => {
  const saved = process.env[ENV_KEY];

  afterEach(() => restore(saved));

  it("défaut = premium quand la variable est absente", () => {
    delete process.env[ENV_KEY];
    expect(responseQualityMode()).toBe("premium");
    expect(preferFreeForVisibleAnswers()).toBe(false);
  });

  it("mode free explicite", () => {
    process.env[ENV_KEY] = "free";
    expect(responseQualityMode()).toBe("free");
    expect(preferFreeForVisibleAnswers()).toBe(true);
  });

  it("mode premium explicite", () => {
    process.env[ENV_KEY] = "premium";
    expect(responseQualityMode()).toBe("premium");
    expect(preferFreeForVisibleAnswers()).toBe(false);
  });

  it("valeur invalide → repli sûr premium (jamais free par accident)", () => {
    for (const invalid of ["ultra", "PREMIUM ", "", "1", "true"]) {
      process.env[ENV_KEY] = invalid;
      expect(responseQualityMode()).toBe("premium");
      expect(preferFreeForVisibleAnswers()).toBe(false);
    }
  });

  it("FREE en majuscules/espaces est normalisé", () => {
    process.env[ENV_KEY] = "  FREE ";
    expect(responseQualityMode()).toBe("free");
  });
});

describe("preferFreeForUnderstanding (tâches de compréhension : classification, planification, intention)", () => {
  const saved = process.env[ENV_KEY];

  afterEach(() => restore(saved));

  it("premium (défaut) : PAS de préférence gratuite — le meilleur fournisseur sert la compréhension", () => {
    delete process.env[ENV_KEY];
    expect(preferFreeForUnderstanding()).toBe(false);
  });

  it("mode free explicite : comportement gratuit historique conservé", () => {
    process.env[ENV_KEY] = "free";
    expect(preferFreeForUnderstanding()).toBe(true);
  });

  it("valeur invalide → repli sûr premium (jamais free par accident)", () => {
    process.env[ENV_KEY] = "ultra";
    expect(preferFreeForUnderstanding()).toBe(false);
  });
});

describe("RESPONSE_FORMAT_RULES (contrat de présentation)", () => {
  it("couvre les exigences qualité : langue, réponse directe, structure, précision, honnêteté, clarification", () => {
    const rules = RESPONSE_FORMAT_RULES;
    expect(rules).toContain("LANGUE");
    expect(rules).toContain("DIRECTEMENT");
    expect(rules).toContain("markdown");
    expect(rules).toContain("PRÉCIS");
    expect(rules).toContain("n'invente JAMAIS");
    expect(rules).toContain("question de clarification");
  });

  it("n'exige que du markdown RÉELLEMENT rendu par le renderer Gen3ia", () => {
    // Titres ##, gras **, listes, tableaux : tout est supporté par
    // components/workspace/markdown.tsx (Task 52). Aucune exigence de
    // syntaxe décorative non rendue (notes de bas de page, HTML…).
    expect(RESPONSE_FORMAT_RULES).toContain("tableau markdown");
    expect(RESPONSE_FORMAT_RULES).not.toContain("<table");
    expect(RESPONSE_FORMAT_RULES).not.toContain("footnote");
    expect(RESPONSE_FORMAT_RULES).not.toContain("HTML");
  });

  it("est en français et structuré par lignes", () => {
    expect(RESPONSE_FORMAT_RULES).toContain("FORMAT DE RÉPONSE");
    const lines = RESPONSE_FORMAT_RULES.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(8);
    for (const line of lines.slice(1)) expect(line.startsWith("- ")).toBe(true);
  });
});

describe("withResponseStyle", () => {
  it("complète un system prompt existant SANS l'écraser (règles ajoutées après)", () => {
    const composed = withResponseStyle("Tu es CodeMaster, agent développeur.");
    expect(composed.startsWith("Tu es CodeMaster, agent développeur.")).toBe(true);
    expect(composed).toContain(RESPONSE_FORMAT_RULES);
    expect(composed).not.toBe(RESPONSE_FORMAT_RULES);
  });

  it("retourne le system de qualité COMPLET quand aucun system n'existe", () => {
    const composed = withResponseStyle();
    expect(composed).toBe(RESPONSE_QUALITY_SYSTEM);
    expect(composed).toContain("assistant IA de Gen3ia");
    expect(composed).toContain(RESPONSE_FORMAT_RULES);
  });

  it("traite une chaîne blanche comme absente", () => {
    expect(withResponseStyle("   \n  ")).toBe(RESPONSE_QUALITY_SYSTEM);
  });

  it("préserve l'intégralité du system métier (aucune troncature)", () => {
    const long = "X".repeat(12_000);
    const composed = withResponseStyle(long);
    expect(composed.startsWith(long)).toBe(true);
    expect(composed.endsWith(RESPONSE_FORMAT_RULES)).toBe(true);
  });
});
