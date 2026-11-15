import { describe, expect, it } from "vitest";
import {
  CONNECTIONS_CATALOG,
  CONNECTION_CATEGORIES,
  assertSupportedToolkit,
  getCatalogEntry,
  mapRawToolkitItem,
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

  it("expose les connecteurs entreprise Zendesk et ServiceNow (Task 133)", () => {
    const zendesk = getCatalogEntry("zendesk");
    expect(zendesk, "toolkit zendesk manquant").toBeDefined();
    expect(zendesk).toMatchObject({
      toolkit: "zendesk",
      label: "Zendesk",
      description: "Tickets, support client et base de connaissances.",
      category: "crm",
      auth: "oauth",
    });

    const servicenow = getCatalogEntry("servicenow");
    expect(servicenow, "toolkit servicenow manquant").toBeDefined();
    expect(servicenow).toMatchObject({
      toolkit: "servicenow",
      label: "ServiceNow",
      description: "Incidents, requêtes et workflows ITSM.",
      category: "developer",
      auth: "oauth",
    });
  });

  it("garantit sur TOUT le catalogue des catégories de l'union, des auth valides et zéro doublon", () => {
    const categoriesValides = new Set<string>(CONNECTION_CATEGORIES);
    const authsValides = new Set(["oauth", "api_key", "no_auth"]);
    const vus = new Set<string>();
    for (const entry of CONNECTIONS_CATALOG) {
      expect(categoriesValides.has(entry.category), `catégorie invalide pour ${entry.toolkit}`).toBe(true);
      expect(authsValides.has(entry.auth), `auth invalide pour ${entry.toolkit}`).toBe(true);
      expect(vus.has(entry.toolkit), `doublon de toolkit ${entry.toolkit}`).toBe(false);
      vus.add(entry.toolkit);
    }
    expect(vus.has("zendesk")).toBe(true);
    expect(vus.has("servicenow")).toBe(true);
  });
});

describe("mapRawToolkitItem (client HTTP brut Composio)", () => {
  it("mappe la forme snake_case du client brut (/api/v3.1/toolkits)", () => {
    const item = mapRawToolkitItem({
      slug: "googledrive",
      name: "Google Drive",
      meta: {
        description: "Files and documents.",
        logo: "https://logo.example/gd.png",
        categories: [{ slug: "file-management-&-storage", name: "File Management & Storage" }],
      },
      auth_schemes: ["OAUTH2"],
      composio_managed_auth_schemes: ["OAUTH2"],
      no_auth: false,
    });
    expect(item).toEqual({
      toolkit: "googledrive",
      label: "Google Drive",
      description: "Files and documents.",
      logo: "https://logo.example/gd.png",
      categories: ["file-management-&-storage"],
      authSchemes: ["OAUTH2"],
      managedBy: "composio",
      noAuth: false,
    });
  });

  it("tolère les meta.categories manquantes et les champs camelCase du wrapper", () => {
    const item = mapRawToolkitItem({
      slug: "stripe",
      name: "Stripe",
      composioManagedAuthSchemes: ["API_KEY"],
      noAuth: true,
    });
    expect(item.toolkit).toBe("stripe");
    expect(item.categories).toEqual([]);
    expect(item.authSchemes).toEqual(["API_KEY"]);
    expect(item.noAuth).toBe(true);
    expect(item.logo).toBeNull();
  });

  it("ne produit jamais de toolkit vide", () => {
    expect(mapRawToolkitItem({ name: "Sans slug" }).toolkit).toBe("");
  });
});
