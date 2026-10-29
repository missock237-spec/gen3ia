import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Verrous structurels — ESPACE BUSINESS (Job 478451).
 *
 * it.33 lot 1 : les 4 modules à réponse homogène {records, kpis}
 * (finance-unpaid, finance-cashflow, hr-training, operations-maintenance).
 * it.35 lot 2 : les 3 modules composites (hr-leaves {leaves, balances},
 * compliance-gdpr {processing, requests, kpis}, documents-onboarding
 * {flows, kpis}) — avec tables secondaires et honnêteté KPI (hr-leaves
 * n'a PAS de kpis serveur : aucun inventé).
 * it.36 lot 3 : les 4 derniers modules de lecture (documents-contracts
 * {contracts}, marketing-landing {pages}, marketing-webinar {assets},
 * automations {workflows, runs, notifications} — notifications NON
 * dupliquées, elles ont leur centre dédié) ; /business/pulse reste
 * volontairement hors vue lecture (mission agent POST coûteuse).
 *
 * Constat d'audit (garde anti-code-mort it.29) : les 12 endpoints
 * /api/business/* (≈ 2 000 lignes, CRUD complet, Zod, rate-limit,
 * moteur IA) étaient livrés, testés, déployés — sans AUCUNE surface
 * utilisateur.
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
  it("la page annonce la couverture honnête (11 modules câblés, pulse exclu)", () => {
    expect(vue).toContain("11 des 12 modules métier");
    // Honnêteté sur le 12e : mission agent coûteuse, pas une omission.
    expect(vue).toContain("volontairement hors vue lecture");
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

describe("it.35 lot 2 — les 3 modules composites sont câblés avec le bon contrat", () => {
  it("les 3 endpoints composites sont configurés avec leurs clés serveur", () => {
    expect(vue).toContain('"/api/business/hr-leaves"');
    expect(vue).toContain('"/api/business/compliance-gdpr"');
    expect(vue).toContain('"/api/business/documents-onboarding"');
    // Clés d'enregistrements conformes aux contrats serveur.
    expect(vue).toContain('recordsKey: "leaves"');
    expect(vue).toContain('recordsKey: "requests"');
    expect(vue).toContain('recordsKey: "flows"');
  });

  it("hr-leaves : AUCUN KPI inventé (le serveur ne renvoie pas de kpis)", () => {
    // Le module déclare kpis: [] — aucun indicateur calculé côté client.
    expect(vue).toContain("kpis: [],");
    // Les soldes (balances) sont la table secondaire, pas des KPI.
    expect(vue).toContain('recordsKey: "balances"');
  });

  it("tables secondaires : transformation STRUCTURELLE, valeurs telles quelles", () => {
    // La correspondance serveur (Record) devient des lignes via
    // Object.entries + SPREAD des valeurs — aucun recalcul métier.
    expect(vue).toContain("Object.entries(brutSec as Record<string, unknown>)");
    expect(vue).toContain("...(valeurs && typeof valeurs === \"object\" ? (valeurs as Ligne) : {})"
    );
    expect(vue).toContain("transformation structurelle");
    // Registre des traitements (deuxième liste du serveur) affichée.
    expect(vue).toContain('recordsKey: "processing"');
  });

  it("KPI serveur affichés tels quels pour conformité RGPD et onboarding", () => {
    // SLA DSR calculés serveur (openRequests, breached) et compteurs
    // onboarding (total, active, completed) — jamais recalculés.
    expect(vue).toContain('key: "openRequests"');
    expect(vue).toContain('key: "breached"');
    expect(vue).toContain('key: "active"');
    expect(vue).toContain('key: "completed"');
  });

  it("format taille : comptage STRUCTUREL d'une liste, jamais un calcul métier", () => {
    expect(vue).toContain('format: "taille"');
    // it.36 : le formateur gère listes ET objets — toujours structurel.
    expect(vue).toContain("if (Array.isArray(brut)) return String(brut.length);");
    expect(vue).toContain("jamais un");
  });
});

describe("it.36 lot 3 — les 4 derniers modules de lecture sont câblés", () => {
  it("les 4 endpoints sont configurés avec leurs clés serveur", () => {
    expect(vue).toContain('"/api/business/documents-contracts"');
    expect(vue).toContain('"/api/business/marketing-landing"');
    expect(vue).toContain('"/api/business/marketing-webinar"');
    expect(vue).toContain('"/api/business/automations"');
    expect(vue).toContain('recordsKey: "contracts"');
    expect(vue).toContain('recordsKey: "pages"');
    expect(vue).toContain('recordsKey: "assets"');
    expect(vue).toContain('recordsKey: "workflows"');
  });

  it("modules sans kpis serveur : AUCUN indicateur inventé", () => {
    // contrats, landing, webinars et automatisations n'ont pas de kpis
    // serveur — ils déclarent kpis: [] (comme congés en it.35).
    expect(vue).toContain("kpis: [],");
  });

  it("automatisations : workflows + exécutions en table secondaire, notifications NON dupliquées", () => {
    expect(vue).toContain('recordsKey: "workflows"');
    expect(vue).toContain('recordsKey: "runs"');
    // Honnêteté : la 3e liste du serveur a déjà son centre dédié.
    expect(vue).toContain("centre dédié");
    expect(vue).toContain("ne les duplique pas");
  });

  it("formateurs structurels : notation pointée, declencheur, date-ms, oui-non", () => {
    // Lecture de chemin (trigger.type) — résolution, pas transformation.
    expect(vue).toContain('"trigger.type"');
    expect(vue).toContain("function lireValeur");
    expect(vue).toContain('format: "declencheur"');
    expect(vue).toContain('format: "date-ms"');
    expect(vue).toContain('format: "oui-non"');
    // taille étendu aux objets (contenus d'un kit) — toujours structurel.
    expect(vue).toContain("Object.keys(brut).length");
  });

  it("pulse exclu honnêtement de la vue lecture (mission agent POST)", () => {
    // Mention volontairement SANS le chemin littéral : une mention
    // d'URL blanchirait l'endpoint hors de la baseline du garde it.29
    // (une mention n'est pas une UI).
    expect(vue).toContain("(pulse)");
    expect(vue).toContain("mission agent coûteuse");
  });
});
