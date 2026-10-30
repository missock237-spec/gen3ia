import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * USAGE PAR ORGANISATION (it.51) — conventions du dépôt : vitest tourne
 * en Node SANS jsdom ni @testing-library/react (cf.
 * knowledge-console.test.ts). Le câblage de la vue entreprise
 * (components/observability/org-usage-console.tsx, page
 * /observability/org — Task 43 du saas-roadmap §3) est verrouillé
 * structurellement :
 *
 *  1. LES DEUX PORTES SONT CONSOMMÉES : GET /api/organizations
 *     (sélecteur des orgs du compte, rôle et membres restitués) et
 *     GET /api/observability/org?orgId=…&days=… (usage agrégé de l'org).
 *  2. LE CONTRAT RÉEL EST RESTITUÉ TEL QUEL : totaux (exécutions, taux
 *     de succès, coût facturé + coût fournisseurs, tokens, durée),
 *     adoption par agent (byAgent), outils (byTool), activité
 *     quotidienne (byDay), membres couverts (membersCovered) —
 *     données agrégées, aucun contenu conversationnel exposé.
 *  3. L'ÉTAT EST HONNÊTE : 401 → connexion, 404 uniforme de la porte
 *     (org absente OU non-membre) restitué tel quel — jamais maquillé
 *     en état vide ; échec réseau affiché role=alert ; garde anti-course
 *     (réponse périmée jamais restituée) ; zéro requête tant qu'aucune
 *     org n'est sélectionnée.
 *  4. ZÉRO DÉPENDANCE EXTERNE : les portes consommées sont uniquement
 *     les portes maison (authFetch same-origin, convention du fichier).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const CONSOLE = "components/observability/org-usage-console.tsx";

describe("Usage par organisation — vue entreprise (câblage it.51)", () => {
  const consoleData = read(CONSOLE);

  it("les deux portes sont consommées (sélecteur d'orgs + usage agrégé)", () => {
    // GET /api/organizations — les orgs du compte (rôle joint).
    expect(consoleData).toContain('authFetch("/api/organizations", { cache: "no-store" })');
    // GET /api/observability/org — la porte d'usage, avec orgId + days.
    expect(consoleData).toContain("`/api/observability/org?${params.toString()}`");
    expect(consoleData).toContain('new URLSearchParams({ orgId: nextOrg, days: String(nextDays) })');
    // La sélection immédiate de la première org lance la vue (page dédiée).
    expect(consoleData).toContain("setOrgId(data.organizations[0]?.id ?? \"\")");
  });

  it("le contrat réel est restitué tel quel (totaux, byAgent, byTool, byDay, membres couverts)", () => {
    // Totaux agrégés restitués (succès, coûts, tokens, durée).
    expect(consoleData).toContain("usage.totals.successRate");
    expect(consoleData).toContain("usage.totals.providerCostEur");
    expect(consoleData).toContain("usage.totals.avgDurationMs");
    // Dimension agent (adoption : exécutions, échecs, coûts, tokens).
    expect(consoleData).toContain("usage.byAgent.map");
    expect(consoleData).toContain("Agents les plus sollicités");
    // Dimensions outil + jour (mêmes conventions que la vue personnelle).
    expect(consoleData).toContain("usage.byTool.map");
    expect(consoleData).toContain("usage.byDay.map");
    // Membres couverts — la preuve que la vue est bien ORGANISATION.
    expect(consoleData).toContain("usage.membersCovered");
    // Honnêteté du périmètre : données agrégées, rien de conversationnel.
    expect(consoleData).toContain("aucun contenu conversationnel");
  });

  it("l'état est honnête : 401 connexion, 404 restitué, échec affiché, anti-course, zéro requête à l'aveugle", () => {
    // 401 — message de connexion explicite.
    expect(consoleData).toContain("Connectez-vous pour consulter l&apos;usage de votre organisation");
    expect(consoleData).toContain('"Connectez-vous pour consulter l\'usage de votre organisation."');
    // 404 uniforme de la porte (org absente OU non-membre) restitué tel
    // quel — jamais maquillé en état vide.
    expect(consoleData).toContain("404 uniforme de la porte");
    // Échec réseau affiché (role alert) + statut sur la vue restituée.
    expect(consoleData).toContain('role="alert"');
    expect(consoleData).toContain('role="status"');
    // Garde anti-course : la réponse périmée ne doit pas écraser la plus
    // récente (pattern loadToken de la vue personnelle).
    expect(consoleData).toContain("loadTokenRef");
    expect(consoleData).toContain("if (token !== loadTokenRef.current) return;");
    // Zéro requête tant qu'aucune org n'est sélectionnée (effect conditionné).
    expect(consoleData).toContain("if (!nextOrg) return;");
    // Sélecteur accessible (label aria) — l'utilisateur sait quelle org il consulte.
    expect(consoleData).toContain('aria-label="Organisation consultée"');
  });

  it("zéro dépendance externe : les portes consommées sont uniquement les portes maison", () => {
    const sectionUsage = consoleData.slice(
      consoleData.indexOf("const chargerUsage"),
      consoleData.indexOf("const orgsActives"),
    );
    expect(sectionUsage).toContain("/api/observability/org");
    expect(sectionUsage).not.toMatch(/https?:\/\//);
    expect(sectionUsage).not.toContain("axios");
  });
});
