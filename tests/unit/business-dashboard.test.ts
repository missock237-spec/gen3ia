import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Verrous structurels — ESPACE BUSINESS, LOT 1 (itération 33, Job 478451).
 *
 * Constat d'audit (garde anti-code-mort it.29) : les 12 endpoints
 * /api/business/* (≈ 2 000 lignes, CRUD complet, Zod, rate-limit,
 * moteur IA) étaient livrés, testés, déployés — sans AUCUNE surface
 * utilisateur. Lot 1 : /business avec les 4 modules à réponse homogène
 * {records, kpis} (finance-unpaid, finance-cashflow, hr-training,
 * operations-maintenance) ; lots 2-3 annoncés honnêtement.
 *
 * Convention du dépôt : ces verrous lisent les sources pour empêcher
 * toute régression (cf. extensions-account-page.test.ts, it.31).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const vue = read("components/business/dashboard.tsx");
const page = read("app/business/page.tsx");
const registre = read("components/shells/nav-registry.ts");
const navItems = read("components/nav/nav-items.ts");

describe("it.33 lot 1 — la page /business existe et monte le tableau de bord", () => {
  it("app/business/page.tsx importe et rend BusinessDashboard", () => {
    expect(page).toContain('import { BusinessDashboard } from "@/components/business/dashboard"');
    expect(page).toContain("<BusinessDashboard />");
    expect(page).toContain('title: "Business"');
    expect(page).toContain("bg-[var(--g3-bg)]");
  });

  it("la navigation déclare /business (registre unique + groupe Ressources)", () => {
    expect(registre).toContain('id: "business"');
    expect(registre).toContain('href: "/business"');
    expect(registre).toContain('label: "Business"');
    const navItemsFin = navItems.indexOf("groupByIds([\"business\", \"billing\", \"settings\"])");
    expect(navItemsFin).toBeGreaterThan(-1);
  });
});

describe("it.33 lot 1 — les 4 modules KPI sont appelés avec le bon contrat", () => {
  it("les 4 endpoints {records, kpis} sont configurés", () => {
    expect(vue).toContain('"/api/business/finance-unpaid"');
    expect(vue).toContain('"/api/business/finance-cashflow"');
    expect(vue).toContain('"/api/business/hr-training"');
    expect(vue).toContain('"/api/business/operations-maintenance"');
    // Clés d'enregistrements conforme aux contrats serveur.
    expect(vue).toContain('recordsKey: "invoices"');
    expect(vue).toContain('recordsKey: "entries"');
    expect(vue).toContain('recordsKey: "trainings"');
    expect(vue).toContain('recordsKey: "assets"');
  });

  it("chargement INDÉPENDANT par module (Promise.allSettled — une panne n'emporte pas les autres)", () => {
    // Contrairement aux lectures atomiques (Promise.all, it.31), chaque
    // module métier se débrouille seul : rejet isolé → erreur isolée.
    expect(vue).toContain("Promise.allSettled(");
    expect(vue).toContain('etat: "erreur"');
    // Erreur serveur affichée telle quelle (pas de message générique masquant).
    expect(vue).toContain("String(corps?.error ??");
  });

  it("les KPI affichent les valeurs serveur telles quelles (aucun recalcul client)", () => {
    // Les libellés monétaires formatés côté serveur (openTotalLabel,
    // realizedBalanceLabel) sont affichés SANS re-formatage.
    expect(vue).toContain('key: "openTotalLabel"');
    expect(vue).toContain('key: "realizedBalanceLabel"');
    // Rendu : String(valeur) ou tiret — jamais de calcul.
    expect(vue).toContain("String(etat.kpis[kpi.key])");
  });
});

describe("it.33 lot 1 — honnêteté et a11y", () => {
  it("la page annonce les lots suivants (12 modules, 4 câblés)", () => {
    expect(vue).toContain("4 des 12 modules métier");
    expect(vue).toContain("prochaines versions");
  });

  it("page strictement en lecture (aucun appel POST/PATCH/DELETE)", () => {
    expect(vue).not.toContain('method: "POST"');
    expect(vue).not.toContain('method: "PATCH"');
    expect(vue).not.toContain('method: "DELETE"');
  });

  it("tableaux tronqués honnêtement (8 lignes + compteur du total)", () => {
    expect(vue).toContain("TAILLE_PAGE = 8");
    expect(vue).toContain("slice(0, TAILLE_PAGE)");
    expect(vue).toContain("autres enregistrements");
  });

  it("a11y : th scope, aria-labelledby par section, role=status, aria-busy", () => {
    expect(vue).toContain('scope="col"');
    expect(vue).toContain('aria-labelledby={`business-${module.id}-titre`}');
    expect(vue).toContain('role="status"');
    expect(vue).toContain("aria-busy=");
  });

  it("palette : tokens g3-* uniquement (convention du dépôt)", () => {
    const couleursBrutes = vue.match(/(bg|text|border)-\[(?!var\(--g3-)/g) ?? [];
    expect(couleursBrutes).toEqual([]);
  });
});
