import { describe, expect, it } from "vitest";

import packageJson from "../../package.json";
import { EXTENSION_CATEGORIES } from "@/lib/extensions/manifest";
import {
  COMPATIBILITY_MATRIX,
  PLATFORM_CAPABILITIES,
  PLATFORM_VERSION,
  REQUIRED_CAPABILITIES,
  checkCompatibility,
  compareVersions,
  parseSemver,
} from "./compatibility";

/**
 * MARKETPLACE — MATRICE DE COMPATIBILITÉ (Task 132) : semver manuel
 * (égal/inférieur/supérieur), versions invalides, pré-requis manquants,
 * catégories réelles couvertes et raisons en français.
 */

describe("parseSemver (manuel)", () => {
  it("parse MAJEUR.MINEUR.CORRECTIF en nombres", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver("0.0.1")).toEqual({ major: 0, minor: 0, patch: 1 });
    expect(parseSemver("  2.10.4  ")).toEqual({ major: 2, minor: 10, patch: 4 });
  });

  it("refuse tout ce qui n'est pas un semver strict", () => {
    for (const invalid of ["1.2", "v1.2.3", "1.2.x", "1.2.3-beta", "", "une.version", "1.2.3.4"]) {
      expect(parseSemver(invalid)).toBeNull();
    }
  });
});

describe("compareVersions (manuel)", () => {
  it("versions égales → 0", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("2.13.7", "2.13.7")).toBe(0);
  });

  it("versions inférieures → négatif", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("1.9.9", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("1.255.0", "2.0.0")).toBeLessThan(0);
  });

  it("versions supérieures → positif", () => {
    expect(compareVersions("1.0.1", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("3.0.0", "2.255.255")).toBeGreaterThan(0);
  });

  it("comparaison NUMÉRIQUE (pas lexicographique) : 1.10.0 > 1.9.0", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
  });

  it("version invalide → erreur explicite", () => {
    expect(() => compareVersions("1.2", "1.0.0")).toThrow(/Version sémantique invalide/);
    expect(() => compareVersions("1.0.0", "x.y.z")).toThrow(/Version sémantique invalide/);
  });
});

describe("PLATFORM_VERSION (source package.json)", () => {
  it("est la version du package.json (lue à l'exécution)", () => {
    expect(PLATFORM_VERSION).toBe(packageJson.version);
    expect(parseSemver(PLATFORM_VERSION)).not.toBeNull();
  });
});

describe("matrice catégorie → capacités", () => {
  it("couvre EXACTEMENT les catégories réelles du projet", () => {
    expect(Object.keys(REQUIRED_CAPABILITIES).sort()).toEqual([...EXTENSION_CATEGORIES].sort());
    expect(COMPATIBILITY_MATRIX).toBe(REQUIRED_CAPABILITIES);
  });

  it("toutes les capacités référencées existent au catalogue plateforme", () => {
    for (const capabilities of Object.values(REQUIRED_CAPABILITIES)) {
      for (const capability of capabilities) {
        expect(PLATFORM_CAPABILITIES[capability]).toBeDefined();
      }
    }
  });

  it("toutes les capacités du catalogue sont disponibles à la version courante", () => {
    for (const definition of Object.values(PLATFORM_CAPABILITIES)) {
      expect(compareVersions(definition.since, PLATFORM_VERSION)).toBeLessThanOrEqual(0);
    }
  });
});

describe("checkCompatibility (pur)", () => {
  it("chaque catégorie réelle, seule, est compatible (reasons vides)", () => {
    for (const category of EXTENSION_CATEGORIES) {
      expect(checkCompatibility({ category })).toEqual({ ok: true, reasons: [] });
    }
  });

  it("version minimale ÉGALE à la plateforme → compatible", () => {
    expect(checkCompatibility({ category: "ai", minPlatformVersion: PLATFORM_VERSION }).ok).toBe(true);
  });

  it("version minimale INFÉRIEURE à la plateforme → compatible", () => {
    const older = "0.9.0";
    if (compareVersions(older, PLATFORM_VERSION) < 0) {
      expect(checkCompatibility({ category: "ai", minPlatformVersion: older }).ok).toBe(true);
    }
  });

  it("version minimale SUPÉRIEURE à la plateforme → refus + raison en français", () => {
    const future = `${Number(PLATFORM_VERSION.split(".")[0]) + 1}.0.0`;
    const result = checkCompatibility({ category: "ai", minPlatformVersion: future });
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual([
      `Cette extension nécessite la plateforme ≥ ${future} ; la version actuelle est ${PLATFORM_VERSION}.`,
    ]);
  });

  it("version minimale invalide → raison explicite (pas d'exception)", () => {
    const result = checkCompatibility({ category: "ai", minPlatformVersion: "2.x" });
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toMatch(/Version minimale de plateforme invalide/);
  });

  it("capacité requise inconnue → pré-requis manquant signalé", () => {
    const result = checkCompatibility({ category: "other", requiredCapabilities: ["quantum.compute"] });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain(
      "La plateforme Gen3ia ne prend pas en charge la capacité « quantum.compute » requise par cette extension.",
    );
  });

  it("capacités propres connues s'AJOUTENT à la baseline sans la remplacer", () => {
    // baseline « other » = [api.v1] ; on exige en plus voice (connue) → ok.
    expect(checkCompatibility({ category: "other", requiredCapabilities: ["voice"] })).toEqual({ ok: true, reasons: [] });
    // …mais une capacité inconnue reste bloquante.
    expect(checkCompatibility({ category: "other", requiredCapabilities: ["voice", "holography"] }).ok).toBe(false);
  });

  it("catégorie inconnue → raison listant les catégories reconnues", () => {
    const result = checkCompatibility({ category: "agriculture" });
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toMatch(/Catégorie d'extension inconnue : « agriculture »/);
    expect(result.reasons[0]).toContain(EXTENSION_CATEGORIES.join(", "));
  });

  it("plusieurs blocages → plusieurs raisons cumulées", () => {
    const result = checkCompatibility({
      category: "inconnue",
      minPlatformVersion: "99.0.0",
      requiredCapabilities: ["inexistante"],
    });
    expect(result.ok).toBe(false);
    expect(result.reasons).toHaveLength(3);
    for (const reason of result.reasons) expect(reason).toMatch(/[àéèêô]|Gen3ia|plateforme/);
  });

  it("toutes les raisons sont en français (message honnête, actionnable)", () => {
    const result = checkCompatibility({ category: "x", minPlatformVersion: "99.0.0", requiredCapabilities: ["y"] });
    for (const reason of result.reasons) expect(reason).toMatch(/plateforme|gen3ia|catégori|capacit/i);
  });
});
