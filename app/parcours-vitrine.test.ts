import { describe, expect, it } from "vitest";

import { NAV_REGISTRY, navFor } from "@/components/shells/nav-registry";
import { classifyPagePath } from "@/lib/security/user-access";

/**
 * RESTRUCTURATION DES PARCOURS (demande propriétaire) — non-régression.
 *
 * Chaque fonctionnalité présentée sur la page d'accueil doit conduire vers
 * un espace réellement adapté à son objectif. Ce test fige la table de
 * correspondance fonctionnalité → destination pour éviter toute régression
 * vers « tous les liens vers le même chat ».
 */

const PAGE = "app/page.tsx";
const REGISTRY = "components/shells/nav-registry.ts";
const USER_ACCESS = "lib/security/user-access.ts";

import { readFileSync } from "node:fs";
import { join } from "node:path";

const lire = (relatif: string): string => readFileSync(join(process.cwd(), relatif), "utf8");

describe("Restructuration des parcours — page d'accueil", () => {
  const home = lire(PAGE);

  it("chaque capabilité pointe vers SA destination (plus de lot vers /dashboard)", () => {
    const correspondances: Array<[string, string]> = [
      ["/dashboard", "Chat IA"],
      ["/neural", "Cerveau IA"],
      ["/lab", "Entraînement de modèles"],
      ["/data", "Gestion des datasets"],
      ["/lab#evaluation", "Évaluation des modèles"],
      ["/automations", "Création d'agents"],
      ["/automations#planifications", "Tâches planifiées"],
      ["/integrations", "Connecteurs"],
      ["/developer/api", "API et SDK"],
      ["/storage", "Stockage"],
    ];
    for (const [href, label] of correspondances) {
      expect(home, `capabilité « ${label} » manquante ou mal liée`).toContain(`href: "${href}", label: "${label}"`);
    }
    // Aucun lien capabilité ne pointe /dashboard pour une autre fonctionnalité
    // que le Chat IA (le bug historique « tout mène au chat »).
    const lots = home.match(/href: "\/dashboard", label: "(?!(Chat IA))/g);
    expect(lots).toBeNull();
  });

  it("les solutions métier lancent un agent (Espace Automatisations), pas le chat", () => {
    expect(home).toContain(`href: "/automations"`);
    expect(home).toContain(`href: "/automations#planifications"`);
    expect(home).toContain(`href: "/lab"`);
  });

  it("le produit Studio d'entraînement IA ouvre le Laboratoire de modèles", () => {
    expect(home).toContain('href: "/lab"');
    expect(home).toContain("Ouvrir le Laboratoire de modèles");
  });
});

describe("Restructuration des parcours — registre de navigation", () => {
  it("les trois espaces majeurs sont des entrées PRIMARY visibles par tout utilisateur", () => {
    for (const id of ["lab", "data", "automations"]) {
      const route = NAV_REGISTRY.find((item) => item.id === id);
      expect(route, `entrée ${id} absente du registre`).toBeDefined();
      expect(route?.contexts).toContain("workspace");
      expect(route?.section).toBe("primary");
      expect(route?.minRole, `${id} doit être visible sans rôle particulier`).toBeUndefined();
    }
  });

  it("Intégrations et Bibliothèque sont des entrées SECONDARY accessibles", () => {
    for (const id of ["integrations", "storage"]) {
      const route = NAV_REGISTRY.find((item) => item.id === id);
      expect(route, `entrée ${id} absente du registre`).toBeDefined();
      expect(route?.section).toBe("secondary");
      expect(route?.minRole).toBeUndefined();
    }
  });

  it("la navigation utilisateur standard contient exactement les destinations majeures", () => {
    const hrefs = navFor("workspace", "user").map((route) => route.href);
    for (const href of ["/dashboard", "/lab", "/data", "/automations", "/integrations", "/storage", "/team", "/billing", "/settings"]) {
      expect(hrefs, `${href} doit être visible d'un compte standard`).toContain(href);
    }
    // Les surfaces expérimentales restent réservées admin.
    const ondes = NAV_REGISTRY.find((route) => route.id === "ondes");
    expect(ondes?.minRole).toBe("admin");
  });
});

describe("Restructuration des parcours — accès (middleware deny-by-default)", () => {
  const acces = lire(USER_ACCESS);

  it("les nouvelles pages sont allowlistées utilisateur", () => {
    for (const chemin of ["/lab", "/data", "/automations"]) {
      expect(classifyPagePath(chemin)).toMatchObject({ access: "user" });
    }
  });

  it("la liste reste deny-by-default pour une route inconnue", () => {
    expect(classifyPagePath("/route-inexistante-xyz")).toMatchObject({ access: "restreint" });
  });

  it("le commentaire historique de suppression est remplacé par la restauration", () => {
    expect(acces).toContain("/automations");
    expect(lire(REGISTRY)).toContain("RESTRUCTURATION DES PARCOURS");
  });
});
