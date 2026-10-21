/**
 * PRÉ-ENTRAÎNEMENT DU CORTEX V2 — HORS PRODUCTION.
 *
 * À exécuter dans un environnement d'entraînement (sandbox / poste de dev),
 * JAMAIS sur le serveur de production :
 *   npx tsx scripts/pretrain-cortex-v2.ts
 *
 * Principe honnête : le noyau v1 (100 neurones) continue d'apprendre en
 * ligne (corpus réamorcé à chaque démarrage, Studio d'entraînement,
 * auto-apprentissage). Ce script pré-entraîne l'étage AJOUTÉ par le Cortex
 * v2 — le réservoir columnnaire (262 144 colonnes) — sur un corpus
 * d'intentions déterministe, puis exporte l'artefact binaire committé dans
 * `assets/neural-pretrained/`. En production, le runtime charge cet
 * artefact au premier démarrage : le cerveau élargi est PRÊT À L'EMPLOI,
 * puis continue d'apprendre par lui-même (fenêtres supervisées du trainer,
 * consolidation d'expérience du champ d'1e9 neurones).
 *
 * La plasticité utilisée est EXACTEMENT celle de production
 * (cortex.plasticiteSupervisee — miroir columnnaire du trainer v1) :
 * renforcement des arêtes colonnes stimulées → bande du label, punition
 * compétitive des bandes sur-résonantes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CortexColumnnaire } from "../lib/neural/core/v2/cortex-columnnaire";
import { ChampCorticalGen3 } from "../lib/neural/core/v2/champ-cortical";
import { ecrireArtefactV2 } from "../lib/neural/core/v2/persistance-v2";
import { tokenize } from "../lib/neural/encoding/text-encoder";

/** Bandes d'intention — miroir exact de BANDES_INTENTION (effecteur). */
const LABELS = [
  "GENERER_IMAGE",
  "GENERER_AUDIO",
  "GENERER_VIDEO",
  "EXECUTER_OUTIL_OS",
  "SELECTIONNER_ET_EXECUTER_SKILL",
  "INITIALISER_APPEL",
  "TERMINER_APPEL",
  "INTENTION_GENERALE",
] as const;

type Label = (typeof LABELS)[number];

/** Sujets par intention (combinatoire déterministe de variantes). */
const SUJETS: Record<Label, { ouvertures: string[]; sujets: string[] }> = {
  GENERER_IMAGE: {
    ouvertures: [
      "génère une image de",
      "crée un dessin de",
      "dessine moi",
      "fais une illustration de",
      "peins un tableau de",
      "produis un visuel de",
    ],
    sujets: [
      "un coucher de soleil sur l'océan",
      "un chat noir sur un toit",
      "une ville futuriste la nuit",
      "une forêt en automne",
      "un dragon au-dessus des nuages",
      "un champ de fleurs au printemps",
      "une galaxie spirale",
      "un phare dans la tempête",
    ],
  },
  GENERER_AUDIO: {
    ouvertures: [
      "synthétise un son de",
      "joue une musique",
      "génère une ambiance sonore",
      "crée un effet audio de",
      "produis un signal audio",
    ],
    sujets: [
      "pluie sur les vitres",
      "vagues sur la plage",
      "vent dans les arbres",
      "piano doux et mélancolique",
      "battements de cœur",
      "orage au loin",
      "nappe synthétique calme",
    ],
  },
  GENERER_VIDEO: {
    ouvertures: [
      "génère une vidéo de",
      "fais une animation de",
      "crée un clip de",
      "produis une séquence vidéo de",
    ],
    sujets: [
      "vagues qui déferlent",
      "structures neuronales en transition",
      "une fusée qui décolle",
      "feuilles qui tombent",
      "une spirale en rotation",
      "lumières qui pulsent",
    ],
  },
  EXECUTER_OUTIL_OS: {
    ouvertures: [
      "exécute la commande",
      "lance la commande",
      "exécute l'outil",
      "utilise l'outil système pour",
      "invoque l'outil",
    ],
    sujets: [
      "etat_reseau",
      "lister les fichiers du projet",
      "rapport_sante",
      "lister_competences",
      "vérifier l'état du serveur",
      "generer_visuel_neural",
    ],
  },
  SELECTIONNER_ET_EXECUTER_SKILL: {
    ouvertures: [
      "utilise la compétence",
      "sélectionne et exécute le skill",
      "lance la compétence",
      "active le skill",
    ],
    sujets: [
      "de traduction",
      "de résumé de texte",
      "de calcul avancé",
      "d'analyse de données",
      "de conversion d'unités",
    ],
  },
  INITIALISER_APPEL: {
    ouvertures: [
      "appelle",
      "initie un appel vers",
      "téléphone à",
      "passe un appel à",
      "démarre un appel vocal avec",
    ],
    sujets: ["Marie", "le support technique", "Papa", "le bureau", "Jean"],
  },
  TERMINER_APPEL: {
    ouvertures: [
      "raccroche",
      "termine l'appel",
      "mets fin à l'appel",
      "coupe la communication",
    ],
    sujets: [""],
  },
  INTENTION_GENERALE: {
    ouvertures: [
      "bonjour",
      "qui es-tu",
      "comment ça va",
      "explique moi",
      "raconte moi",
      "quelle heure est-il",
      "parle moi de",
    ],
    sujets: [
      "la photosynthèse",
      "les étoiles",
      "ton fonctionnement",
      "tes compétences",
      "la musique classique",
    ],
  },
};

/** Échantillon d'entraînement { text, label }. */
interface Echantillon {
  text: string;
  label: Label;
}

/** Génère le corpus déterministe complet (combinatoire ouverture × sujet). */
function construireCorpus(): Echantillon[] {
  const corpus: Echantillon[] = [];
  for (const label of LABELS) {
    const { ouvertures, sujets } = SUJETS[label];
    for (const ouverture of ouvertures) {
      for (const sujet of sujets) {
        const texte = `${ouverture} ${sujet}`.replace(/\s+/g, " ").trim();
        if (texte.length > 0) corpus.push({ text: texte, label });
      }
    }
  }
  return corpus;
}

/** PRNG mulberry32 déterministe (même famille que le moteur). */
function createRngLocal(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mélange déterministe (Fisher-Yates seedé). */
function melanger<T>(liste: T[], seed: number): T[] {
  const copie = [...liste];
  const rng = createRngLocal(seed);
  for (let i = copie.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copie[i], copie[j]] = [copie[j], copie[i]];
  }
  return copie;
}

async function principal(): Promise<void> {
  const debut = Date.now();
  const startedAt = new Date().toISOString();
  const epochs = 6;
  const cyclesParEchantillon = 4;
  const lrBoost = 0.15;
  const testRatio = 0.15;

  console.log("[PRETRAIN-V2] Construction du corpus d'intentions…");
  const corpus = construireCorpus();
  const melange = melanger(corpus, 2024);
  const nbTest = Math.max(1, Math.floor(melange.length * testRatio));
  const train = melange.slice(0, melange.length - nbTest);
  const test = melange.slice(melange.length - nbTest);
  console.log(
    `[PRETRAIN-V2] ${corpus.length} échantillons (train ${train.length} / test ${nbTest}) sur ${LABELS.length} intentions.`,
  );

  // Même format que la production (262 144 colonnes, 32 bandes).
  const cortex = new CortexColumnnaire();
  const champ = new ChampCorticalGen3(42);

  const prediction = (activation: number[]): Label => {
    let meilleur = 7; // INTENTION_GENERALE par défaut (aucune résonance)
    let meilleurScore = 0;
    for (let b = 0; b < LABELS.length; b++) {
      if (activation[b] > meilleurScore) {
        meilleur = b;
        meilleurScore = activation[b];
      }
    }
    return LABELS[meilleur];
  };

  /**
   * Présente un échantillon (fenêtre propre) et retourne la lecture graduée
   * MAX sur la fenêtre de cycles (miroir du trainer v1 : maximum pondéré).
   * L'HORLOGE EST CONTINUE (horlogeGlobale) : la fenêtre de plasticité
   * compare t au dernier spike RÉEL — un redémarrage à 1 à chaque
   * échantillon renforcerait toutes les transmissions (dt = 1 < fenêtre)
   * et saturerait tout le câblage. En production, l'horloge de l'effecteur
   * est déjà continue (cf. effecteur-cortex.ts).
   */
  let horlogeGlobale = 0;
  const propager = (texte: string): { activation: number[]; stimulees: number[] } => {
    cortex.reinitialiserEnergies();
    const injections = cortex.projetterTokens(tokenize(texte));
    const stimulees = injections.map(([c]) => c);
    const activation = new Array<number>(LABELS.length).fill(0);
    for (let c = 0; c < cyclesParEchantillon; c++) {
      const inj = c === 0 ? injections : null;
      horlogeGlobale += 1;
      cortex.pas(inj, horlogeGlobale);
      const courante = cortex.activationBandes();
      for (let b = 0; b < courante.length; b++) {
        if (courante[b] > activation[b]) activation[b] = courante[b];
      }
    }
    return { activation, stimulees };
  };

  // ----- Boucle d'entraînement supervisée --------------------------------
  const history: Array<{ epoch: number; accuracy: number }> = [];
  for (let epoch = 1; epoch <= epochs; epoch++) {
    let corrects = 0;
    for (let i = 0; i < train.length; i++) {
      const echantillon = train[i];
      const { activation, stimulees } = propager(echantillon.text);
      const predite = prediction(activation);
      if (predite === echantillon.label) corrects += 1;

      // Plasticité supervisée columnnaire (miroir exact du trainer v1) :
      // renforcement bande cible, punition des bandes sur-résonantes.
      const bandeCible = LABELS.indexOf(echantillon.label);
      const scoreCible = activation[bandeCible] ?? 0;
      const concurrentes: number[] = [];
      for (let b = 0; b < LABELS.length; b++) {
        if (b !== bandeCible && (activation[b] ?? 0) > scoreCible) {
          concurrentes.push(b);
        }
      }
      cortex.plasticiteSupervisee(stimulees, bandeCible, lrBoost, concurrentes);
      // Le champ d'1e9 neurones apprend avec chaque échantillon.
      champ.consoliderApprentissage(0, 1);

      if ((i + 1) % 100 === 0) {
        console.log(
          `[PRETRAIN-V2] époque ${epoch}/${epochs} — ${i + 1}/${train.length} échantillons (accuracy en ligne ${(corrects / (i + 1)).toFixed(3)}).`,
        );
      }
    }
    const accuracy = corrects / train.length;
    history.push({ epoch, accuracy });
    console.log(`[PRETRAIN-V2] époque ${epoch}/${epochs} — accuracy train ${accuracy.toFixed(3)}`);
  }

  // ----- Évaluation sur le jeu de test (jamais vu, aucune plasticité) ----
  let correctsTest = 0;
  for (const echantillon of test) {
    const { activation } = propager(echantillon.text);
    if (prediction(activation) === echantillon.label) correctsTest += 1;
  }
  const accuracyTest = correctsTest / test.length;
  console.log(`[PRETRAIN-V2] accuracy test ${accuracyTest.toFixed(3)} (${correctsTest}/${test.length}).`);

  // ----- Export de l'artefact pré-entraîné -------------------------------
  const racine = join(__dirname, "..");
  const cheminBin = join(racine, "assets/neural-pretrained/cortex-v2.bin");
  const cheminRapport = join(racine, "assets/neural-pretrained/pretrain-report.json");

  const stats = cortex.stats();
  const dureeMs = Date.now() - debut;
  const ok = await ecrireArtefactV2(cheminBin, {
    colonnes: cortex.config.colonnes,
    voisins: cortex.config.voisins,
    bandes: cortex.config.bandes,
    seed: cortex.config.seed,
    seedEntrainement: champ.seedEntrainement,
    epochsConsolides: epochs,
    samplesConsolides: train.length,
    poids: cortex.exporterPoids(),
    modulationRegionale: champ.modulationRegionale(),
  });
  if (!ok) throw new Error("Échec d'écriture de l'artefact pré-entraîné.");

  const rapport = {
    startedAt,
    dureeMs,
    epochs,
    cyclesParEchantillon,
    lrBoost,
    samplesTrain: train.length,
    samplesTest: test.length,
    accuracyTrain: history[history.length - 1]?.accuracy ?? 0,
    accuracyTest,
    history,
    champ: {
      taille: 1_000_000_000,
      seedEntrainement: champ.seedEntrainement,
    },
    cortex: {
      colonnes: stats.colonnes,
      aretes: stats.aretes,
      bandes: stats.bandes,
    },
    environnement: "pré-entraînement HORS PRODUCTION (sandbox de développement)",
    note: "Artefact chargé au premier démarrage du runtime (aucun cerveau local présent) — prêt à l'emploi, puis apprentissage continu en production.",
  };
  mkdirSync(dirname(cheminRapport), { recursive: true });
  writeFileSync(cheminRapport, JSON.stringify(rapport, null, 2), "utf8");

  console.log(`[PRETRAIN-V2] Artefact écrit : ${cheminBin}`);
  console.log(`[PRETRAIN-V2] Rapport écrit : ${cheminRapport}`);
  console.log(
    `[PRETRAIN-V2] Terminé en ${(dureeMs / 1000).toFixed(1)} s — accuracy train ${rapport.accuracyTrain.toFixed(3)} / test ${rapport.accuracyTest.toFixed(3)}.`,
  );
}

principal().catch((erreur) => {
  console.error("[PRETRAIN-V2] Échec :", erreur);
  process.exit(1);
});
