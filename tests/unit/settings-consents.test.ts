import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Verrous structurels — PANNEAU DE CONSENTEMENTS (itération 30, Job 478451).
 *
 * Constat d'audit (garde anti-code-mort it.29) : /api/memory/consent et
 * /api/settings/tool-consents étaient livrés, testés, déployés — sans
 * AUCUNE surface utilisateur. L'utilisateur ne pouvait ni voir ni retirer
 * un consentement : un droit qui n'a pas d'interface est un droit mort.
 *
 * Le présent lot câble la section « Consentements » (page Paramètres).
 * Convention du dépôt : ces verrous lisent les sources pour empêcher toute
 * régression (cf. ux-accessibility.test.ts, account-export.test.ts).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const section = read("components/settings/consents-section.tsx");
const page = read("app/settings/page.tsx");

describe("it.30 — la section Consentements est montée sur la page Paramètres", () => {
  it("app/settings/page.tsx importe et rend ConsentsSection", () => {
    expect(page).toContain('import { ConsentsSection } from "@/components/settings/consents-section"');
    expect(page).toContain("<ConsentsSection />");
    // Ordre logique : gouvernance (export/effacement) puis consentements.
    const gouvernance = page.indexOf("<DataGovernanceSection />");
    const consentements = page.indexOf("<ConsentsSection />");
    expect(gouvernance).toBeGreaterThan(-1);
    expect(consentements).toBeGreaterThan(gouvernance);
  });
});

describe("it.30 — les deux endpoints orphelins sont appelés avec le bon contrat", () => {
  it("traitement mémoire : GET puis POST /api/memory/consent {memoryProcessing}", () => {
    expect(section).toContain('"/api/memory/consent"');
    expect(section).toContain("method: \"POST\"");
    expect(section).toContain("{ memoryProcessing: suivant }");
    // Retour serveur = source de vérité (pas d'optimisme aveugle).
    expect(section).toContain("corps.memoryProcessing");
  });

  it("outils par catégorie : GET puis PUT /api/settings/tool-consents {modes}", () => {
    expect(section).toContain('"/api/settings/tool-consents"');
    expect(section).toContain("method: \"PUT\"");
    expect(section).toContain("{ modes: suivants }");
    // Le PUT envoie la carte COMPLÈTE (le serveur remplace, pas un patch).
    const put = section.indexOf("method: \"PUT\"");
    const carte = section.indexOf("{ ...precedents", 0);
    expect(carte).toBeGreaterThan(-1);
    expect(section.indexOf("suivants = { ...precedents")).toBeLessThan(put);
  });

  it("les 4 catégories et 3 modes du serveur sont respectés (pas de liste codée en dur côté UI pour les catégories)", () => {
    // Les catégories viennent du GET (categories ?? []) — aucune catégorie
    // inventée côté client qui divergerait du serveur.
    expect(section).toContain("corpsOutils.categories ?? []");
    // Les modes sont le triple serveur ask | always | deny.
    expect(section).toContain('(["ask", "always", "deny"] as Mode[])');
  });
});

describe("it.30 — honnêteté du contrat de consentement affichée", () => {
  it("le mode « always » annonce la limite serveur : validation humaine finale", () => {
    // lib/security/tool-consents.ts : « always » ne pré-approuve JAMAIS les
    // écritures/externes. L'UI ne doit pas promettre plus que le serveur.
    expect(section).toContain("jamais pour les écritures et actions sensibles");
    expect(section).toContain("validation humaine reste la couche finale");
  });

  it("le retrait mémoire annonce l'effet exact : immédiat, sans suppression des données", () => {
    // /api/memory/consent : le retrait ne supprime PAS les données existantes.
    expect(section).toContain("Retrait immédiat");
    expect(section).toContain("ne sont pas supprimées");
    expect(section).toContain("« Mes données »");
  });
});

describe("it.30 — accessibilité native (WCAG)", () => {
  it("section titrée, groupes nommés, contrôles natifs", () => {
    expect(section).toContain('aria-labelledby="settings-consents-title"');
    // Groupes de champs avec légende (pas de div aria-bidouille) — 2
    // littéraux sources (mémoire + 1 par catégorie via categories.map).
    expect((section.match(/<fieldset/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((section.match(/<legend/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(section).toContain("categories.map");
    expect(section.includes('type="checkbox"')).toBe(true);
    expect((section.match(/type="radio"/g) ?? []).length).toBeGreaterThan(0);
    // Zone de statut pour lecteurs d'écran.
    expect(section).toContain('role="status"');
  });

  it("contrôles désactivés pendant une requête (pas de double envoi)", () => {
    expect((section.match(/disabled=\{enCours !== null\}/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(section).toContain("disabled={memoire === null || enCours !== null}");
  });
});

describe("it.30 — palette et cohérence visuelle", () => {
  it("aucune couleur hors tokens g3-*", () => {
    const couleursBrutes = section.match(/(bg|text|border)-\[(?!var\(--g3-)/g) ?? [];
    expect(couleursBrutes).toEqual([]);
  });

  it("authFetch pour les appels authentifiés (convention du dépôt)", () => {
    expect(section).toContain('from "@/lib/firebase/auth-client"');
    expect((section.match(/authFetch\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
