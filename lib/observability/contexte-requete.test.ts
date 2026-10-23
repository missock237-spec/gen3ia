import { describe, expect, it } from "vitest";

/**
 * Tests du contexte de requête AsyncLocalStorage (Task K) : héritage async,
 * enrichissement tenant, champs pino (mixin) et propagation W3C sortante.
 */

import {
  contextePino,
  contexteRequeteCourant,
  definirContexteRequeteTenant,
  executerAvecContexteRequete,
  traceIdRequeteCourant,
  traceparentPourPropagation,
} from "./contexte-requete";

const W3C_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

describe("executerAvecContexteRequete — héritage async", () => {
  it("le contexte est visible dans TOUTE la chaîne async en dessous", async () => {
    await executerAvecContexteRequete({ traceId: "trc_heritage", route: "/api/chat" }, async () => {
      await Promise.resolve();
      expect(contexteRequeteCourant()?.traceId).toBe("trc_heritage");
      expect(contexteRequeteCourant()?.route).toBe("/api/chat");
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(traceIdRequeteCourant()).toBe("trc_heritage");
    });
    // Hors run : plus de contexte (pas de fuite entre requêtes).
    expect(traceIdRequeteCourant()).toBeUndefined();
  });

  it("valeur de retour et exceptions préservées", () => {
    const valeur = executerAvecContexteRequete({ traceId: "trc_retour" }, () => 42);
    expect(valeur).toBe(42);
    expect(() =>
      executerAvecContexteRequete({ traceId: "trc_erreur" }, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
  });

  it("contextes imbriqués : le plus profond gagne, puis restitution", () => {
    executerAvecContexteRequete({ traceId: "trc_exterieur" }, () => {
      executerAvecContexteRequete({ traceId: "trc_interieur" }, () => {
        expect(traceIdRequeteCourant()).toBe("trc_interieur");
      });
      expect(traceIdRequeteCourant()).toBe("trc_exterieur");
    });
  });
});

describe("contextePino — champs de corrélation pour le mixin pino", () => {
  it("hors contexte : {} (aucune clé inventée)", () => {
    expect(contextePino()).toEqual({});
  });

  it("dans le contexte : traceId + dimensions connues seulement", () => {
    executerAvecContexteRequete({ traceId: "trc_pino", route: "/api/agents" }, () => {
      expect(contextePino()).toEqual({ traceId: "trc_pino", route: "/api/agents" });
      // Enrichissement tenant APRÈS auth : les logs suivants le portent.
      definirContexteRequeteTenant({ orgId: "org-7", userId: "u-9" });
      expect(contextePino()).toEqual({
        traceId: "trc_pino",
        route: "/api/agents",
        orgId: "org-7",
        userId: "u-9",
      });
    });
  });

  it("enrichissement hors requête : no-op silencieux", () => {
    expect(() => definirContexteRequeteTenant({ orgId: "org-orphelin" })).not.toThrow();
    expect(contextePino()).toEqual({});
  });
});

describe("traceparentPourPropagation — en-tête W3C sortant", () => {
  it("hors requête instrumentée : undefined (l'appelant omet l'en-tête)", () => {
    expect(traceparentPourPropagation()).toBeUndefined();
  });

  it("dans une requête : traceparent valide dérivé du traceId courant", () => {
    executerAvecContexteRequete({ traceId: "trc_sortant-1" }, () => {
      const premier = traceparentPourPropagation();
      const second = traceparentPourPropagation();
      expect(premier).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      // Nouveau span-id par APPEL sortant (chaque saut = un span distinct).
      expect(second).not.toBe(premier);
      expect(premier!.split("-")[1]).not.toBe("trc_sortant-1");
    });
  });

  it("traceId déjà en 32 hex W3C : propagation en identité directe", () => {
    executerAvecContexteRequete({ traceId: W3C_TRACE_ID }, () => {
      expect(traceparentPourPropagation()?.split("-")[1]).toBe(W3C_TRACE_ID);
    });
  });
});
