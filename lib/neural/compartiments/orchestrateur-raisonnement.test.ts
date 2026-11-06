/**
 * GARDE COMPARTIMENT RAISONNEMENT (ORCHESTRATEUR) — gen3 doit raisonner à
 * CHAQUE requête (analyse → rappel → candidats → évaluation → choix
 * argumenté), solliciter le bon compartiment calculable, et JAMAIS faire
 * moins bien que le chemin historique (délégation = null, zéro régression).
 */
import { describe, expect, it } from "vitest";

import { resoudreProbleme } from "./moteur-math";
import { CompartimentMondeGen3 } from "./monde-virtuel";
import {
  CAPACITE_MEMOIRE_RAISONNEMENT,
  OrchestrateurRaisonnementGen3,
} from "./orchestrateur-raisonnement";
import { TerminalVirtuelGen3 } from "./terminal-virtuel";

const memoireFactice = {
  identifieDomaine: (motif: string) => (/\d|calcul|aire|moyenne/i.test(motif) ? "math" : null),
  etatCompartiment: (domaine: string, capacite: string) => ({
    cle: `${domaine}|${capacite}`,
    octetsPhysiques: 12_500_000,
    tauxCouverturePhysique: 0.0125,
  }),
};

function orchestrateurComplet() {
  const terminal = new TerminalVirtuelGen3({
    math: { resoudreProbleme },
    monde: new CompartimentMondeGen3(),
    memoireDomaines: {
      etatCompartiment: memoireFactice.etatCompartiment,
      sourcesDomaine: () => [],
      statistiques: () => ({ compartiments: 133, octetsReels: 0, octetsInges: 0, enseignements: 0 }),
    },
  });
  return new OrchestrateurRaisonnementGen3({
    math: { resoudreProbleme },
    monde: new CompartimentMondeGen3(),
    terminal,
    memoireDomaines: memoireFactice,
  });
}

describe("orchestrateur de raisonnement — cycle complet", () => {
  it("calc → intention exécution → le terminal répond (exit 0)", () => {
    const o = orchestrateurComplet();
    const r = o.resoudre("calc 17*23");
    expect(r).not.toBeNull();
    expect(r!.source).toBe("compartiment_terminal");
    expect(r!.texte).toContain("391");
    expect(r!.trace.intention).toBe("execution");
    expect(r!.trace.elu).toBe("terminal");
    expect(r!.trace.raison).toContain("terminal virtuel");
  });

  it("calcul en langage naturel → le compartiment math calcule avec ses étapes", () => {
    const o = orchestrateurComplet();
    const r = o.resoudre("Calcule 15 % de 240");
    expect(r).not.toBeNull();
    expect(r!.source).toBe("compartiment_math");
    expect(r!.texte).toContain("36");
    expect(r!.trace.intention).toBe("calcul");
    expect(r!.trace.domaine).toBe("math");
    expect(r!.trace.raison).toContain("CALCULÉ");
    // le rappel de la mémoire de domaines est tracé
    expect(r!.trace.rappel?.cle).toBe("math|texte");
  });

  it("question de sciences → le monde virtuel simule le phénomène", () => {
    const o = orchestrateurComplet();
    const r = o.resoudre("projectile lancé à 20 m/s avec un angle de 45 degrés");
    expect(r).not.toBeNull();
    expect(r!.source).toBe("compartiment_monde");
    expect(r!.texte).toContain("Compartiment sciences");
    expect(r!.trace.intention).toBe("simulation");
  });

  it("question de connaissance → null (délégation au chemin historique)", () => {
    const o = orchestrateurComplet();
    const r = o.resoudre("quel est le capital de la France");
    expect(r).toBeNull();
    const t = o.dernierRaisonnement();
    expect(t).not.toBeNull();
    expect(t!.intention).toBe("connaissance");
    expect(t!.elu).toBeNull();
    expect(t!.raison).toContain("connaissance");
  });

  it("compartiment sollicité sans réponse servable → délégation tracée", () => {
    const o = new OrchestrateurRaisonnementGen3({
      terminal: new TerminalVirtuelGen3(),
    });
    // « calc » vide : le terminal est sollicité mais ne sert pas (exit 1)
    const r = o.resoudre("calc");
    expect(r).toBeNull();
    const t = o.dernierRaisonnement();
    expect(t!.candidats.length).toBe(1);
    expect(t!.candidats[0]!.compartiment).toBe("terminal");
    expect(t!.candidats[0]!.servi).toBe(false);
    expect(t!.raison).toContain("sans réponse servable");
  });

  it("priorité documentée : la commande explicite prime, puis le calcul exact", () => {
    const o = orchestrateurComplet();
    // « calc 3+4*2 » adresse le terminal explicitement → terminal élu
    const a = o.resoudre("calc 3+4*2");
    expect(a!.trace.elu).toBe("terminal");
    // « 3+4*2 » sans préfixe → calcul naturel → math élu
    const b = o.resoudre("3+4*2");
    expect(b!.source).toBe("compartiment_math");
    expect(b!.texte).toContain("11");
  });
});

describe("orchestrateur de raisonnement — mémoire bornée et statistiques", () => {
  it("borne l'anneau des délibérations à CAPACITE_MEMOIRE_RAISONNEMENT", () => {
    const o = orchestrateurComplet();
    for (let i = 0; i < CAPACITE_MEMOIRE_RAISONNEMENT + 15; i++) {
      o.resoudre(`calc ${i}+1`);
    }
    expect(o.lireRaisonnements().length).toBe(CAPACITE_MEMOIRE_RAISONNEMENT);
    // la plus ancienne a été évincée : la première trace restante est i=15
    expect(o.lireRaisonnements()[0]!.requete).toContain("15+1");
  });

  it("statistiques honnêtes (résolus vs délégués, par intention)", () => {
    const o = orchestrateurComplet();
    o.resoudre("calc 1+1"); // résolu (terminal)
    o.resoudre("Calcule 12*12"); // résolu (math)
    o.resoudre("quel est le capital du Japon"); // délégué
    const s = o.statistiques();
    expect(s.total).toBe(3);
    expect(s.resolus).toBe(2);
    expect(s.delegues).toBe(1);
    expect(s.parIntention.connaissance).toBe(1);
    expect(s.tauxResolution).toBeCloseTo(2 / 3, 9);
  });

  it("refuse la requête vide sans tracer", () => {
    const o = orchestrateurComplet();
    expect(o.resoudre("   ")).toBeNull();
    expect(o.statistiques().total).toBe(0);
  });
});
