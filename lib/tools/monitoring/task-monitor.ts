import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";

/**
 * OUTIL « task.monitor » — surveillance RÉELLE des tâches de longue durée
 * (vague post-audit v2.1, audit outils §3 : « task.monitor — surveiller les
 * missions et gérer les reprises automatiquement »).
 *
 * RÉEL : lit l'état vÉRIFIABLE des deux sous-systèmes d'entraînement du
 * cerveau — le job d'entraînement neuronal (RAM process, job.ts) et la
 * boucle d'auto-apprentissage (état persisté var/entrainement-auto/etat.json,
 * etat.ts). Aucune donnée inventée : ce qui n'existe pas est déclaré absent.
 *
 * Lecture pure : aucun effet de bord, aucune écriture.
 */

export const TaskMonitorInput = z
  .object({
    inclureHistorique: z
      .boolean()
      .optional()
      .default(false)
      .describe("Inclure le dernier rapport du job d'entraînement terminé"),
  })
  .strict();

export type TaskMonitorInputType = z.infer<typeof TaskMonitorInput>;

export interface TaskMonitorOutput {
  /** Job d'entraînement neuronal : actif ou dernier, avec progression réelle. */
  entrainement: {
    /** "en_cours" | "termine" | "echec" | "aucun" (aucun job connu du process). */
    statut: string;
    source?: string;
    demarreLe?: string;
    termineLe?: string;
    epochCourante?: number;
    epochs?: number;
    nbEchantillons?: number;
    accuracyCourante?: number;
    erreur?: string;
    /** Rapport final (inclureHistorique) : métriques réelles du dernier job. */
    dernierRapport?: {
      accuracyTrain: number;
      accuracyTest: number;
      epochs: number;
      samples: number;
      dureeMs: number;
    } | null;
  };
  /** Boucle d'auto-apprentissage : régime, cycles, maîtrise (état persisté). */
  autoApprentissage: {
    regime: string;
    cyclesExecutes: number;
    enCours: boolean;
    datasetsIngestes: number;
    /** Domaines maîtrisés (critère réel : seuil + évaluations consécutives). */
    domainesMaitrises: string[];
    /** Dernier cycle exécuté (statut honnête : termine/partiel/echec/refuse). */
    dernierCycleStatut?: string;
    dernierCycleDate?: string;
  };
  /** Messages FR actionnables (prochaines étapes). */
  messages: string[];
}

export const taskMonitorTool: ToolDefinition<TaskMonitorInputType, TaskMonitorOutput> = {
  id: "task.monitor",
  name: "Surveillance des tâches du cerveau",
  description:
    "Consulte l'état RÉEL des tâches de longue durée : job d'entraînement neuronal (statut, progression, accuracy) et boucle d'auto-apprentissage (régime, cycles, domaines maîtrisés).",
  category: "system",
  risk: "low",
  inputSchema: TaskMonitorInput,
  async execute(input): Promise<TaskMonitorOutput> {
    // Job d'entraînement neuronal (server-only — ce module n'est exécuté que
    // côté serveur ; le stub vitest server-only couvre les tests).
    const { getJobEnCours, getDernierJob } = await import("@/lib/neural/training/job");
    const { lireEtatAuto } = await import("@/lib/entrainement-auto/etat");

    const actif = getJobEnCours();
    const dernier = getDernierJob();
    const job = actif ?? dernier;

    const entrainement: TaskMonitorOutput["entrainement"] = job
      ? {
          statut: job.status,
          ...(job.source !== undefined ? { source: job.source } : {}),
          demarreLe: job.demarreLe,
          ...(job.termineLe !== undefined ? { termineLe: job.termineLe } : {}),
          ...(job.epochCourante !== undefined ? { epochCourante: job.epochCourante } : {}),
          ...(job.epochs !== undefined ? { epochs: job.epochs } : {}),
          ...(job.nbEchantillons !== undefined ? { nbEchantillons: job.nbEchantillons } : {}),
          ...(job.accuracyCourante !== undefined
            ? { accuracyCourante: job.accuracyCourante }
            : {}),
          ...(job.erreur !== undefined ? { erreur: job.erreur } : {}),
        }
      : { statut: "aucun" };

    if (input.inclureHistorique) {
      const rapport = dernier?.rapport;
      entrainement.dernierRapport = rapport
        ? {
            accuracyTrain: rapport.accuracyTrain,
            accuracyTest: rapport.accuracyTest,
            epochs: rapport.epochs,
            samples: rapport.samples,
            dureeMs: rapport.dureeMs,
          }
        : null;
    }

    // État persisté de la boucle d'auto-apprentissage (lireEtatAuto retourne
    // l'état par défaut si le fichier n'existe pas encore — honnête).
    let etat;
    try {
      etat = await lireEtatAuto();
    } catch {
      etat = null;
    }

    const domainesMaitrises = etat
      ? Object.entries(etat.maitrise?.domaines ?? {})
          .filter(([, bloc]) => typeof bloc?.maitriseA === "string")
          .map(([id]) => id)
      : [];
    const dernierRapportCycle = etat?.historique?.[0];

    const autoApprentissage: TaskMonitorOutput["autoApprentissage"] = etat
      ? {
          regime: etat.regime,
          cyclesExecutes: etat.cyclesExecutes,
          enCours: etat.enCours === true,
          datasetsIngestes: Array.isArray(etat.datasetsIngestes)
            ? etat.datasetsIngestes.length
            : 0,
          domainesMaitrises,
          ...(dernierRapportCycle?.statut !== undefined
            ? { dernierCycleStatut: dernierRapportCycle.statut }
            : {}),
          ...(dernierRapportCycle?.demarreA !== undefined
            ? { dernierCycleDate: dernierRapportCycle.demarreA }
            : {}),
        }
      : {
          regime: "inconnu",
          cyclesExecutes: 0,
          enCours: false,
          datasetsIngestes: 0,
          domainesMaitrises: [],
        };

    const messages: string[] = [];
    if (entrainement.statut === "en_cours") {
      messages.push(
        `Entraînement neuronal en cours (${entrainement.epochCourante ?? "?"}/${entrainement.epochs ?? "?"} époques) — reviens avec task.monitor pour suivre la progression.`,
      );
    } else if (entrainement.statut === "termine") {
      messages.push(
        `Dernier entraînement terminé le ${entrainement.termineLe ?? "date inconnue"} — accuracy test ${(entrainement.dernierRapport?.accuracyTest ?? 0).toFixed(3)}.`,
      );
    } else if (entrainement.statut === "echec") {
      messages.push(
        `Dernier entraînement en échec${entrainement.erreur ? ` : ${entrainement.erreur}` : ""}.`,
      );
    } else {
      messages.push("Aucun job d'entraînement connu du processus actuel.");
    }
    messages.push(
      autoApprentissage.enCours
        ? `Boucle d'auto-apprentissage ACTIVE (régime ${autoApprentissage.regime}, ${autoApprentissage.cyclesExecutes} cycle(s) exécuté(s)).`
        : `Boucle d'auto-apprentissage au repos (${autoApprentissage.cyclesExecutes} cycle(s) cumulé(s), ${domainesMaitrises.length} domaine(s) maîtrisé(s)).`,
    );

    return { entrainement, autoApprentissage, messages };
  },
};
