import { describe, expect, it } from "vitest";

import {
  composerPilotage,
  detecterIntentionPilotage,
  executerPilotage,
  type ChargeursPilotage,
  type DonneesPilotage,
} from "./pilote";

/** Chargeurs déterministes pour les tests (données réelles simulées). */
function chargeursDeTest(
  donnees: Partial<DonneesPilotage> = {},
  echec?: keyof ChargeursPilotage,
): ChargeursPilotage {
  const base: ChargeursPilotage = {
    automatisations: async () => donnees.automatisations ?? { total: 3, enCours: 1, aValider: 1, terminees: 1 },
    projets: async () => donnees.projets ?? { total: 2, derniers: ["Refonte site", "Veille IA"] },
    fichiers: async () => donnees.fichiers ?? { total: 5, derniers: ["offre.pdf", "clients.csv"] },
    connaissances: async () => donnees.connaissances ?? { total: 7, dernieres: ["Préférence : réponses courtes"] },
    conversations: async () => donnees.conversations ?? { total: 12 },
    entrainements: async () => donnees.entrainements ?? { total: 1, modeles: 2 },
  };
  if (echec) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (base as any)[echec] = async () => {
      throw new Error("R2 indisponible");
    };
  }
  return base;
}

describe("détection d'intention de pilotage", () => {
  it("détecte les intentions spécifiques (avec accents et formulations variées)", () => {
    expect(detecterIntentionPilotage("où en sont mes automatisations ?")).toBe("automatisations");
    expect(detecterIntentionPilotage("Mes missions en cours")).toBe("automatisations");
    expect(detecterIntentionPilotage("état de mes projets")).toBe("projets");
    expect(detecterIntentionPilotage("quels sont mes fichiers importés")).toBe("fichiers");
    expect(detecterIntentionPilotage("combien j'ai de souvenirs en mémoire")).toBe("connaissances");
    expect(detecterIntentionPilotage("liste mes conversations")).toBe("conversations");
    expect(detecterIntentionPilotage("mes entraînements ont donné quoi ?")).toBe("entrainements");
  });

  it("détecte la vue d'ensemble (globale) quand aucune cible précise", () => {
    expect(detecterIntentionPilotage("état de la plateforme")).toBe("vue_ensemble");
    expect(detecterIntentionPilotage("fais-moi un tableau de bord")).toBe("vue_ensemble");
    expect(detecterIntentionPilotage("vue d'ensemble de mon espace")).toBe("vue_ensemble");
    expect(detecterIntentionPilotage("ce que tu pilotes")).toBe("vue_ensemble");
  });

  it("les intentions SPÉCIFIQUES priment sur la vue globale", () => {
    expect(detecterIntentionPilotage("état de mes automatisations")).toBe("automatisations");
    expect(detecterIntentionPilotage("tableau de bord de mes projets")).toBe("projets");
  });

  it("retourne null hors pilotage (la conversation continue normalement)", () => {
    expect(detecterIntentionPilotage("bonjour")).toBeNull();
    expect(detecterIntentionPilotage("qui es-tu ?")).toBeNull();
    expect(detecterIntentionPilotage("génère une image de chat")).toBeNull();
    expect(detecterIntentionPilotage("")).toBeNull();
    expect(detecterIntentionPilotage("   ")).toBeNull();
  });
});

describe("composition des réponses de pilotage", () => {
  it("compose une réponse vue d'ensemble avec des chiffres réels", () => {
    const reponse = composerPilotage("vue_ensemble", {
      automatisations: { total: 3, enCours: 1, aValider: 1, terminees: 1 },
      projets: { total: 2, derniers: ["Refonte site"] },
      fichiers: { total: 5, derniers: ["offre.pdf"] },
      connaissances: { total: 7, dernieres: [] },
      conversations: { total: 12 },
      entrainements: { total: 1, modeles: 2 },
    });
    expect(reponse.source).toBe("pilotage");
    expect(reponse.texte).toContain("3");
    expect(reponse.texte).toContain("2");
    expect(reponse.texte).toContain("12");
    expect(reponse.texte).toContain("Refonte site");
  });

  it("signale honnêtement une source indisponible (fail-soft, jamais de chiffre inventé)", () => {
    const reponse = composerPilotage("vue_ensemble", {
      automatisations: undefined,
      projets: { total: 0, derniers: [] },
    });
    expect(reponse.texte).toContain("je n'ai pas pu lire cette source");
    expect(reponse.texte).toContain("aucun");
  });

  it("espace vide : propositions d'action au lieu de zéros dénués de sens", () => {
    const reponse = composerPilotage("automatisations", {
      automatisations: { total: 0, enCours: 0, aValider: 0, terminees: 0 },
    });
    expect(reponse.texte).toContain("aucune");
    expect(reponse.texte).toContain("objectif");
  });
});

describe("exécution du pilotage", () => {
  it("retourne null sans userId (honnêteté : jamais de données fabriquées)", async () => {
    const resultat = await executerPilotage(chargeursDeTest(), "état de la plateforme", {});
    expect(resultat).toBeNull();
  });

  it("retourne null hors intention de pilotage", async () => {
    const resultat = await executerPilotage(chargeursDeTest(), "bonjour", { userId: "u1" });
    expect(resultat).toBeNull();
  });

  it("exécute un pilotage ciblé avec les données réelles", async () => {
    const resultat = await executerPilotage(chargeursDeTest(), "mes automatisations ?", { userId: "u1" });
    expect(resultat).not.toBeNull();
    expect(resultat?.source).toBe("pilotage");
    expect(resultat?.texte).toContain("3");
    expect(resultat?.texte).toContain("en cours");
  });

  it("un loader en échec est capté : le reste répond, la source est signalée", async () => {
    const resultat = await executerPilotage(chargeursDeTest({}, "fichiers"), "vue d'ensemble", { userId: "u1" });
    expect(resultat).not.toBeNull();
    expect(resultat?.texte).toContain("je n'ai pas pu lire cette source");
    expect(resultat?.texte).toContain("Refonte site"); // projets lus normalement
  });
});
