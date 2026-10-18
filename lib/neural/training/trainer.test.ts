import { afterEach, describe, expect, it } from "vitest";

import { ReseauNeuronalGen3 } from "../core/network";
import { EspaceFiltreResonant } from "../core/resonant-space";
import { GenerateurAutoOscillation } from "../core/auto-oscillation";
import { NoyauCentralGen3 } from "../core/central-core";
import { createRng } from "../core/rng";
import { tokenize } from "../encoding/text-encoder";
import {
  NeuralTrainer,
  enregistrerPoolsDIntention,
  predireIntention,
} from "./trainer";
import type { TrainingSample } from "./dataset";
import {
  labelText,
  buildDatasetFromCorpus,
  SEED_EXAMPLES,
} from "./dataset";
import {
  saveBrainState,
  loadBrainState,
  deleteBrainState,
  BRAIN_PATH,
} from "./persistence";
import { existsSync } from "node:fs";

/**
 * ENTRAÎNEUR SUPERVISÉ — tests de la boucle d'apprentissage RÉELLE :
 *  - mini-dataset synthétique de 60 échantillons (4 labels, vocabulaires
 *    volontairement DISJOINTS pour mesurer l'apprentissage pur) ;
 *  - accuracy finale > accuracy initiale + 0.3 (le réseau APPREND) ;
 *  - persistance : save → load → synapses identiques (aller-retour complet).
 */

/* -------------------------------------------------------------------------
 * Mini-dataset synthétique : 4 labels × 15 échantillons, vocabulaires
 * DISJOINTS (aucun token partagé entre deux labels — vérifié par le test).
 * ----------------------------------------------------------------------- */

const SAMPLES: TrainingSample[] = [
  // GENERER_IMAGE (15)
  { text: "image montagne enneigée panorama", label: "GENERER_IMAGE" },
  { text: "illustration botanique détaillée fougère", label: "GENERER_IMAGE" },
  { text: "photo panorama citadin nocturne", label: "GENERER_IMAGE" },
  { text: "dessin portrait crayonné", label: "GENERER_IMAGE" },
  { text: "image abstraite géométrique", label: "GENERER_IMAGE" },
  { text: "visuel avatar futuriste", label: "GENERER_IMAGE" },
  { text: "illustration technique éclatée", label: "GENERER_IMAGE" },
  { text: "photo macro florale", label: "GENERER_IMAGE" },
  { text: "dessin esquissé fusain", label: "GENERER_IMAGE" },
  { text: "image satellite cartographique", label: "GENERER_IMAGE" },
  { text: "visuel promotionnel lumineux", label: "GENERER_IMAGE" },
  { text: "illustration enfantine colorée", label: "GENERER_IMAGE" },
  { text: "photo portrait studio", label: "GENERER_IMAGE" },
  { text: "dessin architecte croquis", label: "GENERER_IMAGE" },
  { text: "image tactile texture bois", label: "GENERER_IMAGE" },
  // GENERER_AUDIO (15)
  { text: "audio ambiance forestière", label: "GENERER_AUDIO" },
  { text: "son pluie battante", label: "GENERER_AUDIO" },
  { text: "musique électro chill", label: "GENERER_AUDIO" },
  { text: "voix narration documentaire", label: "GENERER_AUDIO" },
  { text: "podcast interview expert", label: "GENERER_AUDIO" },
  { text: "audio méditatif océan", label: "GENERER_AUDIO" },
  { text: "son synthé planant", label: "GENERER_AUDIO" },
  { text: "musique orchestrale épique", label: "GENERER_AUDIO" },
  { text: "voix off publicitaire", label: "GENERER_AUDIO" },
  { text: "podcast hebdomadaire technologique", label: "GENERER_AUDIO" },
  { text: "audio thérapie bruit blanc", label: "GENERER_AUDIO" },
  { text: "son urbain trafic dense", label: "GENERER_AUDIO" },
  { text: "musique acoustique guitare", label: "GENERER_AUDIO" },
  { text: "voix conteuse apaisante", label: "GENERER_AUDIO" },
  { text: "audio atmosphère feutrée", label: "GENERER_AUDIO" },
  // EXECUTER_OUTIL_OS (15)
  { text: "outil inspecter dossier", label: "EXECUTER_OUTIL_OS" },
  { text: "script automatiser sauvegarde", label: "EXECUTER_OUTIL_OS" },
  { text: "commande lister processus", label: "EXECUTER_OUTIL_OS" },
  { text: "terminal compiler projet", label: "EXECUTER_OUTIL_OS" },
  { text: "exécute diagnostic réseau", label: "EXECUTER_OUTIL_OS" },
  { text: "outil surveiller journal", label: "EXECUTER_OUTIL_OS" },
  { text: "script convertir données brutes", label: "EXECUTER_OUTIL_OS" },
  { text: "commande nettoyer cache", label: "EXECUTER_OUTIL_OS" },
  { text: "terminal redémarrer service", label: "EXECUTER_OUTIL_OS" },
  { text: "outil archiver fichiers", label: "EXECUTER_OUTIL_OS" },
  { text: "script planifier rapport", label: "EXECUTER_OUTIL_OS" },
  { text: "commande monitoring mémoire", label: "EXECUTER_OUTIL_OS" },
  { text: "terminal déploiement continu", label: "EXECUTER_OUTIL_OS" },
  { text: "outil auditer sécurité", label: "EXECUTER_OUTIL_OS" },
  { text: "script traiter relevés", label: "EXECUTER_OUTIL_OS" },
  // INITIALISER_APPEL (15)
  { text: "appeler client important", label: "INITIALISER_APPEL" },
  { text: "téléphone numéro support", label: "INITIALISER_APPEL" },
  { text: "appelle maman ce soir", label: "INITIALISER_APPEL" },
  { text: "contacte fournisseur urgent", label: "INITIALISER_APPEL" },
  { text: "numéro joindre direction", label: "INITIALISER_APPEL" },
  { text: "appel conférence équipe", label: "INITIALISER_APPEL" },
  { text: "téléphone ligne occupée", label: "INITIALISER_APPEL" },
  { text: "appeler réclamation garantie", label: "INITIALISER_APPEL" },
  { text: "contacte partenaire commercial", label: "INITIALISER_APPEL" },
  { text: "numéro urgence médicale", label: "INITIALISER_APPEL" },
  { text: "appel suivi livraison", label: "INITIALISER_APPEL" },
  { text: "téléphone renseignement facture", label: "INITIALISER_APPEL" },
  { text: "appeler réunion imprévue", label: "INITIALISER_APPEL" },
  { text: "contacte recruteur entretien", label: "INITIALISER_APPEL" },
  { text: "numéro assistance internationale", label: "INITIALISER_APPEL" },
];

function monterEntrainement(): NeuralTrainer {
  const reseau = new ReseauNeuronalGen3({ seed: 3, density: 0.05 });
  const espace = new EspaceFiltreResonant();
  espace.registerInputPool("utilisateur_in", [38, 39]);
  enregistrerPoolsDIntention(espace);
  const veille = new GenerateurAutoOscillation(reseau, 0.15, 0.15, createRng(77));
  const noyau = new NoyauCentralGen3(reseau, espace, veille);
  return new NeuralTrainer(reseau, espace, veille, noyau);
}

describe("NeuralTrainer — apprentissage réel", () => {
  it("le mini-dataset est bien formé : 60 échantillons, 4 labels, vocabulaires disjoints", () => {
    expect(SAMPLES).toHaveLength(60);

    const labels = new Set(SAMPLES.map((s) => s.label));
    expect(labels).toEqual(
      new Set([
        "GENERER_IMAGE",
        "GENERER_AUDIO",
        "EXECUTER_OUTIL_OS",
        "INITIALISER_APPEL",
      ]),
    );

    // Chaque échantillon est correctement étiqueté par le lexique.
    for (const sample of SAMPLES) {
      expect(labelText(sample.text)).toBe(sample.label);
    }

    // Vocabulaires DISJOINTS entre labels (propriété du dataset synthétique :
    // elle garantit que la précision mesure l'apprentissage, pas le bruit).
    const tokensParLabel = new Map<string, Set<string>>();
    for (const sample of SAMPLES) {
      const ensemble = tokensParLabel.get(sample.label) ?? new Set<string>();
      for (const token of tokenize(sample.text)) ensemble.add(token);
      tokensParLabel.set(sample.label, ensemble);
    }
    const parLabel = Array.from(tokensParLabel.entries());
    for (let i = 0; i < parLabel.length; i++) {
      for (let j = i + 1; j < parLabel.length; j++) {
        const [, tokensA] = parLabel[i];
        const [, tokensB] = parLabel[j];
        const partage = Array.from(tokensA).filter((t) => tokensB.has(t));
        expect(partage).toEqual([]); // aucun token partagé
      }
    }
  });

  it("le réseau APPREND réellement : accuracy finale > accuracy initiale + 0.3", async () => {
    const trainer = monterEntrainement();

    // Accuracy de référence AVANT entraînement (réseau seedé, non appris).
    const accuracyInitiale = trainer.evaluerEchantillons(SAMPLES, 3);

    const rapport = await trainer.train(SAMPLES, {
      epochs: 6,
      lrBoost: 0.08,
      cyclesParEchantillon: 3,
    });

    expect(rapport.epochs).toBe(6);
    expect(rapport.samples).toBe(51); // 60 - 9 tests (15 %)
    expect(rapport.history).toHaveLength(6);
    expect(rapport.dureeMs).toBeGreaterThan(0);

    // La précision progresse au fil des époques (apprentissage réel).
    expect(rapport.history[5].accuracy).toBeGreaterThan(
      rapport.history[0].accuracy,
    );

    // L'exigence du cahier des charges : gain > 0.3 sur le jeu de test.
    expect(rapport.accuracyTest).toBeGreaterThan(accuracyInitiale + 0.3);
  }, 30_000);
});

describe("predireIntention", () => {
  it("repli sur INTENTION_GENERALE quand toutes les résonances sont nulles", () => {
    expect(predireIntention({})).toBe("INTENTION_GENERALE");
    expect(
      predireIntention({
        GENERER_IMAGE: 0,
        GENERER_AUDIO: 0,
      }),
    ).toBe("INTENTION_GENERALE");
  });

  it("retient le pool au score strictement maximal", () => {
    expect(
      predireIntention({ GENERER_IMAGE: 0.5, GENERER_AUDIO: 1 }),
    ).toBe("GENERER_AUDIO");
    expect(
      predireIntention({ GENERER_IMAGE: 1, GENERER_AUDIO: 0.5 }),
    ).toBe("GENERER_IMAGE");
  });
});

describe("Dataset (étiquetage lexical + corpus)", () => {
  it("labelText : premier match selon l'ordre des pools, repli général", () => {
    expect(labelText("génère une image de chat")).toBe("GENERER_IMAGE");
    expect(labelText("crée un audio d'ambiance")).toBe("GENERER_AUDIO");
    expect(labelText("exécute le script de build")).toBe("EXECUTER_OUTIL_OS");
    expect(labelText("appelle le client")).toBe("INITIALISER_APPEL");
    expect(labelText("raccroche tout de suite")).toBe("TERMINER_APPEL");
    // « image » avant « audio » : l'ordre des pools tranche.
    expect(labelText("image et audio")).toBe("GENERER_IMAGE");
    // Aucun mot-clé : repli explicite (pool d'intention générale).
    expect(labelText("météo demain matin")).toBe("INTENTION_GENERALE");
    // Normalisation des diacritiques.
    expect(labelText("vidéo de vacances")).toBe("GENERER_VIDEO");
    expect(labelText("compétence requise")).toBe(
      "SELECTIONNER_ET_EXECUTER_SKILL",
    );
  });

  it("buildDatasetFromCorpus : découpe, étiquetage et équilibrage", () => {
    const corpus = [
      "Génère une image de montagne au lever du soleil.", // image
      "Crée un son d'ambiance pour dormir.", // audio
      "Exécute le script de sauvegarde maintenant.", // outil
      "La plateforme propose plus de huit cents intégrations.", // général
      "Bonjour, merci pour tout.", // général
      "Trop court.", // < 15 caractères : ignoré
    ].join("\n");

    const dataset = buildDatasetFromCorpus(corpus, { maxParLabel: 2 });

    const attendus: Record<string, number> = {};
    for (const s of dataset.samples) {
      attendus[s.label] = (attendus[s.label] ?? 0) + 1;
    }
    expect(attendus["GENERER_IMAGE"]).toBe(1);
    expect(attendus["GENERER_AUDIO"]).toBe(1);
    expect(attendus["EXECUTER_OUTIL_OS"]).toBe(1);
    expect(attendus["INTENTION_GENERALE"]).toBe(2);
    expect(dataset.stats["INTENTION_GENERALE"]).toBe(2);
    // La phrase trop courte a été filtrée.
    expect(dataset.samples.some((s) => s.text.includes("Trop court"))).toBe(
      false,
    );
  });

  it("SEED_EXAMPLES : 54 exemples canoniques (12 général + 6 par pool)", () => {
    expect(SEED_EXAMPLES).toHaveLength(54);
    const stats: Record<string, number> = {};
    for (const exemple of SEED_EXAMPLES) {
      stats[exemple.label] = (stats[exemple.label] ?? 0) + 1;
      // Chaque exemple est cohérent avec son propre étiquetage lexical.
      expect(labelText(exemple.text)).toBe(exemple.label);
    }
    expect(stats["INTENTION_GENERALE"]).toBe(12);
    expect(stats["GENERER_IMAGE"]).toBe(6);
    expect(stats["GENERER_AUDIO"]).toBe(6);
    expect(stats["GENERER_VIDEO"]).toBe(6);
    expect(stats["EXECUTER_OUTIL_OS"]).toBe(6);
    expect(stats["SELECTIONNER_ET_EXECUTER_SKILL"]).toBe(6);
    expect(stats["INITIALISER_APPEL"]).toBe(6);
    expect(stats["TERMINER_APPEL"]).toBe(6);
  });
});

describe("Persistance du cerveau", () => {
  afterEach(() => {
    deleteBrainState();
  });

  it("save → load → importState : les synapses survivent à l'aller-retour", async () => {
    const reseauA = new ReseauNeuronalGen3({ seed: 5, density: 0.07 });

    const ok = await saveBrainState(reseauA, { 3: ["image", "photo"] }, []);
    expect(ok).toBe(true);
    expect(existsSync(BRAIN_PATH)).toBe(true);

    const etat = loadBrainState();
    expect(etat).not.toBeNull();
    expect(etat?.config.seed).toBe(5);
    expect(etat?.synapses.length).toBe(reseauA.synapses.length);
    expect(etat?.tokenRegistry).toEqual({ 3: ["image", "photo"] });

    // Restauration dans un réseau différent : câblage identique.
    const reseauB = new ReseauNeuronalGen3({ seed: 999 });
    reseauB.importState({
      config: etat!.config,
      synapses: etat!.synapses,
    });
    expect(reseauB.synapses.length).toBe(reseauA.synapses.length);
    for (let i = 0; i < reseauA.synapses.length; i++) {
      expect(reseauB.synapses[i].sourceId).toBe(reseauA.synapses[i].sourceId);
      expect(reseauB.synapses[i].targetId).toBe(reseauA.synapses[i].targetId);
      expect(reseauB.synapses[i].weight).toBeCloseTo(
        reseauA.synapses[i].weight,
        12,
      );
    }

    deleteBrainState();
    expect(existsSync(BRAIN_PATH)).toBe(false);
    // Suppression idempotente : aucun échec.
    expect(() => deleteBrainState()).not.toThrow();
  });

  it("loadBrainState : null si le fichier est absent", () => {
    deleteBrainState();
    expect(loadBrainState()).toBeNull();
  });
});
