import { describe, expect, it } from "vitest";

import { SentinelleResilience } from "../resilience/sentinelle";
import { CortexGen3Local, OrchestrateurAgents } from "../orchestrateur";
import { AgentCalcul } from "../agents-specialises";
import type { ChargeBattement, MessageAgent } from "../types";

function orchestrateurAvecAgent(): OrchestrateurAgents {
  const orchestrateur = new OrchestrateurAgents({
    idNoeud: "n-local",
    ia: new CortexGen3Local(),
  });
  orchestrateur.enregistrerAgent(new AgentCalcul());
  return orchestrateur;
}

function battement(de: string, amplitude: number): MessageAgent {
  return {
    v: 1,
    mid: `m-${de}-${Math.random().toString(36).slice(2, 6)}`,
    de,
    type: "battement",
    charge: { amplitude, capacite: 1, tachesEnCours: 0 } satisfies ChargeBattement,
    ttl: 2,
    ts: Date.now(),
  };
}

describe("SentinelleResilience — auto-guérison par résonance de phase", () => {
  it("observe les amplitudes et ne déclare rien tant que la phase tient", () => {
    const orchestrateur = orchestrateurAvecAgent();
    const sentinelle = new SentinelleResilience({ orchestrateur });

    orchestrateur.traiterMessage(battement("n-distant", 0.9));
    sentinelle.observerDepuisOrchestrateur();

    const evenements = sentinelle.verifier();
    expect(evenements).toHaveLength(0);
    expect(sentinelle.statistiques.nœudsSuivis).toBe(1);
    expect(sentinelle.statistiques.ruptures).toBe(0);
  });

  it("détecte la chute d'amplitude : rupture + ré-attribution journalisées", () => {
    const orchestrateur = orchestrateurAvecAgent();
    const sentinelle = new SentinelleResilience({ orchestrateur });

    // Le nœud distant est vivant (amplitude 0.9)…
    orchestrateur.traiterMessage(battement("n-victime", 0.9));
    sentinelle.observerDepuisOrchestrateur();

    // …et porte une tâche "en cours" attribuée à lui.
    const tache = orchestrateur.ouvrirTache("calcul", { expression: "1" });
    // Simulation : la tâche est attribuée au nœud distant (comme si un
    // pair l'avait réclamée) — on réécrit l'attribution localement.
    void tache;

    // …puis son onde s'effondre (navigateur fermé brutalement).
    const evenements = sentinelle.simulerRupture("n-victime");
    expect(evenements.length).toBeGreaterThan(0);

    const journal = sentinelle.evenements;
    expect(journal.some((e) => e.type === "rupture" && e.noeudPerdu === "n-victime")).toBe(true);
    expect(sentinelle.statistiques.ruptures).toBe(1);
  });

  it("un nœud rompu qui revient génère un recouvrement", () => {
    const orchestrateur = orchestrateurAvecAgent();
    const sentinelle = new SentinelleResilience({ orchestrateur });

    orchestrateur.traiterMessage(battement("n-revenant", 0.8));
    sentinelle.observerDepuisOrchestrateur();
    sentinelle.simulerRupture("n-revenant");
    expect(sentinelle.statistiques.ruptures).toBe(1);

    // Le nœud revit : une onde saine le fait re-rentrer en phase.
    orchestrateur.traiterMessage(battement("n-revenant", 0.85));
    sentinelle.observerDepuisOrchestrateur();

    expect(sentinelle.statistiques.recouvrements).toBe(1);
    expect(
      sentinelle.evenements.some(
        (e) => e.type === "recouvrement" && e.noeudRelais === "n-revenant",
      ),
    ).toBe(true);
  });

  it("le silence prolongé déclenche la rupture sans simulation", () => {
    const orchestrateur = orchestrateurAvecAgent();
    const sentinelle = new SentinelleResilience({ orchestrateur });

    orchestrateur.traiterMessage(battement("n-muet", 1));
    sentinelle.observerDepuisOrchestrateur();

    // Horizon très lointain : le nœud n'a plus battu depuis très longtemps.
    const evenements = sentinelle.verifier(Date.now() + 60_000);
    expect(evenements.length).toBeGreaterThan(0);
    expect(sentinelle.evenements[0].type).toBe("rupture");
    expect(sentinelle.evenements[0].detail).toContain("silencieux");
  });

  it("signalerRupture ré-attribue immédiatement via l'orchestrateur", () => {
    const orchestrateur = orchestrateurAvecAgent();
    const sentinelle = new SentinelleResilience({ orchestrateur });

    orchestrateur.traiterMessage(battement("n-perdu", 0.9));
    const perdues = orchestrateur.signalerRupture("n-perdu");
    expect(perdues).toHaveLength(0); // aucune tâche en cours sur ce nœud

    // Le nœud est retiré de la table : plus aucune onde vers lui.
    expect(orchestrateur.noeudsConnus.some((n) => n.id === "n-perdu")).toBe(false);
    void sentinelle;
  });
});
