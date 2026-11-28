/**
 * SNOU — TESTS RÉELS DU SYSTÈME NEURO-ONDES UNIFIÉ.
 *
 * Recommandation du propriétaire : neurones + mémoire = UN SEUL système à
 * ondes (les données utilisateur sont mémorisées comme ondes dans le champ
 * neuronal et réutilisées à chaque requête pour mieux comprendre les
 * intentions et le monde) ; les ressources matérielles servent à TRAITER et
 * ÉVALUER les ondes (pas des calculs génériques).
 *
 * Méthodes d'amélioration de l'analyse experte vérifiées ici :
 *  1. attention spike-driven (latence + cohérence) ;
 *  2. encodeur multimodal unifié (espace latent d'ondes partagé) ;
 *  3. SSL par masquage d'ondes (erreur décroissante) + distillation depuis
 *     l'enseignant LOCAL (solveurs exacts — zéro IA externe) ;
 *  4. raisonnement multi-étapes commis comme ondes (chaîne de pensée).
 */

import { describe, expect, it } from "vitest";

import type { AIRequest } from "@/lib/ai/models";
import { createRng } from "../core/rng";
import { EspaceFiltreResonant } from "../core/resonant-space";
import { GenerateurAutoOscillation } from "../core/auto-oscillation";
import { NoyauCentralGen3 } from "../core/central-core";
import { ReseauNeuronalGen3 } from "../core/network";
import { CANAL_UTILISATEUR_IN } from "../core/types";
import { HippocampusMemory } from "../memory/hippocampus";
import { NeuralEngine } from "../engine";
import type { CortexLangagierGen3, ContexteLangage } from "../generation/language";

import { NoeudOndesUnifie, extraireConcepts } from "./noeud-ondes-unifie";
import { GestionnaireOndesUnifie } from "./gestionnaire-ondes";
import { encoderEntreeMultimodale, projeterConcept, canonicaliserConcept, FREQUENCE_MIN, FREQUENCE_MAX } from "./encodeur-multimodal-unifie";
import { attentionSpikeDriven, softmaxTemperature } from "./attention-spike-driven";
import { epochAutosupervise, distillerDepuisEnseignantLocal } from "./entrainement-autosupervise";
import { raisonnerEnOndes } from "./raisonnement-ondes";
import { evaluerOndesMateriel } from "./moteur-materiel-ondes";

function requete(texte: string, meta: Record<string, string> = {}): AIRequest {
  return { task: "chat", messages: [{ role: "user", content: texte }], metadata: meta };
}

/** Montage identique au test d'isolement P0 + gestionnaire SNOU câblé. */
function monterMoteurAvecFusion(): {
  engine: NeuralEngine;
  contextesCaptures: ContexteLangage[];
  gestionnaire: GestionnaireOndesUnifie;
} {
  const reseau = new ReseauNeuronalGen3({ seed: 1, density: 0 });
  const espace = new EspaceFiltreResonant();
  espace.registerInputPool(CANAL_UTILISATEUR_IN, [0, 1, 2]);
  espace.registerOutputPool("GENERER_IMAGE", [3, 4, 5]);
  const veille = new GenerateurAutoOscillation(reseau, 0.15, 0.15, createRng(11));
  const noyau = new NoyauCentralGen3(reseau, espace, veille);

  const contextesCaptures: ContexteLangage[] = [];
  const cortex: CortexLangagierGen3 = {
    repondre: (_prompt: string, contexte?: ContexteLangage) => {
      if (contexte === undefined) return null;
      contextesCaptures.push({ ...contexte });
      return { texte: "réponse de test déterministe", source: "corpus" as const, score: 1 };
    },
  } as unknown as CortexLangagierGen3;

  const gestionnaire = new GestionnaireOndesUnifie();
  const hippocampe = new HippocampusMemory(10);
  // Ordre : noyau, espace, cortex, hippocampe, evolution, surConsolidation,
  // pilotage, coucheRPIA, compartiments, memoireUtilisateur, rechercheWebAuto, gestionnaire.
  const engine = new NeuralEngine(noyau, espace, cortex, hippocampe, undefined, undefined, undefined, undefined, undefined, undefined, undefined, gestionnaire);
  return { engine, contextesCaptures, gestionnaire };
}

describe("SNOU — fusion neurones + mémoire (recommandation du propriétaire)", () => {
  it("les données utilisateur sont mémorisées comme ONDES puis résonnent à la requête suivante", async () => {
    const noeud = new NoeudOndesUnifie("utilisateur-alice|conv-1");
    expect(noeud.tailleMemoire).toBe(0);
    noeud.memoriserEchange("mon plat préféré est la paella espagnole", "c'est noté, la paella");
    expect(noeud.tailleMemoire).toBe(1); // la mémoire VIT dans le champ

    const comprehension = await noeud.comprendre("quelle est la cuisine espagnole que je préfère ?");
    expect(comprehension.tailleMemoire).toBe(1);
    expect(comprehension.resonances.length).toBeGreaterThan(0);
    const resonancePaella = comprehension.resonances.find((r) => r.extrait.includes("paella"));
    expect(resonancePaella).toBeDefined();
    expect(resonancePaella!.gain).toBeGreaterThan(0);
    expect(comprehension.energie).toBeGreaterThan(0);
    expect(comprehension.ordreR).toBeGreaterThanOrEqual(0);
  });

  it("la résonance est SPÉCIFIQUE : le souvenir du même intent domine celui d'un autre sujet", async () => {
    const noeud = new NoeudOndesUnifie("specificite|conv-1");
    noeud.memoriserEchange("j'aime les pommes rouges du marché", "les pommes rouges, noté");
    noeud.memoriserEchange("ma voiture est une berline diesel", "berline diesel, noté");

    const comprehension = await noeud.comprendre("quelles pommes ai-je dites aimer ?");
    const poidsPommes = comprehension.resonances.find((r) => r.extrait.includes("pommes"));
    const poidsVoiture = comprehension.resonances.find((r) => r.extrait.includes("berline"));
    expect(poidsPommes).toBeDefined();
    expect(poidsVoiture).toBeDefined();
    expect(poidsPommes!.poids).toBeGreaterThan(poidsVoiture!.poids);
  });

  it("isolement multi-utilisateur : les ondes d'un compte ne résonnent JAMAIS chez l'autre (doctrine P0)", () => {
    const gestionnaire = new GestionnaireOndesUnifie();
    const noeudAlice = gestionnaire.noeudPour('["alice","conv-a"]');
    const noeudBob = gestionnaire.noeudPour('["bob","conv-b"]');
    noeudAlice.memoriserEchange("mon secret est le code 4721", "secret mémorisé");
    expect(noeudAlice.tailleMemoire).toBe(1);
    expect(noeudBob.tailleMemoire).toBe(0); // rien ne fuit
    expect(gestionnaire.noeudPour('["alice","conv-a"]')).toBe(noeudAlice); // même champ par clé
  });

  it("le texte source accompagne l'onde (la forme) mais le SENS est l'onde (pas de table externe)", () => {
    const noeud = new NoeudOndesUnifie("substrat|conv-1");
    const commit = noeud.memoriserEchange("j'habite à Douala au Cameroun", "noté");
    const trace = noeud.traceParId(commit.traceId);
    expect(trace).toBeDefined();
    expect(trace!.impulsions.length).toBeGreaterThan(0);
    expect(trace!.impulsions.every((i) => i.frequence >= FREQUENCE_MIN && i.frequence <= FREQUENCE_MAX)).toBe(true);
  });
});

describe("méthode 2 — encodeur multimodal unifié (espace latent partagé)", () => {
  it("le MÊME concept de toute modalité produit la MÊME signature d'ondes", () => {
    const texte = projeterConcept("pomme", 64, 48);
    const image = projeterConcept("POMME  ", 64, 48); // casse + espaces → même concept
    const audio = projeterConcept("pomme!", 64, 48); // ponctuation → même concept
    expect(texte.impulsions[0].x).toBe(image.impulsions[0].x);
    expect(texte.impulsions[0].y).toBe(image.impulsions[0].y);
    expect(texte.impulsions[0].frequence).toBeCloseTo(image.impulsions[0].frequence, 12);
    expect(texte.impulsions[0].phase).toBeCloseTo(audio.impulsions[0].phase, 12);
  });

  it("le gain de modalité est normalisé : énergie comparable texte vs image", () => {
    const entreeTexte = encoderEntreeMultimodale({ modalite: "texte", concepts: ["pomme", "rouge"] }, 64, 48);
    const entreeImage = encoderEntreeMultimodale({ modalite: "image", concepts: ["pomme", "rouge"] }, 64, 48);
    expect(entreeTexte.map((i) => [i.x, i.y, i.frequence])).toEqual(entreeImage.map((i) => [i.x, i.y, i.frequence]));
    const energieTexte = entreeTexte.reduce((s, i) => s + i.amplitude, 0);
    const energieImage = entreeImage.reduce((s, i) => s + i.amplitude, 0);
    // Normalisation : les gains (1.0 vs 0.9) sont rapportés par √n → énergie
    // comparable (même ordre de grandeur, différence = gain seul).
    expect(Math.abs(energieTexte - energieImage) / Math.max(energieTexte, energieImage)).toBeLessThan(0.2);
  });

  it("l'extraction de concepts est déterministe", () => {
    expect(extraireConcepts("Le chat NOIR dort sur le toit !")).toEqual(extraireConcepts("le chat noir dort sur le toit"));
    expect(canonicaliserConcept("Éléphant À Écailles")).toBe("elephant a ecailles");
  });
});

describe("méthode 1 — attention spike-driven (latence + cohérence)", () => {
  it("softmax : somme = 1, déterministe, écart de température borné", () => {
    const poids = softmaxTemperature([2.0, 1.0, 0.5]);
    expect(poids.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(poids[0]).toBeGreaterThan(poids[1]);
    expect(softmaxTemperature([2.0, 1.0, 0.5])).toEqual(poids);
  });

  it("la LATENCE du pic pèse : une trace qui résonne vite pèse plus qu'une tardive (même gain)", () => {
    const traces = [{ id: "rapide" }, { id: "tardive" }] as never[];
    const resultat = attentionSpikeDriven(
      traces as Parameters<typeof attentionSpikeDriven>[0],
      (trace) => (trace.id === "rapide" ? { gainsParPas: [1.0, 0.9, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01], alignementPhase: 0.9 } : { gainsParPas: [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 0.9, 1.0], alignementPhase: 0.9 }),
      1.0,
    );
    const rapide = resultat.poids.find((p) => p.traceId === "rapide")!;
    const tardive = resultat.poids.find((p) => p.traceId === "tardive")!;
    expect(rapide.latencePic).toBe(1);
    expect(tardive.latencePic).toBe(8);
    expect(rapide.poids).toBeGreaterThan(tardive.poids);
  });
});

describe("méthode 3a — entraînement auto-supervisé (prédiction du prochain spike)", () => {
  it("l'erreur de prédiction DÉCROÎT epoch après epoch (plasticité hébbienne réelle)", async () => {
    const noeud = new NoeudOndesUnifie("ssl|conv-1");
    // Les souvenirs sont COMMIS une fois (la mémoire du champ) — le SSL
    // entraîne la résonance du champ vers la bonne trace à partir du contexte.
    const echantillons = [
      { concepts: ["pomme", "rouge", "panier", "marche"], proportionMasquee: 0.25, traceId: noeud.memoriser({ modalite: "texte", concepts: ["pomme", "rouge", "panier", "marche"], texte: "pomme rouge panier marche" }).traceId },
      { concepts: ["voiture", "berline", "diesel", "route"], proportionMasquee: 0.25, traceId: noeud.memoriser({ modalite: "texte", concepts: ["voiture", "berline", "diesel", "route"], texte: "voiture berline diesel route" }).traceId },
    ];
    const erreurs: number[] = [];
    for (let epoch = 0; epoch < 4; epoch++) {
      const rapport = await epochAutosupervise(noeud, echantillons.map((e) => ({ ...e, nbContexte: 3 })), epoch);
      erreurs.push(rapport.erreurMoyenne);
      expect(rapport.echantillons).toBe(2);
      expect(rapport.masquageMoyen).toBeGreaterThan(0);
    }
    expect(erreurs[0]).toBeGreaterThan(0); // au départ, la prédiction est imparfaite
    expect(erreurs[3]).toBeLessThan(erreurs[0]); // le champ APPREND
  });
});

describe("méthode 3b — distillation depuis l'enseignant LOCAL (zéro IA externe)", () => {
  it("les sorties des solveurs exacts deviennent des ondes vérifiées par résonance", async () => {
    const noeud = new NoeudOndesUnifie("distillation|conv-1");
    const rapport = await distillerDepuisEnseignantLocal(noeud, [
      { question: "combien font 12 fois 12", reponseEnseignant: "144" },
      { question: "combien font 8 plus 7", reponseEnseignant: "15" },
    ]);
    expect(rapport.paquetsGraves).toBe(2);
    expect(rapport.resonancesVerifiees).toBe(2); // chaque gravure résonne
    expect(rapport.echecsVerifies).toBe(0);
    // La connaissance distillée EST utilisable à la lecture :
    const comprehension = await noeud.comprendre("12 fois 12");
    expect(comprehension.souvenirDominant).not.toBeNull();
    expect(comprehension.souvenirDominant!.extrait).toContain("144");
  });
});

describe("méthode 4 — raisonnement multi-étapes en ondes (chaîne de pensée)", () => {
  it("décomposition déterministe puis chaîne d'ondes commise et vérifiée", async () => {
    const noeud = new NoeudOndesUnifie("cot|conv-1");
    const rapport = await raisonnerEnOndes(noeud, "calcule 17 × 23 puis ajoute 9");
    expect(rapport.decomposee).toBe(true);
    expect(rapport.etapes.length).toBe(2);
    expect(rapport.etapes[0].resultat).not.toBeNull(); // 17 × 23 → solveur local
    expect(rapport.reponseFinale).not.toBeNull(); // portage du résultat
    expect(rapport.verifieeParResonance).toBe(true);
    // Le raisonnement reste dans la mémoire d'ondes (fusion mémoire+raisonnement)
    expect(noeud.tailleMemoire).toBeGreaterThanOrEqual(2);
  });
});

describe("moteur matériel — évaluation des ondes UNIQUEMENT (recommandation propriétaire)", () => {
  it("évalue la mémoire d'ondes : débit réel, détection GPU honnête, aucune API générique", async () => {
    const noeud = new NoeudOndesUnifie("materiel|conv-1");
    noeud.memoriserEchange("les ondes portent la pensée", "noté");
    noeud.memoriserEchange("le champ évalue la cohérence", "noté");
    const mesures = await evaluerOndesMateriel(noeud);
    expect(mesures.usageMateriel).toBe("evaluation-des-ondes-uniquement");
    expect(mesures.souvenirsEvalues).toBe(2);
    expect(mesures.pasParSeconde).toBeGreaterThan(0);
    expect(mesures.energie).toBeGreaterThan(0);
    // Détection honnête : dans ce sandbox sans GPU, le repli CPU est assumé.
    if (mesures.webgpuDisponible) {
      expect(mesures.moteur).toBe("webgpu");
    } else {
      expect(mesures.moteur).toBe("cpu");
    }
  });
});

describe("pont moteur — la fusion vit dans le CHEMIN RÉEL de Gen3", () => {
  it("generate() mémorise les ondes puis enrichit le contexte par résonance (et l'isole)", async () => {
    const { engine, contextesCaptures, gestionnaire } = monterMoteurAvecFusion();

    await engine.generate(requete("mon plat préféré est le ndolé camerounais", { userId: "alice", conversationId: "conv-a" }));
    const noeudAlice = gestionnaire.noeudPour('["alice","conv-a"]');
    expect(noeudAlice.tailleMemoire).toBe(1); // écriture : l'échange est gravé en ondes

    // (une question anaphorique neutre : elle tombe dans le contexte du
    // cortex — les ponts antérieurs (vocation, corpus appris) ne la capturent pas)
    await engine.generate(requete("et toi ?", { userId: "alice", conversationId: "conv-a" }));
    expect(noeudAlice.tailleMemoire).toBe(2); // le 2e échange est gravé aussi

    // Le cortex a reçu la preuve de résonance (contexte enrichi par les ondes).
    const contexteFusion = contextesCaptures.find((c) => c.ondesFusionnees);
    expect(contexteFusion).toBeDefined();
    expect(contexteFusion!.ondesFusionnees!.score).toBeGreaterThan(0);

    // Isolement : bob n'a RIEN des ondes d'alice.
    const noeudBob = gestionnaire.noeudPour('["bob","conv-b"]');
    expect(noeudBob.tailleMemoire).toBe(0);
  }, 60_000);
});
