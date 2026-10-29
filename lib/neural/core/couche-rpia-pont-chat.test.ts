import { describe, expect, it } from "vitest";

import type { AIRequest } from "@/lib/ai/models";

import { createRng } from "./rng";
import { EspaceFiltreResonant } from "./resonant-space";
import { GenerateurAutoOscillation } from "./auto-oscillation";
import { NoyauCentralGen3 } from "./central-core";
import { ReseauNeuronalGen3 } from "./network";
import { CANAL_UTILISATEUR_IN } from "./types";
import { HippocampusMemory } from "../memory/hippocampus";
import { NeuralEngine } from "../engine";
import type { CortexLangagierGen3 } from "../generation/language";
import { CoucheOndesNeuronales } from "./couche-rpia";
import { INTENSITE_MAX_PAR_NEURONE } from "../encoding/text-encoder";

/**
 * PONT RPIA → FLUX DU CHAT : chaque message utilisateur est mis en
 * résonance sur la couche d'ondes (RPIA), les énergies obtenues sont
 * fusionnées dans la volée unique du cycle 1, et la télémétrie honnête
 * transite dans `raw.rpia`. Vérifié ici au niveau du moteur (le même que
 * celui que le routeur IA — unique voie du chat — appelle).
 */

function monterMoteur(options?: { avecCoucheRPIA?: boolean }): {
  engine: NeuralEngine;
  couche: CoucheOndesNeuronales | undefined;
} {
  const reseau = new ReseauNeuronalGen3({ seed: 1, density: 0 });
  const espace = new EspaceFiltreResonant();
  espace.registerInputPool(CANAL_UTILISATEUR_IN, [0, 1, 2]);
  espace.registerOutputPool("INTENTION_GENERALE", [3, 4, 5]);
  const veille = new GenerateurAutoOscillation(reseau, 0.15, 0.15, createRng(11));
  const noyau = new NoyauCentralGen3(reseau, espace, veille);

  const cortex = {
    repondre: () => null, // le décodeur prend le relais (composition honnête)
    tailleVocabulaire: 0,
  } as unknown as CortexLangagierGen3;

  const couche =
    options?.avecCoucheRPIA === false
      ? undefined
      : new CoucheOndesNeuronales(reseau.config.size, { graine: 45 });

  const engine = new NeuralEngine(
    noyau,
    espace,
    cortex,
    new HippocampusMemory(10),
    undefined,
    undefined,
    undefined,
    couche,
  );
  return { engine, couche };
}

function requete(message: string): AIRequest {
  return {
    task: "chat",
    messages: [
      { role: "system", content: "Tu es gen3, l'IA du système neuronal." },
      { role: "user", content: message },
    ],
  };
}

describe("NeuralEngine — couche RPIA branchée au flux du chat", () => {
  it("un tour de chat met le message en résonance (télémétrie raw.rpia)", async () => {
    const { engine } = monterMoteur();
    const reponse = await engine.generate(requete("bonjour gen3, comment vas-tu ?"));

    const rpia = reponse.raw.rpia;
    expect(rpia).not.toBeNull();
    if (!rpia) return;
    // Époques bornées (latence du tour) — la constante du moteur.
    expect(rpia.epoques).toBe(12);
    // Des neurones ont réellement reçu les énergies de résonance.
    expect(rpia.noeudsEnergises).toBeGreaterThan(0);
    // Erreurs mesurées, finies, cohérentes avec un rapport honnête.
    expect(Number.isFinite(rpia.erreurInitiale)).toBe(true);
    expect(Number.isFinite(rpia.erreurFinale)).toBe(true);
    expect(rpia.erreurInitiale).toBeGreaterThanOrEqual(0);
    expect(typeof rpia.convergence).toBe("boolean");
    // Le temps global de la couche a avancé (état persistant).
    expect(rpia.pasTotaux).toBeGreaterThan(0);
  });

  it("isole l'apprentissage RPIA par compte et conversation", async () => {
    const { engine, couche } = monterMoteur();
    const requeteScopee = (
      message: string,
      userId: string,
      conversationId: string,
    ): AIRequest => ({
      ...requete(message),
      metadata: { userId, conversationId },
    });

    const premiere = await engine.generate(
      requeteScopee("question alpha", "compte-a", "conversation-1"),
    );
    const seconde = await engine.generate(
      requeteScopee("question beta", "compte-a", "conversation-1"),
    );
    const autreConversation = await engine.generate(
      requeteScopee("question gamma", "compte-a", "conversation-2"),
    );
    const autreCompte = await engine.generate(
      requeteScopee("question delta", "compte-b", "conversation-1"),
    );

    const pasPremiere = premiere.raw.rpia?.pasTotaux ?? 0;
    expect(pasPremiere).toBe(12);
    expect(seconde.raw.rpia?.pasTotaux).toBe(pasPremiere + 12);
    // Une conversation neuve repart de la couche de base, pas des poids
    // entraînés par la conversation précédente.
    expect(autreConversation.raw.rpia?.pasTotaux).toBe(pasPremiere);
    // Un autre compte reste isolé, même avec le même ID de conversation.
    expect(autreCompte.raw.rpia?.pasTotaux).toBe(pasPremiere);
    // Les conversations authentifiées ne mutent pas l'état de base partagé.
    expect(couche?.pasTotaux).toBe(0);
  });

  it("la résonance est PERSISTANTE pour les appels sans identité", async () => {
    const { engine } = monterMoteur();
    const r1 = await engine.generate(requete("première question"));
    const r2 = await engine.generate(requete("deuxième question différente"));
    const p1 = r1.raw.rpia?.pasTotaux ?? 0;
    const p2 = r2.raw.rpia?.pasTotaux ?? 0;
    expect(p2).toBeGreaterThan(p1);
  });

  it("le MESSAGE est mis en résonance, pas la charte système", async () => {
    // Deux requêtes avec des chartes système différentes mais le même
    // message → la même onde cible (conditionneur déterministe) → les
    // mêmes énergies à l'injection (le pas total avance, l'erreur aussi).
    const { engine } = monterMoteur();
    const a = await engine.generate({
      task: "chat",
      messages: [
        { role: "system", content: "Charte A très longue qui ne doit PAS résonner." },
        { role: "user", content: "état de mes automatisations" },
      ],
    });
    const b = await engine.generate({
      task: "chat",
      messages: [
        { role: "system", content: "Charte B différente." },
        { role: "user", content: "état de mes automatisations" },
      ],
    });
    expect(a.raw.rpia?.noeudsEnergises).toBe(b.raw.rpia?.noeudsEnergises);
    expect(a.raw.rpia?.epoques).toBe(b.raw.rpia?.epoques);
  });

  it("sans couche RPIA (tests, intégrations minimales) : raw.rpia est null", async () => {
    const { engine } = monterMoteur({ avecCoucheRPIA: false });
    const reponse = await engine.generate(requete("bonjour sans ondes"));
    expect(reponse.raw.rpia).toBeNull();
  });

  it("generateStream expose la même télémétrie RPIA", async () => {
    const { engine } = monterMoteur();
    const fragments: string[] = [];
    const reponse = await engine.generateStream(requete("raconte-moi les ondes"), {
      onDelta: (d) => fragments.push(d),
    });
    expect(fragments.length).toBeGreaterThan(0);
    expect(reponse.raw.rpia).not.toBeNull();
    expect(reponse.raw.rpia?.epoques).toBe(12);
  });

  it("streamDeltas expose la même télémétrie RPIA", async () => {
    const { engine } = monterMoteur();
    const fragments: string[] = [];
    const generator = engine.streamDeltas(requete("cycle par cycle"));
    let final = await generator.next();
    while (!final.done) {
      fragments.push(final.value);
      final = await generator.next();
    }
    expect(fragments.length).toBeGreaterThan(0); // fragments de cycles + texte
    expect(final.value.raw.rpia).not.toBeNull();
    expect(final.value.raw.rpia?.epoques).toBe(12);
  });

  it("les énergies fusionnées respectent le plafond de l'encodage", async () => {
    // Fusion : min(INTENSITE_MAX_PAR_NEURONE, inputs + énergie). La couche
    // produit des énergies ≤ 0.5 — un plafond dépassé serait un bug.
    const couche = new CoucheOndesNeuronales(100, { graine: 45 });
    const { energies } = couche.resonnerVersTexte("plafond des énergies", 12);
    for (const energie of Object.values(energies)) {
      expect(energie).toBeLessThanOrEqual(0.5 + 1e-9);
    }
    // Et le plafond d'injection du moteur est celui de l'encodage.
    expect(INTENSITE_MAX_PAR_NEURONE).toBe(3.0);
  });

  it("un message vide et sans charte ne met RIEN en résonance (garde honnête)", async () => {
    const { engine } = monterMoteur();
    const reponse = await engine.generate({
      task: "chat",
      messages: [{ role: "user", content: "   " }],
    });
    // Rien à mettre en résonance : la télémétrie reste null (jamais un
    // chiffre inventé) et le moteur tourne normalement.
    expect(reponse.raw.rpia).toBeNull();
  });

  it("sans message utilisateur, la charte système sert de repli de résonance", async () => {
    // Design cohérent avec le cortex : extraireDernierMessageUtilisateur
    // retombe sur le système — la résonance suit la même règle.
    const { engine } = monterMoteur();
    const reponse = await engine.generate({
      task: "chat",
      messages: [{ role: "system", content: "Charte seule qui devient la cible." }],
    });
    expect(reponse.raw.rpia).not.toBeNull();
    expect(reponse.raw.rpia?.epoques).toBe(12);
  });
});

describe("CoucheOndesNeuronales — API de résonance de chat", () => {
  it("resonnerVersTexte retourne rapport + énergies en un appel", () => {
    const couche = new CoucheOndesNeuronales(100, { graine: 42 });
    const avant = couche.pasTotaux;
    const { rapport, energies } = couche.resonnerVersTexte("question de chat", 8);
    expect(rapport.epoques).toBe(8);
    expect(rapport.historiqueErreur.length).toBe(8);
    expect(Object.keys(energies).length).toBeGreaterThan(0);
    expect(couche.pasTotaux).toBeGreaterThan(avant);
  });

  it("l'état exporté est restauré à la précision f32 près (poids arrondis 1e-6)", () => {
    const source = new CoucheOndesNeuronales(100, { graine: 42 });
    source.resonnerVersTexte("état à persister", 10);
    const etat = source.exporterEtat();

    const cible = new CoucheOndesNeuronales(100, { graine: 42 });
    cible.importerEtat(etat);
    expect(cible.pasTotaux).toBe(etat.pasTotaux);
    const avant = source.noeuds().map((n) => n.amplitude);
    const apres = cible.noeuds().map((n) => n.amplitude);
    for (let i = 0; i < avant.length; i++) {
      // Les poids sont arrondis 1e-6 puis re-packés f32 : même valeur à
      // l'epsilon f32 près (même contrat que l'export de l'entraîneur).
      expect(apres[i]).toBeCloseTo(avant[i], 5);
    }
  });
});
