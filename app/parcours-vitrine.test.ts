import { describe, expect, it } from "vitest";

import { NAV_REGISTRY, navFor } from "@/components/shells/nav-registry";
import { classifyPagePath } from "@/lib/security/user-access";

/**
 * RESTRUCTURATION DES PARCOURS (demande propriétaire) — non-régression.
 *
 * Chaque fonctionnalité présentée sur la page de VITRINE (/vitrine —
 * l'ancienne page d'accueil, déplacée lors du repositionnement
 * « plateforme IA » style Gemini 2026-11-05) doit conduire vers
 * un espace réellement adapté à son objectif. Ce test fige la table de
 * correspondance fonctionnalité → destination pour éviter toute régression
 * vers « tous les liens vers le même chat ».
 */

const PAGE = "app/vitrine/page.tsx";
const HOME_CHAT = "app/page.tsx";
const REGISTRY = "components/shells/nav-registry.ts";
const USER_ACCESS = "lib/security/user-access.ts";

import { readFileSync } from "node:fs";
import { join } from "node:path";

const lire = (relatif: string): string => readFileSync(join(process.cwd(), relatif), "utf8");

describe("Restructuration des parcours — page vitrine", () => {
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

  it("l'entraînement de gen3 elle-même est annoncé depuis le chat (entrée unique)", () => {
    // Directive utilisateur : gen3 s'entraîne DANS le chat IA (« apprends
    // que… » → outil brain.train) ; le Laboratoire est pour les modèles
    // métier des utilisateurs — deux entraînements distincts, deux espaces.
    expect(home).toContain("DEPUIS LE CHAT IA");
    expect(home).toContain("apprends que");
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

  it("la vitrine déplacée reste une page publique (utilisateur identifié comme anonyme)", () => {
    expect(classifyPagePath("/vitrine")).toMatchObject({ access: "public" });
  });
});

/* ============================================================
   REPOSITIONNEMENT « PLATEFORME IA » (demande propriétaire
   2026-11-05 — architecture Gemini) : la RACINE est le chat.
   Avant : / était une vitrine SaaS (hero, features, pricing) —
   le produit se présentait comme un SaaS, pas comme une IA.
   Après : / ouvre directement la conversation (NovaChat), la
   vitrine vit sur /vitrine, la barre latérale du chat embarque
   « Récents » (historique groupé) + « Capacités » (les espaces
   majeurs, comme les Gems), et il n'y a qu'UNE barre latérale
   sur toutes les surfaces de chat (plus de double sidebar).
   ============================================================ */
describe("Repositionnement plateforme IA — la racine est le chat (style Gemini)", () => {
  it("app/page.tsx rend NovaChat (plus aucune vitrine marketing en racine)", () => {
    const accueil = lire(HOME_CHAT);
    expect(accueil).toContain('import NovaChat from "@/components/chat/nova-chat"');
    expect(accueil).toContain("<NovaChat />");
    expect(accueil).not.toContain("VitrineHeader");
    expect(accueil).not.toContain("CAPABILITIES");
  });

  it("la vitrine marketing vit sur /vitrine (SEO/GEO conservé)", () => {
    const vitrine = lire(PAGE);
    expect(vitrine).toContain('href: "/dashboard", label: "Chat IA"');
    expect(vitrine).toContain("buildStructuredData");
  });

  it("toutes les surfaces de chat ont UNE SEULE barre latérale (celle de NovaChat)", () => {
    // / et /dashboard sont des surfaces autonomes : AppNav ne s'empile plus
    // au-dessus de la sidebar de NovaChat (le « double sidebar » SaaS).
    const shell = lire("components/nav/app-shell.tsx");
    expect(shell).toContain('pathname === "/" ||');
    expect(shell).toContain('pathname === "/dashboard" ||');
    expect(shell).toContain('pathname === "/chat" ||');
    const surface = lire("lib/ui/chat-surface.ts");
    expect(surface).toContain('pathname === "/" ||');
    expect(surface).toContain('pathname === "/dashboard" ||');
  });

  it("la sidebar du chat embarque « Récents » (historique) et « Capacités » (plateforme)", () => {
    const nova = lire("components/chat/nova-chat.tsx");
    expect(nova).toContain(">Récents</div>");
    expect(nova).toContain(">Capacités</div>");
    // Les capacités majeures rejoignables depuis la conversation :
    for (const href of ["/neural", "/lab", "/data", "/automations", "/integrations", "/memory", "/storage", "/business"]) {
      expect(nova, `capacité ${href} absente de la sidebar`).toContain(`href: "${href}"`);
    }
    // Le lien mort /workspace est retiré du pied de sidebar.
    expect(nova).not.toContain('href="/workspace"');
  });

  it("l'entrée compte est présente en haut à droite du chat (style Gemini)", () => {
    const nova = lire("components/chat/nova-chat.tsx");
    expect(nova).toContain('className="nova-connexion"');
    expect(nova).toContain('href="/settings" className="nova-bouton-ico"');
  });
});
