import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { navFor } from "@/components/shells/nav-registry";

/**
 * RESTAURATION DES SURFACES (demande propriétaire, 10-2026) :
 *
 *  1. STUDIO D'ENTRAÎNEMENT IA (/neural, Aurora OS V6) : ouvert à TOUS LES
 *     COMPTES — page allowlistée, API /api/neural ouverte (reset excepté),
 *     entrée « Cerveau IA » visible dès le rôle "user", actions à privilège
 *     (train POST / reset) masquées dans la console pour un compte standard.
 *  2. PLANIFICATIONS : surface UI recréée pour les tâches planifiées
 *     automatisées — branchée sur /api/agents/schedules (requireUser +
 *     scoping propriétaire). RESTRUCTURATION DES PARCOURS (10-2026) : la
 *     surface est FONDUE dans l'Espace Automatisations /automations comme
 *     onglet « Planifications » (aux côtés de l'onglet « Agents ») ;
 *     /planifications redirige vers /automations#planifications.
 *  3. RECHARGE WALLET : le widget Chariow du produit de recharge
 *     (prd_llfosdp1) reste branché sur /billing (verrou chariow-widget).
 *
 * Convention du dépôt : verrous structurels lisant les sources + le
 * registre de navigation (source unique de vérité).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const USER_ACCESS = "lib/security/user-access.ts";
const NAV_ITEMS = "components/nav/nav-items.ts";
const PAGE = "app/planifications/page.tsx";
const AUTOMATIONS_PAGE = "app/automations/page.tsx";
const CONSOLE_AUTOMATIONS = "components/automations/automations-console.tsx";
const WORKSPACE = "components/planifications/planifications-workspace.tsx";
const CONSOLE = "components/neural/neural-console.tsx";

describe("Restauration — studio d'entraînement IA (/neural)", () => {
  it("la page /neural est allowlistée utilisateur (famille training)", () => {
    const access = read(USER_ACCESS);
    expect(access).toContain('"/neural": "training"');
    expect(access).toContain('["/api/neural", "training"]');
    expect(access).toContain('["/api/neural/reset", "systeme"]');
  });

  it("l'entrée « Cerveau IA » est visible dès le rôle user (sans minRole)", () => {
    const visibles = navFor("workspace", "user").map((route) => route.href);
    expect(visibles).toContain("/neural");
  });

  it("la console masque les actions à privilège aux non-opérateurs", () => {
    const console = read(CONSOLE);
    expect(console).toContain('fetch("/api/auth/access"');
    expect(console).toContain("estOperateur");
    // Les boutons admin restent présents mais conditionnés au rôle.
    expect(console).toContain("Lancer un entraînement");
    expect(console).toContain("Réinitialiser");
  });
});

describe("Restauration — planifications (tâches automatisées)", () => {
  it("l'espace Automatisations est allowlisté et branché sur le scheduler", () => {
    const access = read(USER_ACCESS);
    // L'espace unifié est allowlisté (l'ancienne entrée /planifications
    // reste allowlistée pour la page de redirection).
    expect(access).toContain('"/automations": "automatisation"');
    // L'API schedules reste allowlistée utilisateur (contrat existant).
    expect(access).toContain('["/api/agents/schedules", "planifications"]');
  });

  it("l'entrée « Automatisations » est visible dès le rôle user (navigation principale)", () => {
    const visibles = navFor("workspace", "user").map((route) => route.href);
    expect(visibles).toContain("/automations");
    const navItems = read(NAV_ITEMS);
    // Le groupe principal du workspace embarque l'espace automatisations.
    expect(navItems).toContain('["chat-ia", "lab", "data", "automations", "cerveau"]');
  });

  it("le workspace couvre le cycle complet des planifications", () => {
    const workspace = read(WORKSPACE);
    // Liste + création + exécution manuelle + pause/reprise + suppression
    // + historique + veille — tous les endpoints du scheduler.
    expect(workspace).toContain('authFetch("/api/agents"');
    expect(workspace).toContain('authFetch("/api/agents/schedules"');
    expect(workspace).toContain("run`");
    expect(workspace).toContain("runs?limit=25");
    expect(workspace).toContain("/watch`");
    expect(workspace).toContain("JSON.stringify({ enabled: !p.enabled })");
    expect(workspace).toContain("{ method: \"DELETE\" }");
    // Fuseau horaire réel transmis au scheduler (assertTimezone serveur).
    expect(workspace).toContain("resolvedOptions().timeZone");
    // Garde de session (pas de rendu anonyme).
    expect(workspace).toContain("useSessionAvailable");
    // Mode embarqué (onglet de l'espace unifié).
    expect(workspace).toContain("embedded = false");
    const consoleAutomations = read(CONSOLE_AUTOMATIONS);
    expect(consoleAutomations).toContain("<PlanificationsWorkspace embedded />");
  });

  it("/planifications redirige vers /automations#planifications (un seul parcours)", () => {
    const page = read(PAGE);
    expect(page).toContain("/automations#planifications");
    expect(page).toContain("RedirectRoute");
    const automations = read(AUTOMATIONS_PAGE);
    expect(automations).toContain("AutomationsConsole");
  });
});
