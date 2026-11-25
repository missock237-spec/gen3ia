/**
 * MODEL TRAINING MANAGER (UCE-013) — gestion UNIFIÉE des entraînements
 * (texte et générique). L'UCE ne réimplémente PAS l'entraînement : elle
 * GÈRE les runs (inventaire, budgets, pré/post obligatoires, versionnement
 * des poids) et DÉLÈGUE aux moteurs réels du dépôt (lib/gen3 entraînement,
 * continual-learning du cerveau).
 *
 * Garanties mission précédente conservées : train/val/test séparés, mesure
 * avant/après obligatoire, rollback si régression, paramètres versionnés.
 */

import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { maintenantIso } from "../core/capability-contract";
import { sauvegarder, lister, type RepositoryUceOptions } from "../storage/capability-repository";
import { enregistrerLearning } from "../builder/skill-generator";

export type DomaineEntrainement = "texte" | "image" | "audio" | "video" | "multimodal";

export interface RunEntrainement {
  id: string;
  capabilityId?: string;
  domaine: DomaineEntrainement;
  /** Fichiers dataset réels du dépôt (datasets/*.jsonl — manifeste PRO). */
  datasets: Array<{ chemin: string; tailleOctets?: number; sha256?: string }>;
  statut: "planifie" | "en_cours" | "termine" | "echec" | "annule";
  scoreAvant?: number;
  scoreApres?: number;
  /** Mesure du delta (régression interdite : must be >= -seuil). */
  delta?: number;
  moteur: string;
  graine?: number;
  demarreLe?: string;
  termineLe?: string;
  cause?: string;
}

export interface DemandeRun {
  capabilityId?: string;
  domaine: DomaineEntrainement;
  datasets: string[];
  /** Score de référence mesuré avant run (obligatoire pour valider). */
  scoreAvant: number;
  moteur: string;
  graine?: number;
}

export interface ResultatRun {
  ok: boolean;
  run?: RunEntrainement;
  cause?: string;
}

/** Vérifie que les datasets demandés EXISTENT réellement dans le dépôt. */
export async function verifierDatasets(chemins: string[], cwd = process.cwd()): Promise<Array<{ chemin: string; existe: boolean; tailleOctets?: number; sha256?: string }>> {
  const { createHash } = await import("node:crypto");
  const resultats: Array<{ chemin: string; existe: boolean; tailleOctets?: number; sha256?: string }> = [];
  for (const cheminRelatif of chemins.slice(0, 20)) {
    const chemin = path.resolve(cwd, cheminRelatif);
    // Garde de confinement : uniquement sous datasets/ du dépôt.
    if (!chemin.startsWith(path.resolve(cwd, "datasets") + path.sep)) {
      resultats.push({ chemin: cheminRelatif, existe: false });
      continue;
    }
    try {
      const contenu = await fs.readFile(chemin);
      resultats.push({
        chemin: cheminRelatif,
        existe: true,
        tailleOctets: contenu.length,
        sha256: createHash("sha256").update(contenu).digest("hex").slice(0, 32),
      });
    } catch {
      resultats.push({ chemin: cheminRelatif, existe: false });
    }
  }
  return resultats;
}

/**
 * Déclare un run d'entraînement : datasets réels vérifiés, score AVANT
 * obligatoire, budget ressources vérifié (mission §2 — Resource Manager).
 * Le run reste « planifie » : seul le moteur réel du dépôt l'exécute.
 */
export async function planifierRun(demande: DemandeRun, options: RepositoryUceOptions = {}): Promise<ResultatRun> {
  if (demande.datasets.length === 0) {
    return { ok: false, cause: "aucun dataset fourni : entraînement refusé" };
  }
  const datasets = await verifierDatasets(demande.datasets);
  const absents = datasets.filter((d) => !d.existe);
  if (absents.length > 0) {
    return { ok: false, cause: `datasets introuvables ou hors datasets/ : ${absents.map((d) => d.chemin).join(", ")}` };
  }
  if (typeof demande.scoreAvant !== "number") {
    return { ok: false, cause: "score avant mesuré obligatoire (RÈGLE 4 : pas d'adaptation sans mesure initiale)" };
  }

  // Budget ressources : RAM libre réelle du système (mesure os, jamais estimée).
  const ramLibreMo = Math.round(os.freemem() / (1024 * 1024));
  if (ramLibreMo < 512) {
    return { ok: false, cause: `RAM libre insuffisante (${ramLibreMo} Mo < 512 Mo) : run refusé` };
  }

  const run: RunEntrainement = {
    id: `run_${demande.domaine}_${Date.now().toString(36)}`,
    capabilityId: demande.capabilityId,
    domaine: demande.domaine,
    datasets,
    statut: "planifie",
    scoreAvant: demande.scoreAvant,
    moteur: demande.moteur,
    graine: demande.graine,
  };
  await sauvegarder("resources", run, options);
  return { ok: true, run };
}

/**
 * Clôture un run avec le score APRÈS réel : termine le run, calcule le
 * delta, refuse la régression (delta < -0.02 → statut echec + trace) et
 * enregistre la leçon (versionnement des poids à la charge du moteur réel).
 */
export async function cloreRun(runId: string, scoreApres: number, options: RepositoryUceOptions & { seuilDegradation?: number } = {}): Promise<ResultatRun> {
  const { recuperer } = await import("../storage/capability-repository");
  const run = await recuperer<RunEntrainement>("resources", runId, options);
  if (!run) return { ok: false, cause: `run « ${runId} » introuvable` };
  if (run.statut !== "planifie" && run.statut !== "en_cours") {
    return { ok: false, cause: `run déjà clôturé (${run.statut}) : pas de double clôture` };
  }
  const seuilDegradation = options.seuilDegradation ?? 0.02;
  const delta = scoreApres - (run.scoreAvant ?? 0);
  const regression = delta < -seuilDegradation;

  run.statut = regression ? "echec" : "termine";
  run.scoreApres = scoreApres;
  run.delta = delta;
  run.termineLe = maintenantIso();
  run.cause = regression ? `régression mesurée (${delta.toFixed(4)} < -${seuilDegradation}) : poids NON adoptés (rollback moteur)` : undefined;
  await sauvegarder("resources", run, options);

  await enregistrerLearning({
    kind: "neural",
    lecon: regression
      ? `run ${runId} REJETÉ : régression ${delta.toFixed(4)} sur le jeu de test — paramètres non adoptés (règle anti-régression)`
      : `run ${runId} validé : delta ${delta.toFixed(4)} mesuré sur jeu indépendant`,
    avant: run.scoreAvant,
    apres: scoreApres,
    jeuTest: "jeu de test indépendant (l'appelant garantit la séparation train/val/test)",
    capabilityId: run.capabilityId,
    valide: !regression,
    regressionDetectee: regression,
    dossier: options.dossier,
  });

  return { ok: !regression, run, cause: run.cause };
}

/** Inventaire des runs (admin/cerveau). */
export async function runsEntrainement(options: RepositoryUceOptions = {}, limite = 100): Promise<RunEntrainement[]> {
  return (await lister<RunEntrainement>("resources", undefined, limite, options)).filter((r) => typeof r.domaine === "string");
}
