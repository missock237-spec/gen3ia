import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 114-b — service du « Jumeau Créatif » :
 *  1. buildTwinDirective (PUR) : vide → "", complet → sections FR + valeurs,
 *     plafond 1200 caractères ;
 *  2. buildTwinImageHint (PUR) : extrait image ≤ 300 caractères ;
 *  3. validation du schéma : patch accepté / refusé (> 12 valeurs,
 *     > 2000 caractères) ;
 *  4. updateTwinProfile : fusion champ à champ, effacement par chaîne vide,
 *     updatedAtMs posé serveur, propagation d'une identité absente.
 * Les lectures passent par le VRAI cache (cacheWrap process-local) —
 * réinitialisé entre les tests via des identifiants uniques.
 */

const serviceState = vi.hoisted(() => ({
  identities: new Map<string, unknown>(),
  updatedPatches: [] as Array<{ userId: string; patch: unknown }>,
}));

vi.mock("./service", () => ({
  getIdentitySafe: vi.fn(async (uid: string) => (serviceState.identities.get(uid) ?? null) as never),
  updateIdentity: vi.fn(async (uid: string, patch: unknown) => {
    serviceState.updatedPatches.push({ userId: uid, patch });
    return {} as never;
  }),
}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: vi.fn() },
}));

import { TwinProfileSchema } from "./schema";
import {
  buildTwinDirective,
  buildTwinImageHint,
  getTwinProfile,
  MAX_TWIN_DIRECTIVE_LENGTH,
  MAX_TWIN_IMAGE_HINT_LENGTH,
  updateTwinProfile,
} from "./twin";

function profilComplet() {
  return {
    writingStyle:
      "Phrases courtes et directes, vocabulaire concret, tutoiement, chiffres à l'appui, pas de jargon marketing.",
    universe: "Marque de cafés de spécialité torréfiés à Douala, audience jeunes urbains d'Afrique centrale.",
    values: ["Authenticité", "Commerce équitable", "Proximité client"],
    tone: "Chaleureux et percutant",
  };
}

beforeEach(() => {
  serviceState.identities.clear();
  serviceState.updatedPatches.length = 0;
});

describe("buildTwinDirective (pur)", () => {
  it("profil vide → chaîne vide (rien à injecter)", () => {
    expect(buildTwinDirective({})).toBe("");
    expect(buildTwinDirective({ updatedAtMs: 42 })).toBe("");
  });

  it("profil complet → contient l'entête, les 4 sections et les valeurs", () => {
    const directive = buildTwinDirective(profilComplet());
    expect(directive).toContain("PROFIL DU JUMEAU CRÉATIF");
    expect(directive).toContain("- Style d'écriture : Phrases courtes et directes");
    expect(directive).toContain("- Univers : Marque de cafés de spécialité");
    expect(directive).toContain("- Valeurs : Authenticité ; Commerce équitable ; Proximité client");
    expect(directive).toContain("- Ton : Chaleureux et percutant");
  });

  it("reste compact : jamais plus de 1200 caractères même avec un profil maximal", () => {
    const maximal = {
      writingStyle: "Style très détaillé. ".repeat(120),
      universe: "Univers très détaillé. ".repeat(120),
      values: Array.from({ length: 12 }, (_, index) => `Valeur numéro ${index} `.repeat(6)),
      tone: "Ton très détaillé. ".repeat(20),
    };
    const directive = buildTwinDirective(maximal);
    expect(directive.length).toBeLessThanOrEqual(MAX_TWIN_DIRECTIVE_LENGTH);
    expect(directive).toContain("PROFIL DU JUMEAU CRÉATIF");
  });
});

describe("buildTwinImageHint (pur)", () => {
  it("profil vide → chaîne vide (prompt image inchangé)", () => {
    expect(buildTwinImageHint({})).toBe("");
  });

  it("profil complet → extrait Style/Univers/Ambiance plafonné à 300 caractères", () => {
    const hint = buildTwinImageHint(profilComplet());
    expect(hint).toContain("Style : Phrases courtes");
    expect(hint).toContain("Univers : Marque de cafés");
    expect(hint).toContain("Ambiance : Chaleureux et percutant");
    expect(hint.length).toBeLessThanOrEqual(MAX_TWIN_IMAGE_HINT_LENGTH);
  });
});

describe("TwinProfileSchema (validation)", () => {
  it("accepte un patch valide (champs partiels)", () => {
    const parsed = TwinProfileSchema.parse({ writingStyle: "Sobre et précis.", tone: "Professionnel" });
    expect(parsed.writingStyle).toBe("Sobre et précis.");
    expect(parsed.universe).toBeUndefined();
  });

  it("refuse plus de 12 valeurs", () => {
    const tropDeValeurs = { values: Array.from({ length: 13 }, (_, index) => `valeur-${index}`) };
    expect(() => TwinProfileSchema.parse(tropDeValeurs)).toThrow();
  });

  it("refuse un writingStyle de plus de 2000 caractères", () => {
    expect(() => TwinProfileSchema.parse({ writingStyle: "a".repeat(2001) })).toThrow();
  });

  it("refuse une valeur de plus de 200 caractères", () => {
    expect(() => TwinProfileSchema.parse({ values: ["a".repeat(201)] })).toThrow();
  });

  it("accepte exactement 12 valeurs et 2000 caractères (bornes incluses)", () => {
    expect(() =>
      TwinProfileSchema.parse({
        writingStyle: "a".repeat(2000),
        values: Array.from({ length: 12 }, (_, index) => `v-${index}`),
      }),
    ).not.toThrow();
  });
});

describe("updateTwinProfile (fusion + écriture)", () => {
  it("fusionne champ à champ avec l'existant et pose updatedAtMs", async () => {
    serviceState.identities.set("uid-twin-1", {
      twinProfile: { writingStyle: "Ancien style.", tone: "Neutre" },
    });
    const resultat = await updateTwinProfile("uid-twin-1", { universe: "Café de spécialité." });

    expect(resultat.writingStyle).toBe("Ancien style."); // conservé
    expect(resultat.tone).toBe("Neutre"); // conservé
    expect(resultat.universe).toBe("Café de spécialité."); // ajouté
    expect(typeof resultat.updatedAtMs).toBe("number");

    const patch = serviceState.updatedPatches[0]?.patch as { twinProfile?: Record<string, unknown> };
    expect(patch.twinProfile?.writingStyle).toBe("Ancien style.");
    expect(patch.twinProfile?.universe).toBe("Café de spécialité.");
  });

  it("une chaîne vide efface le champ (sémantique de clearing)", async () => {
    serviceState.identities.set("uid-twin-2", {
      twinProfile: { writingStyle: "Ancien style.", values: ["Ancienne"] },
    });
    const resultat = await updateTwinProfile("uid-twin-2", { writingStyle: "  ", values: [] });

    expect(resultat.writingStyle).toBeUndefined(); // effacé
    expect(resultat.values).toBeUndefined(); // effacé
  });

  it("relaye les dépassements (ZodError) sans écrire", async () => {
    await expect(
      updateTwinProfile("uid-twin-3", { writingStyle: "a".repeat(2001) }),
    ).rejects.toThrow();
    expect(serviceState.updatedPatches).toHaveLength(0);
  });

  it("getTwinProfile : identité absente → profil vide (fail-soft)", async () => {
    await expect(getTwinProfile("uid-inconnu")).resolves.toEqual({});
  });
});
