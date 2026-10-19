import { describe, expect, it } from "vitest";

import { AgentCalcul, AgentCode, AgentTri, AgentVeille } from "../agents-specialises";
import { CortexGen3Local, OrchestrateurAgents } from "../orchestrateur";
import type { ChargeBattement, ChargeResultat, MessageAgent } from "../types";

describe("CortexGen3Local — l'IA principale voit tout", () => {
  it("reçoit le compte-rendu de chaque tâche terminée", () => {
    const cortex = new CortexGen3Local();
    const orchestrateur = new OrchestrateurAgents({ idNoeud: "n1", ia: cortex });
    orchestrateur.enregistrerAgent(new AgentCalcul());
    orchestrateur.ouvrirTache("calcul", { expression: "2^10" });

    const etat = cortex.etat();
    expect(etat.nbRapports).toBe(1);
    expect(etat.dernierResume).toContain("1024");
    expect(etat.confianceMoyenne).toBeGreaterThan(0.9);
  });

  it("ordonne une tâche de suivi après une rupture de veille", () => {
    const cortex = new CortexGen3Local();
    const orchestrateur = new OrchestrateurAgents({ idNoeud: "n1", ia: cortex });
    cortex.rattacher((tache) => {
      orchestrateur.ouvrirTache(tache.type, tache.charge, tache.priorite);
    });
    orchestrateur.enregistrerAgent(new AgentVeille());
    orchestrateur.enregistrerAgent(new AgentTri());

    orchestrateur.ouvrirTache("veille", {
      sujet: "réseau",
      avant: [{ cle: "pair-x", valeur: "vivant" }],
      apres: [{ cle: "pair-x", valeur: "muté" }],
    });

    // Le cortex a réagi : une décision consignée + une tâche de tri ouverte.
    const etat = cortex.etat();
    expect(etat.decisions.length).toBeGreaterThan(0);
    expect(etat.decisions[0].motif).toContain("Rupture");
    // La tâche de suivi a été ouverte via l'orchestrateur (compte à 2 ouvertes).
    expect(orchestrateur.statistiques.tachesOuvres).toBe(2);
  });

  it("consigne une mise en garde sur du code risqué sans exécuter quoi que ce soit", () => {
    const cortex = new CortexGen3Local();
    const orchestrateur = new OrchestrateurAgents({ idNoeud: "n1", ia: cortex });
    orchestrateur.enregistrerAgent(new AgentCode());

    orchestrateur.ouvrirTache("code", { code: "eval('1')" });
    const etat = cortex.etat();
    expect(etat.decisions[0].motif).toContain("Code risqué");
    // Pas de tâche de suivi automatique pour le code risqué.
    expect(orchestrateur.statistiques.tachesOuvres).toBe(1);
  });
});

describe("OrchestrateurAgents — distribution et déduplication", () => {
  it("exécute localement quand la spécialité est présente", () => {
    const cortex = new CortexGen3Local();
    const orchestrateur = new OrchestrateurAgents({ idNoeud: "n1", ia: cortex });
    orchestrateur.enregistrerAgent(new AgentCalcul());

    const tache = orchestrateur.ouvrirTache("calcul", { expression: "9 * 9" });
    expect(tache.statut).toBe("terminee");
    expect(tache.resultat?.donnees?.valeur).toBe(81);
    expect(orchestrateur.statistiques.tachesExecutees).toBe(1);
  });

  it("avoue la diffusion pure quand la spécialité manque", () => {
    const cortex = new CortexGen3Local();
    const orchestrateur = new OrchestrateurAgents({ idNoeud: "n1", ia: cortex });
    orchestrateur.enregistrerAgent(new AgentCalcul());

    const tache = orchestrateur.ouvrirTache("code", { code: "x" });
    expect(tache.statut).toBe("en-attente");
    expect(orchestrateur.fileLocale.length).toBe(0);
  });

  it("refuse une charge trop lourde (plafond honnête)", () => {
    const cortex = new CortexGen3Local();
    const orchestrateur = new OrchestrateurAgents({ idNoeud: "n1", ia: cortex });
    expect(() =>
      orchestrateur.ouvrirTache("tri", { elements: ["x".repeat(9 * 1024)] }),
    ).toThrow(/trop lourd/i);
  });

  it("premier résultat gagne : un doublon de résultat est ignoré", () => {
    const cortex = new CortexGen3Local();
    const orchestrateur = new OrchestrateurAgents({ idNoeud: "n1", ia: cortex });
    orchestrateur.enregistrerAgent(new AgentCalcul());

    const tache = orchestrateur.ouvrirTache("calcul", { expression: "1 + 1" });
    expect(cortex.etat().nbRapports).toBe(1);

    // Un nœud distant renvoie UN AUTRE résultat pour la même tâche.
    const message: MessageAgent = {
      v: 1,
      mid: "m-doublon",
      de: "n-distant",
      type: "resultat",
      charge: {
        tacheId: tache.id,
        type: "calcul",
        resultat: { resume: "résultat concurrent", confiance: 0.9 },
        noeud: "n-distant",
      } satisfies ChargeResultat,
      ttl: 2,
      ts: Date.now(),
    };
    orchestrateur.traiterMessage(message);

    // Le cortex n'a reçu qu'UN compte-rendu (le local, arrivé premier).
    expect(cortex.etat().nbRapports).toBe(1);
    expect(cortex.etat().dernierResume).not.toContain("concurrent");
  });

  it("exécute une tâche reçue par onde et renvoie le compte-rendu au cortex émetteur", () => {
    const cortex = new CortexGen3Local();
    const orchestrateur = new OrchestrateurAgents({ idNoeud: "n-local", ia: cortex });
    orchestrateur.enregistrerAgent(new AgentCalcul());

    const message: MessageAgent = {
      v: 1,
      mid: "m-tache",
      de: "n-emetteur",
      type: "tache",
      charge: {
        tache: {
          id: "t-distante-1",
          type: "calcul",
          charge: { expression: "3 + 4" },
          priorite: "normale",
          emiseA: Date.now(),
          emetteur: "n-emetteur",
          statut: "en-attente",
          delaiMs: 6000,
        },
      },
      ttl: 2,
      ts: Date.now(),
    };
    orchestrateur.traiterMessage(message);

    // La tâche distante est terminée localement mais NE remonte PAS au
    // cortex local (elle appartient au cortex émetteur).
    expect(cortex.etat().nbRapports).toBe(0);
    expect(orchestrateur.statistiques.tachesExecutees).toBe(1);
  });

  it("déduplique les tâches reçues deux fois par cascade", () => {
    const cortex = new CortexGen3Local();
    const orchestrateur = new OrchestrateurAgents({ idNoeud: "n1", ia: cortex });
    orchestrateur.enregistrerAgent(new AgentCalcul());

    const fabrication = (mid: string): MessageAgent => ({
      v: 1,
      mid,
      de: "n-emetteur",
      type: "tache",
      charge: {
        tache: {
          id: "t-meme",
          type: "calcul",
          charge: { expression: "5" },
          priorite: "normale",
          emiseA: Date.now(),
          emetteur: "n-emetteur",
          statut: "en-attente",
          delaiMs: 6000,
        },
      },
      ttl: 2,
      ts: Date.now(),
    });

    orchestrateur.traiterMessage(fabrication("m1"));
    orchestrateur.traiterMessage(fabrication("m2"));
    expect(orchestrateur.statistiques.tachesExecutees).toBe(1);
  });
});

describe("OrchestrateurAgents — ré-attribution (SOS)", () => {
  it("accepte un SOS et exécute la tâche orpheline", () => {
    const cortex = new CortexGen3Local();
    const orchestrateur = new OrchestrateurAgents({ idNoeud: "n-relais", ia: cortex });
    orchestrateur.enregistrerAgent(new AgentCalcul());

    const message: MessageAgent = {
      v: 1,
      mid: "m-sos",
      de: "n-secouriste",
      type: "sos",
      charge: {
        tache: {
          id: "t-orphan",
          type: "calcul",
          charge: { expression: "100 / 4" },
          priorite: "haute",
          emiseA: Date.now(),
          emetteur: "n-cortex-original",
          statut: "orpheline",
          delaiMs: 6000,
        },
        noeudPerdu: "n-mort",
        generation: 1,
      },
      ttl: 2,
      ts: Date.now(),
    };
    orchestrateur.traiterMessage(message);
    expect(orchestrateur.statistiques.tachesExecutees).toBe(1);
  });
});

describe("OrchestrateurAgents — ondes de vie", () => {
  it("traque les nœuds distants par battement et balaie les orphelines", () => {
    const cortex = new CortexGen3Local();
    const orchestrateur = new OrchestrateurAgents({ idNoeud: "n1", ia: cortex });
    orchestrateur.enregistrerAgent(new AgentCalcul());

    const battement: MessageAgent = {
      v: 1,
      mid: "m-battement",
      de: "n-vivant",
      type: "battement",
      charge: { amplitude: 0.9, capacite: 1, tachesEnCours: 0 } satisfies ChargeBattement,
      ttl: 2,
      ts: Date.now(),
    };
    orchestrateur.traiterMessage(battement);
    expect(orchestrateur.noeudsConnus).toHaveLength(1);
    expect(orchestrateur.noeudsConnus[0].amplitude).toBeCloseTo(0.9);

    // Une tâche "en cours" attribuée à ce nœud vivant n'est PAS orpheline.
    orchestrateur.ouvrirTache("calcul", { expression: "1" });
    const orphelines = orchestrateur.balayer();
    expect(orphelines).toHaveLength(0);
  });

  it("expose les statistiques et spécialités locales", () => {
    const cortex = new CortexGen3Local();
    const orchestrateur = new OrchestrateurAgents({ idNoeud: "n1", ia: cortex });
    orchestrateur.enregistrerAgent(new AgentCalcul());
    orchestrateur.enregistrerAgent(new AgentVeille());

    expect(orchestrateur.specialitesLocales.sort()).toEqual(["calcul", "veille"]);
    expect(orchestrateur.listeMicroAgents).toHaveLength(2);

    orchestrateur.ouvrirTache("calcul", { expression: "7" });
    const stats = orchestrateur.statistiques;
    expect(stats.tachesOuvres).toBe(1);
    expect(stats.tachesExecutees).toBe(1);
    expect(stats.comptesRendus).toBe(1);
    expect(stats.fileLocale).toBe(0);
  });
});
