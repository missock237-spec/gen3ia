import { describe, expect, it } from "vitest";

import {
  detectScheduleIntent,
  detectServiceControlIntent,
  detectWorkflowIntent,
  extraireEtapesWorkflow,
  extraireHeure,
  extraireIntervalle,
  extraireJours,
  extraireMoment,
  extraireNomCible,
  nomDepuisMessage,
} from "@/lib/domain/conversations/service-intents";

describe("détection heures/jours/intervalles", () => {
  it("extrait une heure explicite", () => {
    expect(extraireHeure("chaque lundi à 9h")).toBe("09:00");
    expect(extraireHeure("à 09:30 rapport")).toBe("09:30");
    expect(extraireHeure("tous les soirs à 21h30")).toBe("21:30");
    expect(extraireHeure("à 9h")).toBe("09:00");
  });

  it("extrait un moment flou", () => {
    expect(extraireMoment("chaque matin, fais un résumé")).toBe("08:00");
    expect(extraireMoment("le soir, envoie-moi X")).toBe("18:00");
  });

  it("extrait les jours", () => {
    expect(extraireJours("chaque jour")).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(extraireJours("du lundi au vendredi")).toEqual([1, 2, 3, 4, 5]);
    expect(extraireJours("le week-end")).toEqual([0, 6]);
    expect(extraireJours("chaque lundi")).toEqual([1]);
    expect(extraireJours("chaque vendredi et samedi")).toEqual([5, 6]);
  });

  it("extrait un intervalle", () => {
    expect(extraireIntervalle("vérifie toutes les 30 minutes")).toBe(30);
    expect(extraireIntervalle("sonde toutes les 2 heures")).toBe(120);
    expect(extraireIntervalle("toutes les demi-heures")).toBe(30);
  });
});

describe("détection de tâche planifiée", () => {
  it("détecte une planification hebdomadaire complète", () => {
    const intent = detectScheduleIntent("Chaque lundi à 9h, prépare-moi un rapport des actualités IA de la semaine");
    expect(intent).not.toBeNull();
    expect(intent!.daysOfWeek).toEqual([1]);
    expect(intent!.startTime).toBe("09:00");
    expect(intent!.endTime).toBe("23:59");
    expect(intent!.objective).toContain("rapport des actualités IA");
    expect(intent!.trigger).toBe("window");
  });

  it("détecte une planification quotidienne avec valeur par défaut honnête", () => {
    const intent = detectScheduleIntent("chaque jour, envoie-moi un résumé des ventes");
    expect(intent).not.toBeNull();
    expect(intent!.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(intent!.startTime).toBe("08:00");
    expect(intent!.trigger).toBe("window");
  });

  it("détecte un rappel par intervalle", () => {
    const intent = detectScheduleIntent("planifie une vérification du site toutes les 30 minutes");
    expect(intent).not.toBeNull();
    expect(intent!.intervalMinutes).toBe(30);
    expect(intent!.trigger).toBe("interval");
    expect(intent!.startTime).toBe("00:00");
  });

  it("ignore les demandes non récurrentes ou sans verbe d'automatisation", () => {
    expect(detectScheduleIntent("prépare-moi un rapport pour demain")).toBeNull();
    expect(detectScheduleIntent("c'est quoi une tâche planifiée ?")).toBeNull();
    expect(detectScheduleIntent("j'aime les lundi matin")).toBeNull();
  });

  it("ne détecte PAS une création quand c'est un pilotage (désactivation)", () => {
    expect(detectScheduleIntent("désactive ma tâche planifiée rapport IA")).toBeNull();
  });

  it("ignore la récurrence CONTENUE DANS LE NOM CITÉ (bug e2e prod 5/desactivation)", () => {
    // Le nom cité « Chaque lundi à 9h, prépare-moi un rapport… » contient lui
    // même des marqueurs de création : le pilotage doit gagner.
    const controle = detectServiceControlIntent(
      'désactive la tâche planifiée « Chaque lundi à 9h, prépare-moi un rapport des actualités IA »',
    );
    expect(controle).toEqual({
      target: "schedule",
      action: "disable",
      name: "Chaque lundi à 9h, prépare-moi un rapport des actualités IA",
    });
    expect(detectScheduleIntent('désactive la tâche planifiée « Chaque lundi à 9h, prépare-moi un rapport »')).toBeNull();
  });
});

describe("détection de workflow", () => {
  it("détecte une création de workflow avec étapes numérotées", () => {
    const intent = detectWorkflowIntent("crée un workflow : étape 1 : recherche les tendances marché. étape 2 : rédige un résumé. étape 3 : envoie-le par email");
    expect(intent).not.toBeNull();
    expect(intent!.steps.length).toBe(3);
    expect(intent!.steps[0]!.description).toContain("recherche les tendances");
    expect(intent!.runNow).toBe(false);
  });

  it("détecte les étapes enchaînées avec « puis »", () => {
    const intent = detectWorkflowIntent("construis un workflow de veille : scrape les concurrents puis génère un rapport puis publie-le");
    expect(intent).not.toBeNull();
    expect(intent!.steps.length).toBe(3);
  });

  it("détecte l'exécution immédiate demandée", () => {
    const intent = detectWorkflowIntent("crée un workflow et exécute-le : étape 1 : fais un résumé du marché");
    expect(intent).not.toBeNull();
    expect(intent!.runNow).toBe(true);
  });

  it("retombe sur une étape unique sans énumération", () => {
    const intent = detectWorkflowIntent("crée un workflow de suivi de stock");
    expect(intent).not.toBeNull();
    expect(intent!.steps).toHaveLength(1);
    expect(intent!.steps[0]!.description).toContain("suivi de stock");
  });

  it("ignore les questions sur les workflows", () => {
    expect(detectWorkflowIntent("c'est quoi un workflow ?")).toBeNull();
  });
});

describe("pilotage des sous-services existants", () => {
  it("détecte la liste des tâches planifiées", () => {
    const controle = detectServiceControlIntent("montre-moi mes tâches planifiées");
    expect(controle).toEqual({ target: "schedule", action: "list" });
  });

  it("détecte la désactivation avec nom cité", () => {
    const controle = detectServiceControlIntent("désactive la tâche planifiée « rapport IA »");
    expect(controle).toEqual({ target: "schedule", action: "disable", name: "rapport IA" });
  });

  it("détecte la suppression (HITL)", () => {
    const controle = detectServiceControlIntent("supprime la tâche planifiée rapport IA");
    expect(controle).toEqual({ target: "schedule", action: "delete", name: "rapport IA" });
  });

  it("détecte l'exécution d'un workflow", () => {
    const controle = detectServiceControlIntent("exécute le workflow veille concurrentielle");
    expect(controle).toEqual({ target: "workflow", action: "run", name: "veille concurrentielle" });
  });

  it("détecte la liste des workflows", () => {
    const controle = detectServiceControlIntent("affiche mes workflows");
    expect(controle).toEqual({ target: "workflow", action: "list" });
  });

  it("ignore les demandes sans sous-service", () => {
    expect(detectServiceControlIntent("supprime le fichier rapport.pdf")).toBeNull();
    expect(detectServiceControlIntent("exécute du code Python")).toBeNull();
  });
});

describe("utilitaires", () => {
  it("extrait un nom cible cité en guillemets", () => {
    expect(extraireNomCible("désactive « veille IA » s'il te plaît")).toBe("veille IA");
  });

  it("produit un nom court lisible", () => {
    const nom = nomDepuisMessage("Chaque lundi à 9h, prépare-moi un rapport des actualités IA de la semaine", "Tâche planifiée");
    expect(nom.length).toBeLessThanOrEqual(80);
    expect(nom.toLowerCase()).toContain("rapport");
  });

  it("segmente correctement des étapes numérotées", () => {
    const steps = extraireEtapesWorkflow("étape 1 : recherche. étape 2 : rédige. étape 3 : envoie");
    expect(steps).toHaveLength(3);
  });
});
