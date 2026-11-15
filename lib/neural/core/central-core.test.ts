import { describe, expect, it } from "vitest";

import { ReseauNeuronalGen3 } from "./network";
import { EspaceFiltreResonant } from "./resonant-space";
import { GenerateurAutoOscillation } from "./auto-oscillation";
import { NoyauCentralGen3 } from "./central-core";
import { createRng } from "./rng";
import { CANAL_UTILISATEUR_IN } from "./types";

/**
 * NOYAU CENTRAL — tests unitaires :
 *  - homéostasie : surcharge → atténuation ×0.85 + indice 0.75 ;
 *    stagnation → micro-tonus au 1/5 des neurones + indice 0.90 ; équilibre → 1.0 ;
 *  - modes TRAITEMENT_REQUETE / AUTO_OSCILLATION_VEILLE ;
 *  - horloge virtuelle (+1.0 par cycle) ;
 *  - forme complète du CycleReport.
 */

function monterNoyau(): NoyauCentralGen3 {
  const reseau = new ReseauNeuronalGen3({ seed: 1, density: 0 });
  const espace = new EspaceFiltreResonant();
  espace.registerInputPool(CANAL_UTILISATEUR_IN, [38, 39]);
  espace.registerOutputPool("GENERER_IMAGE", [46, 47]);
  const veille = new GenerateurAutoOscillation(reseau, 0.15, 0.15, createRng(11));
  return new NoyauCentralGen3(reseau, espace, veille);
}

describe("NoyauCentralGen3 — homéostasie (verifierSanteNeuronale)", () => {
  it("surcharge (énergie moyenne > 0.75) : atténuation ×0.85 et indice 0.75", () => {
    const noyau = monterNoyau();
    for (const neurone of noyau.cerveau.neurones.values()) {
      neurone.receiveInput(1.0);
    }

    noyau.verifierSanteNeuronale();

    expect(noyau.metriquesSante.energieMoyenne).toBeCloseTo(1.0, 12);
    expect(noyau.metriquesSante.indiceHomeostasie).toBe(0.75);
    for (const neurone of noyau.cerveau.neurones.values()) {
      expect(neurone.energy).toBeCloseTo(0.85, 12);
    }
  });

  it("stagnation (énergie moyenne < 0.015) : micro-tonus au premier 1/5, indice 0.90", () => {
    const noyau = monterNoyau();
    const avant = Array.from(noyau.cerveau.neurones.values()).map(
      (n) => n.energy,
    );

    noyau.verifierSanteNeuronale();

    expect(noyau.metriquesSante.energieMoyenne).toBe(0);
    expect(noyau.metriquesSante.indiceHomeostasie).toBeCloseTo(0.9, 12);
    // 100 neurones / 5 = 20 neurones stimulés de +0.15 (les 20 premiers).
    avant.forEach((energieAvant, index) => {
      const apres = noyau.cerveau.neurones.get(index)?.energy ?? 0;
      if (index < 20) {
        expect(apres).toBeCloseTo(energieAvant + 0.15, 12);
      } else {
        expect(apres).toBe(energieAvant);
      }
    });
  });

  it("équilibre : énergie moyenne normale → indice 1.0, aucune modification", () => {
    const noyau = monterNoyau();
    for (const neurone of noyau.cerveau.neurones.values()) {
      neurone.receiveInput(0.05);
    }

    noyau.verifierSanteNeuronale();

    expect(noyau.metriquesSante.indiceHomeostasie).toBe(1);
    for (const neurone of noyau.cerveau.neurones.values()) {
      expect(neurone.energy).toBeCloseTo(0.05, 12);
    }
  });
});

describe("NoyauCentralGen3 — executerCycle", () => {
  it("sans requête : mode AUTO_OSCILLATION_VEILLE (activité autonome seedée)", () => {
    const noyau = monterNoyau();
    const rapport = noyau.executerCycle();

    expect(rapport.mode).toBe("AUTO_OSCILLATION_VEILLE");
    expect(noyau.metriquesSante.modeActuel).toBe("AUTO_OSCILLATION_VEILLE");
    expect(Array.isArray(rapport.spikedNeurones)).toBe(true);
  });

  it("avec requête : mode TRAITEMENT_REQUETE et injection via le canal", () => {
    const noyau = monterNoyau();
    const rapport = noyau.executerCycle({
      canal: CANAL_UTILISATEUR_IN,
      intensite: 1.5,
    });

    expect(rapport.mode).toBe("TRAITEMENT_REQUETE");
    // Le pool utilisateur (38, 39) reçoit 1.5 → spike au premier cycle
    // (1.5 × 0.9 = 1.35 ≥ 1.0).
    expect(rapport.spikedNeurones).toContain(38);
    expect(rapport.spikedNeurones).toContain(39);
  });

  it("inputsDirects : injection directe sur la zone de tokens (adaptation (c))", () => {
    const noyau = monterNoyau();
    const rapport = noyau.executerCycle({ inputsDirects: { 10: 2.0 } });

    expect(rapport.mode).toBe("TRAITEMENT_REQUETE");
    expect(rapport.spikedNeurones).toContain(10);
  });

  it("horloge virtuelle : avance de +1.0 unité par cycle exécuté", () => {
    const noyau = monterNoyau();
    expect(noyau.time).toBe(0);

    noyau.executerCycle();
    noyau.executerCycle();
    noyau.executerCycle();

    expect(noyau.time).toBe(3);
    // Les fenêtres de plasticité s'appuient sur cette horloge déterministe.
    expect(noyau.metriquesSante.cyclesTotaux).toBe(3);
  });

  it("CycleReport : forme complète (cycle, mode, spikes, santé, actions)", () => {
    const noyau = monterNoyau();
    const rapport = noyau.executerCycle({ inputsDirects: { 3: 1.2 } });

    expect(rapport.cycle).toBe(1);
    expect(typeof rapport.mode).toBe("string");
    expect(Array.isArray(rapport.spikedNeurones)).toBe(true);
    expect(rapport.neuronesActifs).toBe(rapport.spikedNeurones.length);
    expect(rapport.sante).toHaveProperty("cyclesTotaux", 1);
    expect(rapport.sante).toHaveProperty("energieMoyenne");
    expect(rapport.sante).toHaveProperty("indiceHomeostasie");
    expect(rapport.sante).toHaveProperty("modeActuel", "TRAITEMENT_REQUETE");
    expect(Array.isArray(rapport.actionsCorps)).toBe(true);

    // Cycle suivant : compteur incrémenté, rapport indépendant.
    const rapport2 = noyau.executerCycle();
    expect(rapport2.cycle).toBe(2);
    expect(rapport.sante.cyclesTotaux).toBe(1);
  });

  it("enregistrerEffecteur : les actions du corps remontent dans le rapport", () => {
    const noyau = monterNoyau();
    noyau.enregistrerEffecteur({
      nom: "effecteur_bidon",
      evaluerEtExecuter: () => [
        { type: "TEST", status: "SUCCES", details: "action réelle de test" },
      ],
    });

    const rapport = noyau.executerCycle();

    expect(rapport.actionsCorps).toHaveLength(1);
    expect(rapport.actionsCorps[0].type).toBe("TEST");
    expect(rapport.actionsCorps[0].status).toBe("SUCCES");
  });
});
