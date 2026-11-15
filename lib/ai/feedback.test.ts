import { describe, expect, it } from "vitest";

import { FEEDBACK_CATEGORIES, LESSON_ACTIVATION_THRESHOLD } from "./feedback";

/**
 * Les fonctions Firestore de feedback.ts sont couvertes par la conformité
 * de schéma (zod côté route) et par le design de pipeline documenté ; ce
 * fichier vérifie le CONTRAT PUBLIC testable sans émulateur : catégories
 * stables et seuil d'activation cohérent avec la documentation.
 */

describe("feedback — contrat public", () => {
  it("les catégories sont stables et exhaustives", () => {
    expect(FEEDBACK_CATEGORIES).toEqual(["hallucination", "incorrect", "incomplet", "hors-sujet", "style", "autre"]);
  });

  it("le seuil d'activation exige une confirmation (≥ 2 signaux)", () => {
    expect(LESSON_ACTIVATION_THRESHOLD).toBeGreaterThanOrEqual(2);
  });
});
