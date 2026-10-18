import { describe, expect, it } from "vitest";

import { COMPOSER_MODEL_OPTIONS, findModelOption, modelChoiceLabel } from "./composer-models";

/**
 * Task 141 — options de moteur IA du composer : verrous sur le catalogue pur
 * (identifiants stables, « auto » sans provider, libellés présents).
 */

describe("composer-models — catalogue des moteurs", () => {
  it("expose une option « auto » sans provider ni modèle (routeur Gen3ia)", () => {
    const auto = findModelOption("auto");
    expect(auto).not.toBeNull();
    expect(auto?.provider).toBeUndefined();
    expect(auto?.model).toBeUndefined();
    expect(auto?.label).toBe("Automatique");
  });

  it("chaque option non-auto porte un couple provider/model résolvable", () => {
    for (const option of COMPOSER_MODEL_OPTIONS) {
      if (option.id === "auto") continue;
      expect(option.provider).toBeTruthy();
      expect(option.model).toBeTruthy();
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
    }
  });

  it("les identifiants sont uniques", () => {
    const ids = COMPOSER_MODEL_OPTIONS.map((option) => option.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("findModelOption retourne null pour un identifiant inconnu", () => {
    expect(findModelOption("inexistant")).toBeNull();
    expect(findModelOption(undefined)).toBeNull();
  });

  it("modelChoiceLabel retombe sur « Automatique » pour un choix inconnu", () => {
    expect(modelChoiceLabel(undefined)).toBe("Automatique");
    expect(modelChoiceLabel("inconnu")).toBe("Automatique");
    expect(modelChoiceLabel("neural")).toBe("Neural Gen3");
  });
});
