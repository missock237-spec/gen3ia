import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Verrous structurels de la console genAPI (convention du dépôt : tests Node
 * par readFileSync — les composants React ne sont pas rendus en Node).
 *  - page.tsx est SERVEUR-ONLY : il lit directement le socle lib/genapi
 *    (aucun fetch interne), la barrière admin reste dans app/admin/layout.tsx ;
 *  - genapi-console.tsx est le client d'interaction ("use client") ;
 *  - le lien de paquet est construit sur la route one-time
 *    /api/admin/genapi/paquets/ et l'encart sécurité mentionne le zéro fuite ;
 *  - AdminShell expose l'entrée de navigation genAPI.
 */

const LIRE = (fichier: string): string =>
  readFileSync(path.join(import.meta.dirname, fichier), "utf8");

describe("app/admin/genapi/page.tsx — server component", () => {
  const source = LIRE("page.tsx");

  it("est serveur-only : pas de « use client »", () => {
    expect(source.includes('"use client"')).toBe(false);
  });

  it("lit directement le socle lib/genapi (sans fetch interne)", () => {
    expect(source).toContain("statutGenAPI");
    expect(source).toContain("listerClients");
    expect(source).toContain("listerJournalGenAPI");
    // Aucun fetch interne : la page consomme les fonctions lib importées.
    expect(source.includes("fetch(")).toBe(false);
  });

  it("panne du socle → bandeau honnête « genAPI indisponible : … »", () => {
    expect(source).toContain("genAPI indisponible :");
    expect(source).toContain("catch");
  });

  it("délègue les interactions à la console cliente en props", () => {
    expect(source).toContain("GenAPIConsole");
    expect(source).toContain("erreurInitiale");
  });
});

describe("app/admin/genapi/genapi-console.tsx — console cliente", () => {
  const source = LIRE("genapi-console.tsx");

  it("est un composant client (« use client »)", () => {
    expect(source.startsWith('"use client"')).toBe(true);
  });

  it("construit l'URL one-time sur /api/admin/genapi/paquets/", () => {
    expect(source).toContain("/api/admin/genapi/paquets/");
  });

  it("porte l'encart sécurité « zéro fuite » + usage unique 15 minutes", () => {
    expect(source).toContain("zéro fuite");
    expect(source).toContain("usage unique");
    expect(source).toContain("15 minutes");
  });

  it("gère provisionner, révoquer et télécharger via les routes admin genAPI", () => {
    expect(source).toContain("/api/admin/genapi/clients");
    expect(source).toContain('action: "provisionner"');
    expect(source).toContain('action: "revoquer"');
    expect(source).toContain("download");
  });

  it("suit le design système du dépôt (g3-btn, cartes rounded-3xl)", () => {
    expect(source).toContain("g3-btn");
    expect(source).toContain("rounded-3xl");
  });
});

describe("components/admin/admin-shell.tsx — navigation genAPI", () => {
  const source = readFileSync(
    path.join(import.meta.dirname, "..", "..", "..", "components", "admin", "admin-shell.tsx"),
    "utf8",
  );

  it("expose l'entrée genAPI vers /admin/genapi", () => {
    expect(source).toContain("genAPI");
    expect(source).toContain("/admin/genapi");
  });

  it("préserve le registre global (entrée ajoutée par le shell, pas ailleurs)", () => {
    expect(source).toContain("ROUTE_ADMIN_GENAPI");
    expect(source).toContain("navPrimaryFor");
  });
});
