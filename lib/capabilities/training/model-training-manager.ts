/**
 * MODEL TRAINING MANAGER (UCE-013) — gestion UNIFIÉE des entraînements
 * (texte et générique). L'UCE ne réimplémente PAS l'entraînement : elle
 * GÈRE les runs (inventaire, budgets, pré/post obligatoires, versionnement
 * des poids) et DÉLÈGUE aux moteurs réels du dépôt (lib/gen3 entraînement,
 * continual-learning du cerveau).
 *
 * Garanties mission précédente conservées : train/val/test séparés, mesure
 * avant/après obligatoire, rollback si régression, paramètres versionnés.
 *
 * v2 (2026-11-27 — audit entraînement, vérifié) : AUCUN consommateur de
 * production à ce jour (grep dépôt — planifierRun/cloreRun ne sont appelés
 * nulle part hors tests et multimodal-training-manager, lui-même sans
 * appelant). L'orchestration RÉELLE des entraînements est :
 *   — lib/neural/training/job.ts (statuts en_cours→termine/echec),
 *     consommé par lib/mlops/pipeline.ts + app/api/neural/train|state|brain ;
 *   — la boucle auto-apprentissage lib/entrainement-auto/boucle.ts
 *     (évaluations mesurées accuracyTrain/Test, maîtrise par domaine).
 * PHASE 1 GTIS (2026-11-28) — BRANCHEMENT RÉEL : le moteur vrai du dépôt
 * (lib/neural/training/job.ts → lancerEntrainement) déclare DÉSORMAIS un
 * run pour chaque job qu'il lance (scoreAvant mesuré sur le cortex avant
 * toute passe), le lie à son jobId, puis le clôt avec le scoreApres mesuré
 * (anti-régression -0.02, leçon enregistrée) — ou le marque echec/annulé si
 * le job échoue. Le pipeline MLOps (lib/mlops/pipeline.ts) et la route
 * /api/neural/train héritent du branchement par le même point d'entrée.
 * Nomenclature UNIQUE : statutJobVersRun() (GTIS Phase 1 — une seule
 * correspondance job ↔ run, consommée par le branchement). Reprise après
 * interruption : un job interrompu ne persiste RIEN (sauvegarde du cerveau
 * en fin de job seulement) — le cerveau recharge l'état persisté et un
 * NOUVEAU job reprend le travail de façon idempotente ; les runs
 * « en_cours » orphelins (jobId disparu) sont clôturés honnêtement par
 * cloreRunsOrphelins(), jamais laissés stagner.
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
  /** Identifiant du JOB RÉEL lié (lib/neural/training/job.ts — Phase 1 GTIS). */
  jobId?: string;
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

/**
 * Racines de données RÉELLES du dépôt acceptées pour un run (GTIS Phase 1) :
 *  - datasets/                    — jeux PRO manifestés (Job 478451) ;
 *  - training/gen3-domain-datasets/data/ — échantillons des 19 domaines
 *    (commis, externes HF/Kaggle, complets) réellement chargés par
 *    lib/neural/training/domaines.ts ;
 *  - public/llms*.txt             — corpus d'amorçage du cerveau (chargé
 *    par lib/neural/training/dataset.ts).
 * Tout autre chemin (y compris ../, racine du dépôt, fichiers publics non
 * corpus) est rejeté — la garde de confinement reste fermée par défaut.
 */
const RACINES_DATASETS_AUTORISEES = [
  "datasets",
  path.join("training", "gen3-domain-datasets", "data"),
];
const MOTIF_CORPUS_PUBLIC = /^llms[^/\\]*\.txt$/;

function cheminAutorise(chemin: string, cwd: string): boolean {
  for (const racine of RACINES_DATASETS_AUTORISEES) {
    if (chemin.startsWith(path.resolve(cwd, racine) + path.sep)) return true;
  }
  // Corpus d'amorçage : public/llms*.txt uniquement (nom vérifié).
  if (chemin.startsWith(path.resolve(cwd, "public") + path.sep)) {
    return MOTIF_CORPUS_PUBLIC.test(path.basename(chemin));
  }
  return false;
}

/** Vérifie que les datasets demandés EXISTENT réellement dans le dépôt. */
export async function verifierDatasets(chemins: string[], cwd = process.cwd()): Promise<Array<{ chemin: string; existe: boolean; tailleOctets?: number; sha256?: string }>> {
  const { createHash } = await import("node:crypto");
  const resultats: Array<{ chemin: string; existe: boolean; tailleOctets?: number; sha256?: string }> = [];
  for (const cheminRelatif of chemins.slice(0, 20)) {
    const chemin = path.resolve(cwd, cheminRelatif);
    // Garde de confinement : uniquement les racines de données réelles du dépôt.
    if (!cheminAutorise(chemin, cwd)) {
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
    id: `run_${demande.domaine}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
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
 * Nomenclature UNIQUE job ↔ run (GTIS Phase 1) : le moteur réel
 * (lib/neural/training/job.ts) parle en en_cours/termine/echec ; le run
 * UCE-013 adopte le MÊME vocabulaire pour ces trois états (planifie et
 * annule restent propres au gestionnaire : déclaration avant job, annulation
 * sans exécution).
 */
export type StatutJobNeural = "en_cours" | "termine" | "echec";

export function statutJobVersRun(statut: StatutJobNeural): StatutJobNeural {
  if (statut === "en_cours") return "en_cours";
  if (statut === "termine") return "termine";
  return "echec";
}

/**
 * PHASE 1 GTIS — lie un run à son JOB RÉEL qui démarre : planifie → en_cours
 * avec jobId + horodatage. Idempotent : re-marquer le même run avec le même
 * jobId est un no-op accepté (polling/reprise) ; un autre jobId est refusé
 * (un run = un job).
 */
export async function demarrerRun(
  runId: string,
  jobId: string,
  options: RepositoryUceOptions = {},
): Promise<ResultatRun> {
  const { recuperer } = await import("../storage/capability-repository");
  const run = await recuperer<RunEntrainement>("resources", runId, options);
  if (!run) return { ok: false, cause: `run « ${runId} » introuvable` };
  if (run.statut === "termine" || run.statut === "echec" || run.statut === "annule") {
    return { ok: false, cause: `run déjà clôturé (${run.statut}) : impossible de le démarrer` };
  }
  if (run.jobId && run.jobId !== jobId) {
    return { ok: false, cause: `run déjà lié au job « ${run.jobId} » : un run = un job` };
  }
  run.jobId = jobId;
  run.statut = "en_cours";
  run.demarreLe = run.demarreLe ?? maintenantIso();
  await sauvegarder("resources", run, options);
  return { ok: true, run };
}

/**
 * PHASE 1 GTIS — marque un run echec SANS scoreApres (job échoué avant toute
 * mesure après : pas de delta fabrique — la cause réelle est enregistrée et
 * la leçon consignée). Distinct de cloreRun (qui exige un scoreApres mesuré).
 */
export async function echouerRun(
  runId: string,
  cause: string,
  options: RepositoryUceOptions = {},
): Promise<ResultatRun> {
  const { recuperer } = await import("../storage/capability-repository");
  const run = await recuperer<RunEntrainement>("resources", runId, options);
  if (!run) return { ok: false, cause: `run « ${runId} » introuvable` };
  if (run.statut === "termine" || run.statut === "echec" || run.statut === "annule") {
    return { ok: false, cause: `run déjà clôturé (${run.statut}) : pas de double clôture` };
  }
  run.statut = "echec";
  run.cause = cause.slice(0, 400);
  run.termineLe = maintenantIso();
  await sauvegarder("resources", run, options);

  await enregistrerLearning({
    kind: "neural",
    lecon: `run ${runId} ÉCHOUÉ : ${run.cause} — aucun paramètre adopté, reprise = nouveau job depuis l'état persisté du cerveau`,
    avant: run.scoreAvant,
    jeuTest: "mesure de référence avant job (scores par thème du corpus)",
    capabilityId: run.capabilityId,
    valide: false,
    regressionDetectee: false,
    dossier: options.dossier,
  });

  return { ok: true, run };
}

/**
 * PHASE 1 GTIS — reprise idempotente : clôture honnêtement les runs
 * « en_cours » dont le jobId n'est plus vivant (process interrompu — le job
 * n'a jamais persisté le cerveau, donc AUCUN paramètre n'a été adopté). Les
 * runs « planifie » sans job ne sont PAS touchés (fenêtre de déclaration
 * légitime d'un job qui démarre).
 */
export async function cloreRunsOrphelins(
  idsJobsVivants: string[],
  options: RepositoryUceOptions = {},
): Promise<{ orphelinsClos: string[] }> {
  const vivants = new Set(idsJobsVivants.filter(Boolean));
  const runs = await runsEntrainement(options);
  const orphelinsClos: string[] = [];
  for (const run of runs) {
    if (run.statut !== "en_cours") continue;
    if (run.jobId && vivants.has(run.jobId)) continue;
    const resultat = await echouerRun(
      run.id,
      `run orphelin : job « ${run.jobId ?? "inconnu"} » disparu (process interrompu avant persistance) — reprise idempotente = nouveau job depuis l'état persisté`,
      options,
    );
    if (resultat.ok) orphelinsClos.push(run.id);
  }
  return { orphelinsClos };
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
  if (run.statut === "termine" || run.statut === "echec" || run.statut === "annule") {
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
