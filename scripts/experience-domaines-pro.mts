/**
 * EXPÉRIENCE SNN — ENTRAÎNEMENT NEURONAL RÉEL SUR DONNÉES PROFESSIONNELLES.
 * Job 478451 (relance CD).
 *
 * Protocole identique à experience-semantique.ts :
 *  1. Échantillons RÉELS : instructions des datasets professionnels intégrés
 *     (GSM8K, ARC, SciQ, FLEURS, UCF101, Kaggle colorNames), étiquetées par
 *     le domaine du cerveau le plus proche (mapping documenté ci-dessous) ;
 *  2. Séparation déterministe 70/15/15 (séparerDataset, graine) ;
 *  3. BASELINE sur le test AVANT entraînement (aucune plasticité) ;
 *  4. ENTRAÎNEMENT RÉEL trainer.trainDomaines (plasticité compétitive sur
 *     les 18 pools de domaine, neurones 100-135) — TRAIN uniquement ;
 *  5. Mesures après (train / validation / test) — généralisation = test−baseline ;
 *  6. Persistance versionnée (SHA-256) + rapport JSON.
 *
 * Mapping documenté (pools existants du cerveau, aucun pool créé) :
 *   math_professionnel      → analyse_donnees        (problèmes quantitatifs)
 *   sciences_professionnel  → recherche_scientifique (Q/R scientifiques)
 *   couleurs_v5             → generation_images      (connaissance visuelle des couleurs)
 *   parole_professionnelle  → son                    (voix / transcription)
 *   vision_professionnel    → multimodal             (analyse d'images/vidéos réelles)
 *
 * Exécution : NODE_OPTIONS='--conditions react-server' npx tsx scripts/experience-domaines-pro.mts
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { getNeuralRuntime } from "../lib/neural/runtime";
import { NeuralTrainer, enregistrerPoolsDomaines } from "../lib/neural/training/trainer";
import { separerDataset, hashSplits, type TrainingSample } from "../lib/neural/training/experience-semantique";
import { sauvegarderVersion } from "../lib/neural/persistance-versions";
import { tokenize } from "../lib/neural/encoding/text-encoder";
import { DOMAINES_GEN3 } from "../lib/neural/training/domaines";

const SOURCES: Array<{ dossier: string; label: string; quota: number }> = [
  { dossier: "math_professionnel", label: "DOM_ANALYSE_DONNEES", quota: 300 },
  { dossier: "sciences_professionnel", label: "DOM_RECHERCHE_SCIENTIFIQUE", quota: 300 },
  { dossier: "couleurs_v5", label: "DOM_GENERATION_IMAGES", quota: 300 },
  { dossier: "parole_professionnelle", label: "DOM_SON", quota: 300 },
  { dossier: "vision_professionnel", label: "DOM_MULTIMODAL", quota: 300 },
];

function chargerEchantillons(): TrainingSample[] {
  // AMORÇAGE LEXICAL (même design que chargerEchantillonsDomaines) : les
  // mots-clés FR+EN de chaque domaine sont eux-mêmes des échantillons —
  // garantie que chaque pool possède son vocabulaire noyau avant l'exposition
  // aux données professionnelles.
  const samples: TrainingSample[] = [];
  for (const src of SOURCES) {
    const idDomaine = src.label.replace("DOM_", "").toLowerCase();
    const domaine = DOMAINES_GEN3.find((d) => d.id === idDomaine);
    if (!domaine) continue;
    for (const motCle of domaine.motsCles) {
      samples.push({ text: motCle, label: src.label });
    }
  }
  for (const src of SOURCES) {
    const chemin = join(process.cwd(), "datasets", src.dossier, "train.jsonl");
    const lignes = readJsonl(chemin);
    let pris = 0;
    for (const o of lignes) {
      if (pris >= src.quota) break;
      const texte = o.instruction.slice(0, 160); // instruction seule : tokens discriminatifs concentrés
      if (tokenize(texte).length < 4) continue;
      samples.push({ text: texte, label: src.label });
      pris++;
    }
  }
  return samples;
}

function readJsonl(chemin: string): Array<{ instruction: string; output: string }> {
  if (!existsSync(chemin)) return [];
  const out: Array<{ instruction: string; output: string }> = [];
  for (const l of readFileSync(chemin, "utf8").split("\n").filter(Boolean)) {
    try {
      const o = JSON.parse(l) as { instruction: string; output: string };
      if (o.instruction && o.output) out.push(o);
    } catch { /* multi-physique préexistant */ }
  }
  return out;
}

const SEED = 20261126;
const EPOQUES = 15;

const samples = chargerEchantillons();
console.log(`Échantillons réels: ${samples.length}`);
if (samples.length < 150) throw new Error("dataset réel insuffisant — expérience refusée (honnêteté)");

const splits = separerDataset(samples, SEED);
const hash = hashSplits(splits);
console.log(`Splits: train=${splits.train.length} val=${splits.validation.length} test=${splits.test.length} hash=${hash}`);

const runtime = getNeuralRuntime();
enregistrerPoolsDomaines(runtime.espace);
const trainer = new NeuralTrainer(runtime.reseau, runtime.espace, runtime.veille, runtime.noyau);

const baselineTest = trainer.evaluerEchantillonsDomaines(splits.test);
const baselineVal = trainer.evaluerEchantillonsDomaines(splits.validation);
console.log(`Baseline AVANT entraînement: test=${baselineTest.toFixed(4)} val=${baselineVal.toFixed(4)}`);

const rapportEntrainement = await trainer.trainDomaines(splits.train, { epochs: EPOQUES, testRatio: 0, lrBoost: 0.2, cyclesParEchantillon: 5 });
console.log(`Entraînement: samples=${rapportEntrainement.samples} accTrain=${rapportEntrainement.accuracyTrain?.toFixed(4) ?? "?"}`);

const accTrain = trainer.evaluerEchantillonsDomaines(splits.train.slice(0, 200));
const accVal = trainer.evaluerEchantillonsDomaines(splits.validation);
const accTest = trainer.evaluerEchantillonsDomaines(splits.test);
console.log(`APRÈS: train=${accTrain.toFixed(4)} val=${accVal.toFixed(4)} test=${accTest.toFixed(4)}`);

const sauvegarde = await (await import("../lib/neural/runtime")).sauvegarderCerveauRuntime();
let version: string | null = null;
let _info: Record<string, unknown> | null = null;
if (sauvegarde) {
  const manifeste = sauvegarderVersion("experience-domaines-pro", {
    seed: SEED, epoques: EPOQUES, hashSplits: hash,
    baselineTest, accTrain, accVal, accTest,
    echantillons: samples.length,
    generalisation: Number((accTest - baselineTest).toFixed(4)),
  });
  version = manifeste.version;
  _info = manifeste.info as Record<string, unknown>;
  console.log(`Version persistée: ${version}`);
} else {
  console.log("WARN: sauvegarde du cerveau échouée — version non persistée");
}

const rapport = {
  date: new Date().toISOString(),
  job: "478451",
  graine: SEED,
  dataset: { total: samples.length, train: splits.train.length, validation: splits.validation.length, test: splits.test.length },
  hashSplits: hash,
  baselineTest,
  accuracies: { train: accTrain, validation: accVal, test: accTest },
  generalisation: Number((accTest - baselineTest).toFixed(4)),
  epoques: EPOQUES,
  version,
};
mkdirSync("var/neural/versions/rapports", { recursive: true });
writeFileSync("var/neural/versions/rapports/experience-domaines-pro.json", JSON.stringify(rapport, null, 1), "utf8");
console.log(JSON.stringify(rapport, null, 1));
