import { describe, expect, it } from "vitest";

import {
  buildFewShotSection,
  FEW_SHOT_FAMILIES,
  FEW_SHOT_MAX_EXAMPLES,
  normalizeForMatch,
  renderFewShotSection,
  selectFewShotExamples,
} from "./few-shot";

describe("normalizeForMatch — accents et casse", () => {
  it("neutralise accents, casse et espaces multiples", () => {
    expect(normalizeForMatch("  ÉCOLE À  Paris  ")).toBe("ecole a paris");
    expect(normalizeForMatch("ÉTAPES")).toBe("etapes");
  });
});

describe("selectFewShotExamples — sélection déterministe", () => {
  it("sélectionne la famille CODE pour une question de débogage", () => {
    const selected = selectFewShotExamples("Mon code TypeScript a une erreur undefined, comment corriger ce bug ?");
    expect(selected.length).toBeGreaterThan(0);
    expect(selected[0].family.id).toBe("code");
  });

  it("sélectionne la famille COMPARAISON pour une demande de comparaison", () => {
    const selected = selectFewShotExamples("Compare PostgreSQL et MongoDB, lequel est le meilleur ?");
    expect(selected[0].family.id).toBe("comparaison");
  });

  it("sélectionne la famille PROCÉDURE pour un tutoriel pas-à-pas", () => {
    const selected = selectFewShotExamples("Comment installer et configurer le déploiement de mon site ?");
    expect(selected[0].family.id).toBe("procedure");
  });

  it("sélectionne la famille ANALYSE CHIFFRÉE pour un calcul de budget", () => {
    const selected = selectFewShotExamples("Calcule le coût et le budget mensuel de mon projet.");
    expect(selected[0].family.id).toBe("analyse-chiffree");
  });

  it("les accents ne cassent JAMAIS la sélection (normalisation)", () => {
    const withAccents = selectFewShotExamples("Explique-moi la différence entre deux options");
    const withoutAccents = selectFewShotExamples("Explique moi la difference entre deux options");
    expect(withAccents.map((item) => item.family.id)).toEqual(withoutAccents.map((item) => item.family.id));
  });

  it("une salutation ne sélectionne AUCUN exemple (prompt court pour les échanges triviaux)", () => {
    expect(selectFewShotExamples("Bonjour, comment vas-tu ?")).toEqual([]);
    expect(selectFewShotExamples("Merci beaucoup !")).toEqual([]);
  });

  it("borne le résultat à FEW_SHOT_MAX_EXAMPLES (exigence : 1 à 2)", () => {
    expect(FEW_SHOT_MAX_EXAMPLES).toBeLessThanOrEqual(2);
    const selected = selectFewShotExamples(
      "Compare les options, explique le code, corrige le bug, calcule le budget et recommande un choix : comment installer ?",
    );
    expect(selected.length).toBeLessThanOrEqual(FEW_SHOT_MAX_EXAMPLES);
    expect(selected.length).toBeGreaterThan(0);
  });

  it("est DÉTERMINISTE : la même demande sélectionne toujours les mêmes exemples", () => {
    const message = "Comment faire pour corriger une erreur de code React ?";
    const first = selectFewShotExamples(message);
    const second = selectFewShotExamples(message);
    expect(first.map((item) => item.family.id)).toEqual(second.map((item) => item.family.id));
  });

  it("les ex æquo sont départagés par l'ordre de déclaration (stable)", () => {
    // « différence entre » touche comparaison ET explication (label famille
    // d'explication) — l'ordre de déclaration doit départager de façon stable.
    const first = selectFewShotExamples("Quelle est la différence entre ces deux approches ?");
    const second = selectFewShotExamples("Quelle est la différence entre ces deux approches ?");
    expect(first.map((item) => item.family.id)).toEqual(second.map((item) => item.family.id));
  });
});

describe("renderFewShotSection — rendu prompt", () => {
  it("retourne une chaîne VIDE sans sélection (aucune section fantôme)", () => {
    expect(renderFewShotSection([])).toBe("");
  });

  it("rend un exemple complet : demande + réponse de référence", () => {
    const selected = selectFewShotExamples("Explique-moi comment fonctionne le R2.");
    const rendered = renderFewShotSection(selected);
    expect(rendered).toContain("EXEMPLES DE QUALITÉ ATTENDUE");
    expect(rendered).toContain("Demande :");
    expect(rendered).toContain("Réponse de référence :");
    expect(rendered).toContain("EXEMPLE (question d'explication)");
  });

  it("signale que le sujet des exemples est illustratif (pas un modèle à copier)", () => {
    const rendered = renderFewShotSection(selectFewShotExamples("Compare ces deux outils."));
    expect(rendered).toContain("illustratif");
  });
});

describe("buildFewShotSection — raccourci sélection + rendu", () => {
  it("question de code → section contenant l'exemple de la famille code", () => {
    const section = buildFewShotSection("Corrige mon bug React de useEffect.");
    expect(section).toContain("EXEMPLES DE QUALITÉ ATTENDUE");
    expect(section).toContain("boucle infinie");
  });

  it("salutation → section vide", () => {
    expect(buildFewShotSection("Salut !")).toBe("");
  });
});

describe("FEW_SHOT_FAMILIES — intégrité du catalogue", () => {
  it("chaque famille a un id unique, des mots-clés et des exemples non vides", () => {
    const ids = new Set<string>();
    for (const family of FEW_SHOT_FAMILIES) {
      expect(ids.has(family.id)).toBe(false);
      ids.add(family.id);
      expect(family.keywords.length).toBeGreaterThan(0);
      expect(family.exampleRequest.trim().length).toBeGreaterThan(0);
      expect(family.exampleAnswer.trim().length).toBeGreaterThan(100);
    }
    expect(FEW_SHOT_FAMILIES.length).toBeGreaterThanOrEqual(6);
  });
});
