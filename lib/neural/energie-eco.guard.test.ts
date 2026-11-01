/**
 * GARDE 42ᵉ (suite) — COURT-CIRCUIT ÉNERGÉTIQUE DU MOTEUR (it.73).
 *
 * Vérrou central de la demande propriétaire (« diminuer la consommation
 * d'énergie … en gardant sa qualité de réponse ») : en profils eco /
 * telephone, une question du cadre d'apprentissage reçoit LE MÊME TEXTE
 * que le profil plein (mêmes fonctions pures) — mais SANS fenêtre
 * neuronale (zéro RPIA, zéro cycle) ; une question HORS cadre prend le
 * chemin historique complet (identique). Le profil plein reste BIT À BIT
 * le comportement historique (aucune hook).
 */

import { afterEach, describe, expect, it } from "vitest";

import { createRng } from "./core/rng";
import { ReseauNeuronalGen3 } from "./core/network";
import { EspaceFiltreResonant } from "./core/resonant-space";
import { GenerateurAutoOscillation } from "./core/auto-oscillation";
import { NoyauCentralGen3 } from "./core/central-core";
import { CANAL_UTILISATEUR_IN } from "./core/types";
import { CortexLangagierGen3 } from "./generation/language";
import { HippocampusMemory } from "./memory/hippocampus";
import { NeuralEngine } from "./engine";
import type { AIRequest } from "@/lib/ai/models";

function monterMoteur(): NeuralEngine {
  const reseau = new ReseauNeuronalGen3({ seed: 1, density: 0 });
  const espace = new EspaceFiltreResonant();
  espace.registerInputPool(CANAL_UTILISATEUR_IN, [0, 1, 2]);
  const veille = new GenerateurAutoOscillation(reseau, 0.15, 0.15, createRng(11));
  const noyau = new NoyauCentralGen3(reseau, espace, veille);
  const cortex = new CortexLangagierGen3();
  const hippocampe = new HippocampusMemory(10);
  return new NeuralEngine(noyau, espace, cortex, hippocampe);
}

function requete(message: string): AIRequest {
  return { task: "chat", messages: [{ role: "user", content: message }] };
}

afterEach(() => {
  delete process.env.GEN3_PROFIL_ENERGIE;
});

describe("GARDE 42ᵉ — court-circuit éco du moteur (même texte, zéro fenêtre)", () => {
  it("question du cadre : le profil éco renvoie le MÊME texte que le plein, avec l'économie déclarée", async () => {
    delete process.env.GEN3_PROFIL_ENERGIE;
    const plein = monterMoteur();
    process.env.GEN3_PROFIL_ENERGIE = "eco";
    const eco = monterMoteur();

    const question = "Peux-tu faire une veille sur l'intelligence artificielle ?";
    const reponsePlein = await plein.generate(requete(question));
    const reponseEco = await eco.generate(requete(question));

    // QUALITÉ CONSERVÉE PAR CONSTRUCTION — testée quand même.
    expect(reponseEco.text).toBe(reponsePlein.text);
    expect(reponseEco.provider).toBe("gen3-snn");
    expect(reponseEco.model).toBe(reponsePlein.model);
    // L'économie est déclarée honnêtement (jamais une économie silencieuse).
    const brut = reponseEco.raw as { economieEnergie?: { profil: string; origine: string; cyclesNoyauEvites: number; epoquesRPIAEvitees: number } };
    expect(brut.economieEnergie?.profil).toBe("eco");
    expect(brut.economieEnergie?.origine).toBe("pont-lexical");
    expect(brut.economieEnergie?.cyclesNoyauEvites).toBe(4);
    expect(brut.economieEnergie?.epoquesRPIAEvitees).toBe(12);
    // Le plein ne porte AUCUNE télémétrie d'économie (comportement historique).
    expect((reponsePlein.raw as Record<string, unknown>).economieEnergie).toBeUndefined();
  });

  it("question du cadre en flux : même texte émis, économie déclarée", async () => {
    delete process.env.GEN3_PROFIL_ENERGIE;
    const plein = monterMoteur();
    process.env.GEN3_PROFIL_ENERGIE = "telephone";
    const telephone = monterMoteur();

    const question = "Comment planifier la culture du maïs cette saison ?";
    const fragments: string[] = [];
    const reponsePlein = await plein.generateStream(requete(question), {
      onDelta: (d) => fragments.push(d),
    });
    const fragmentsEco: string[] = [];
    const reponseEco = await telephone.generateStream(requete(question), {
      onDelta: (d) => fragmentsEco.push(d),
    });
    expect(fragmentsEco.join("")).toBe(fragmentsPleinOuFlux(fragments));
    expect(reponseEco.text).toBe(reponsePlein.text);
    const brut = reponseEco.raw as { economieEnergie?: { profil: string } };
    expect(brut.economieEnergie?.profil).toBe("telephone");
  });

  it("question HORS cadre : le chemin historique complet est pris (identique plein/éco)", async () => {
    delete process.env.GEN3_PROFIL_ENERGIE;
    const plein = monterMoteur();
    process.env.GEN3_PROFIL_ENERGIE = "eco";
    const eco = monterMoteur();

    const horsCadre = "j'adore les pizzas ananas";
    const reponsePlein = await plein.generate(requete(horsCadre));
    const reponseEco = await eco.generate(requete(horsCadre));
    expect(reponseEco.text).toBe(reponsePlein.text);
    expect((reponseEco.raw as Record<string, unknown>).economieEnergie).toBeUndefined();
  });
});

/** Le flux plein émet la réponse par segments — texte complet attendu. */
function fragmentsPleinOuFlux(fragments: string[]): string {
  return fragments.join("");
}
