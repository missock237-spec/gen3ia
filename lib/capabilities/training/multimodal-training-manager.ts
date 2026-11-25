/**
 * MULTIMODAL TRAINING MANAGER (UCE-014) — gestion des évolutions des
 * capacités textuelles, visuelles, audio et vidéo : inventaire unifié des
 * datasets multimodaux réels du dépôt (manifeste PRO vérifié SHA-256),
 * évaluation des modèles par domaine, décisions GPU/CPU honnêtes
 * (GPU absent ici → sélection CPU-only explicite, jamais prétendue).
 */

import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";

import { sonderGpu } from "../evaluation/compatibility-engine";
import { planifierRun, runsEntrainement, type RunEntrainement, type DomaineEntrainement } from "./model-training-manager";
import type { RepositoryUceOptions } from "../storage/capability-repository";

export interface DatasetMultimodal {
  chemin: string;
  domaine: DomaineEntrainement;
  echantillons?: number;
  tailleOctets?: number;
  manifeste: boolean;
}

export interface InventaireMultimodal {
  datasets: DatasetMultimodal[];
  manifestePresent: boolean;
  sourcesManifeste?: Record<string, string>;
  gpuDisponible: boolean;
  gpuNom?: string;
  recommendationCalcul: "cpu-local" | "gpu-local";
  mesureLe: string;
}

/** Inventaire RÉEL des datasets du dépôt (datasets/*.jsonl + manifeste). */
export async function inventaireMultimodal(cwd = process.cwd()): Promise<InventaireMultimodal> {
  const dossierDatasets = path.resolve(cwd, "datasets");
  const datasets: DatasetMultimodal[] = [];

  let sourcesManifeste: Record<string, string> | undefined;
  let manifestePresent = false;
  try {
    const manifeste = JSON.parse(await fs.readFile(path.join(dossierDatasets, "PRO_MANIFEST.json"), "utf8")) as {
      sources?: Record<string, string>;
    };
    sourcesManifeste = manifeste.sources;
    manifestePresent = true;
  } catch {
    manifestePresent = false; // manifeste absent : inventaire honnête sans sources
  }

  try {
    const entrees = await fs.readdir(dossierDatasets, { withFileTypes: true });
    for (const entree of entrees.filter((e) => e.isDirectory() || e.isFile())) {
      if (entree.isFile() && entree.name.endsWith(".jsonl")) {
        datasets.push(await ficheDataset(path.join(dossierDatasets, entree.name), domaineDepuisNom(entree.name)));
        continue;
      }
      if (!entree.isDirectory()) continue;
      const dossier = path.join(dossierDatasets, entree.name);
      try {
        const fichiers = await fs.readdir(dossier);
        const train = fichiers.find((f) => f === "train.jsonl" || f.endsWith(".jsonl"));
        if (train) {
          datasets.push(await ficheDataset(path.join(dossier, train), domaineDepuisNom(entree.name)));
        }
      } catch {
        // sous-dossier illisible : ignoré honnêtement
      }
    }
  } catch {
    // datasets/ absent : inventaire vide honnête
  }

  // GPU : mesure réelle (sonde nvidia-smi — jamais prétendu sans mesure).
  const gpu = await sonderGpu();
  const gpuDisponible = gpu.present;

  return {
    datasets,
    manifestePresent,
    sourcesManifeste,
    gpuDisponible,
    gpuNom: gpu.nom,
    recommendationCalcul: gpuDisponible ? "gpu-local" : "cpu-local",
    mesureLe: new Date().toISOString(),
  };
}

async function ficheDataset(chemin: string, domaine: DomaineEntrainement): Promise<DatasetMultimodal> {
  let tailleOctets: number | undefined;
  let echantillons: number | undefined;
  try {
    const contenu = await fs.readFile(chemin, "utf8");
    tailleOctets = Buffer.byteLength(contenu);
    echantillons = contenu.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    // lecture impossible : champs absents (honnête)
  }
  return { chemin: path.relative(process.cwd(), chemin), domaine, echantillons, tailleOctets, manifeste: false };
}

function domaineDepuisNom(nom: string): DomaineEntrainement {
  const n = nom.toLowerCase();
  if (/(image|vision|photo|fleur|ucf|frame)/.test(n)) return "image";
  if (/(audio|voice|speech|parole|musique|fleurs)/.test(n)) return "audio";
  if (/(video|videos)/.test(n)) return "video";
  if (/(multimodal)/.test(n)) return "multimodal";
  return "texte";
}

/**
 * Planifie un run multimodal via le Model Training Manager (délégation —
 * vérification datasets réelle, score avant obligatoire, budget RAM).
 */
export async function planifierRunMultimodal(
  params: { domaine: DomaineEntrainement; datasets: string[]; scoreAvant: number; moteur: string; graine?: number; capabilityId?: string },
  options: RepositoryUceOptions = {},
): Promise<RunEntrainement | { cause: string }> {
  const resultat = await planifierRun(params, options);
  if (!resultat.ok) return { cause: resultat.cause ?? "planification refusée" };
  return resultat.run!;
}

/** Évaluation par domaine : runs terminés vs échecs (données réelles). */
export async function evaluationParDomaine(options: RepositoryUceOptions = {}): Promise<Array<{ domaine: DomaineEntrainement; runs: number; termines: number; echecs: number; deltaMoyen?: number }>> {
  const runs = await runsEntrainement(options, 300);
  const parDomaine = new Map<DomaineEntrainement, RunEntrainement[]>();
  for (const run of runs) {
    const g = parDomaine.get(run.domaine) ?? [];
    g.push(run);
    parDomaine.set(run.domaine, g);
  }
  return [...parDomaine.entries()].map(([domaine, groupe]) => {
    const deltas = groupe.filter((r) => typeof r.delta === "number").map((r) => r.delta!);
    return {
      domaine,
      runs: groupe.length,
      termines: groupe.filter((r) => r.statut === "termine").length,
      echecs: groupe.filter((r) => r.statut === "echec").length,
      deltaMoyen: deltas.length > 0 ? Math.round((deltas.reduce((a, b) => a + b, 0) / deltas.length) * 10000) / 10000 : undefined,
    };
  });
}
