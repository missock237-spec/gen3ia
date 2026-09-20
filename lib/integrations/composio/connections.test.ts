import { describe, expect, it } from "vitest";
import {
  CONNECTIONS_CATALOG,
  CONNECTION_CATEGORIES,
  assertSupportedToolkit,
  getCatalogEntry,
} from "./connections";

describe("Connections Hub catalog", () => {
  it("couvre les catégories attendues et des slugs uniques", () => {
    const slugs = CONNECTIONS_CATALOG.map((entry) => entry.toolkit);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const category of CONNECTION_CATEGORIES) {
      expect(CONNECTIONS_CATALOG.some((entry) => entry.category === category)).toBe(true);
    }
  });

  it("expose les toolkits différenciants (messagerie, social, calendrier)", () => {
    for (const toolkit of ["whatsapp", "telegram", "slack", "linkedin", "x", "gmail", "googlecalendar", "stripe"]) {
      expect(getCatalogEntry(toolkit), `toolkit ${toolkit} manquant`).toBeDefined();
    }
  });

  it("valide le format des identifiants (l'existence réelle est vérifiée côté Composio à la connexion)", () => {
    // La politique actuelle : assertSupportedToolkit valide le FORMAT du slug.
    // L'existence du toolkit est vérifiée en direct par assertToolkitExists()
    // dans authorizeToolkit() — aucun toolkit fictif ne peut créer de session.
    expect(() => assertSupportedToolkit("unknown_toolkit")).not.toThrow();
    expect(() => assertSupportedToolkit("github")).not.toThrow();
  });

  it("rejette les identifiants malformés", () => {
    expect(() => assertSupportedToolkit("")).toThrow();
    expect(() => assertSupportedToolkit("BAD SLUG!")).toThrow();
    expect(() => assertSupportedToolkit(`${"a".repeat(80)}`)).toThrow();
  });

  it("normalise la casse", () => {
    expect(assertSupportedToolkit("GITHUB")).toBe("github");
  });
});
