import { describe, expect, it } from "vitest";

import {
  detectAgentIntent,
  extraireNomAgent,
  extraireSpecialite,
} from "./agent-intents";

/**
 * Verrouillage du détecteur d'intentions « agents » (langage naturel) :
 * les fonctionnalités d'agents IA passent sous la commande de l'IA.
 * Principe anti-hallucination : la détection ne retourne QUE ce que
 * l'utilisateur a énoncé — question informative = JAMAIS une action.
 */
describe("detectAgentIntent — création", () => {
  it("crée un agent typé avec nom énoncé", () => {
    const intent = detectAgentIntent("Crée-moi un agent commercial nommé Alex");
    expect(intent).toEqual({ action: "create", name: "Alex", typeKey: "sales" });
  });

  it("crée un agent de code sans nom (nom de repli honnête)", () => {
    const intent = detectAgentIntent("crée un agent de code");
    expect(intent?.action).toBe("create");
    if (intent?.action === "create") {
      expect(intent.typeKey).toBe("code");
      expect(intent.name).toContain("Agent");
    }
  });

  it("détecte la spécialité libre énoncée (type personnalisé)", () => {
    const intent = detectAgentIntent("je veux un agent spécialisé en immobilier");
    expect(intent?.action).toBe("create");
    if (intent?.action === "create") {
      expect(intent.typeKey).toBe("custom");
      expect(intent.customType).toBe("immobilier");
    }
  });

  it("reconnaît les variantes marketing et vocal", () => {
    const marketing = detectAgentIntent("génère un agent marketing pour mes réseaux sociaux");
    expect(marketing?.action).toBe("create");
    if (marketing?.action === "create") expect(marketing.typeKey).toBe("marketing");

    const vocal = detectAgentIntent("mets en place un agent vocal pour le standard");
    expect(vocal?.action).toBe("create");
    if (vocal?.action === "create") expect(vocal.typeKey).toBe("voice");
  });

  it("extrait le nom entre guillemets", () => {
    const intent = detectAgentIntent("crée un agent nommé « Sarah » spécialisé en enseignement");
    expect(intent?.action).toBe("create");
    if (intent?.action === "create") {
      expect(intent.name).toBe("Sarah");
      expect(intent.typeKey).toBe("teaching");
    }
  });
});

describe("detectAgentIntent — pilotage d'agents existants", () => {
  it("liste les agents", () => {
    expect(detectAgentIntent("liste mes agents")).toEqual({ action: "list" });
    expect(detectAgentIntent("quels sont mes agents ?")).toEqual({ action: "list" });
    expect(detectAgentIntent("affiche mes agents IA")).toEqual({ action: "list" });
  });

  it("supprime un agent nommé", () => {
    const intent = detectAgentIntent("supprime l'agent Alex");
    expect(intent).toEqual({ action: "delete", name: "Alex" });
  });

  it("désactive et active un agent", () => {
    expect(detectAgentIntent("désactive l'agent Alex")).toEqual({ action: "disable", name: "Alex" });
    expect(detectAgentIntent("réactive l'agent Alex")).toEqual({ action: "enable", name: "Alex" });
  });

  it("demande la cible quand le nom manque (suppression)", () => {
    const intent = detectAgentIntent("supprime un agent");
    expect(intent?.action).toBe("delete");
    expect(intent).not.toHaveProperty("name");
  });
});

describe("detectAgentIntent — gardes anti-faux positifs", () => {
  it("ne déclenche PAS sur une question informative", () => {
    expect(detectAgentIntent("c'est quoi un agent IA ?")).toBeNull();
    expect(detectAgentIntent("comment créer un agent ?")).toBeNull();
    expect(detectAgentIntent("peux-tu m'expliquer la différence entre Gen IA et un agent ?")).toBeNull();
  });

  it("ne déclenche PAS sur un contenu cité", () => {
    expect(detectAgentIntent('j\'ai écrit « crée un agent » dans mes notes')).toBeNull();
  });

  it("ne déclenche PAS hors sujet (workflow, tâche planifiée)", () => {
    expect(detectAgentIntent("crée un workflow de prospection")).toBeNull();
    expect(detectAgentIntent("chaque lundi, prépare-moi un rapport")).toBeNull();
  });

  it("ne déclenche PAS sur une simple évocation", () => {
    expect(detectAgentIntent("mon agent préféré est Jarvis dans Iron Man")).toBeNull();
  });
});

describe("extractions", () => {
  it("extraireNomAgent trouve le nom collé au mot agent", () => {
    expect(extraireNomAgent("désactive l'agent Sarah maintenant")).toBe("Sarah");
    expect(extraireNomAgent("active mon agent Bruno")).toBe("Bruno");
  });

  it("extraireSpecialite isole la spécialité énoncée", () => {
    expect(extraireSpecialite("crée un agent spécialisé dans la gestion de patrimoine")).toBe("gestion de patrimoine");
    expect(extraireSpecialite("un agent qui gère mes factures")).toBe("factures");
  });
});
