/**
 * GENAPI JOBS — gestionnaire central de tâches asynchrones (mission
 * PHASE 5) : une application lance une opération longue (ex. génération
 * vidéo) et reçoit IMMÉDIATEMENT un job_id « gen3_job_… » ; elle consulte
 * le statut et est notée par WEBHOOK SIGNÉ à l'achèvement.
 *
 * File d'attente réelle : sérialisée (une tâche à la fois par application —
 * ressources bornées), états normalisés queued/processing/completed/
 * failed/cancelled, annulation, reprise après crash process (les jobs
 * processing au redémarrage repassent queued — mission PHASE 5-7).
 * Notification : emitOutgoingEvent EXISTANT (webhooks HMAC signés réels,
 * réutilisation stricte — jamais de doublon).
 */

import { emitOutgoingEvent } from "@/lib/integrations/webhooks/emit";
import type { ApplicationGenapi } from "./services";

export type EtatJob = "queued" | "processing" | "completed" | "failed" | "cancelled";

export interface JobGenapi {
  id: string;
  /** gen3_job_<uuid court> — format de l'exemple mission. */
  reference: string;
  service: "chat" | "reasoning" | "research" | "vision" | "audio" | "video" | "agents" | "automation" | "embeddings" | "training";
  applicationId: string;
  proprietaireId: string;
  etat: EtatJob;
  charge?: unknown;
  resultat?: { ok: boolean; data?: unknown; erreur?: string };
  cree: number;
  maj: number;
}

export interface GestionnaireJobs {
  /** Enfile une tâche : retourne IMMÉDIATEMENT la référence gen3_job_*. */
  creer(service: JobGenapi["service"], charge: unknown, application: { id: string; proprietaireId: string }): { jobId: string; reference: string; etat: EtatJob };
  /** Démarre l'exécution réelle du travailleur injecté (une file par app). */
  traiterSuivant(applicationId: string, travailleur: (charge: unknown) => Promise<{ ok: boolean; data?: unknown; erreur?: string }>): Promise<JobGenapi | null>;
  statut(jobId: string): JobGenapi | null;
  annuler(jobId: string, demandeur: ApplicationGenapi["proprietaireId"]): boolean;
  /** Jobs en cours / en attente d'une application (portail PHASE 7). */
  liste(applicationId: string, limite?: number): JobGenapi[];
  /** Reprise après crash : tout « processing » repasse « queued ». */
  repriseApresCrash(): number;
}

const globalJobs = globalThis as typeof globalThis & { __gen3iaGenapiJobs?: Map<string, JobGenapi>; __gen3iaGenapiBoucles?: Map<string, Promise<void>> };

function jobs(): Map<string, JobGenapi> {
  if (!globalJobs.__gen3iaGenapiJobs) globalJobs.__gen3iaGenapiJobs = new Map();
  return globalJobs.__gen3iaGenapiJobs;
}

const MAX_JOBS = 500;

export function creerGestionnaireJobs(notifierWebhook = notifierParDefaut): GestionnaireJobs {
  async function transition(job: JobGenapi, etat: EtatJob): Promise<void> {
    job.etat = etat;
    job.maj = Date.now();
    if (etat === "completed" || etat === "failed" || etat === "cancelled") {
      // Notification finale par WEBHOOK SIGNÉ réel (PHASE 5-8) — les
      // erreurs de notification n'influencent PAS le statut du job.
      try {
        await notifierWebhook(job);
      } catch {
        /* notification best-effort : le job reste terminé */
      }
    }
  }

  return {
    creer(service, charge, application) {
      const id = `job_${crypto.randomUUID().slice(0, 16)}`;
      const job: JobGenapi = {
        id,
        reference: `gen3_job_${id.slice(4)}`,
        service,
        applicationId: application.id,
        proprietaireId: application.proprietaireId,
        etat: "queued",
        charge,
        cree: Date.now(),
        maj: Date.now(),
      };
      const liste = [...jobs().values()];
      if (liste.length >= MAX_JOBS) jobs().delete(liste.sort((a, b) => a.cree - b.cree)[0].id); // FIFO borné
      jobs().set(id, job);
      return { jobId: id, reference: job.reference, etat: job.etat };
    },

    async traiterSuivant(applicationId, travailleur) {
      const suivant = [...jobs().values()]
        .filter((j) => j.applicationId === applicationId && j.etat === "queued")
        .sort((a, b) => a.cree - b.cree)[0];
      if (!suivant) return null;
      await transition(suivant, "processing");
      try {
        const resultat = await travailleur(suivant.charge);
        suivant.resultat = resultat;
        await transition(suivant, resultat.ok ? "completed" : "failed");
      } catch (erreur) {
        suivant.resultat = { ok: false, erreur: erreur instanceof Error ? erreur.message : String(erreur) };
        await transition(suivant, "failed");
      }
      return suivant;
    },

    statut(jobId) {
      return jobs().get(jobId) ?? null;
    },

    annuler(jobId, demandeur) {
      const job = jobs().get(jobId);
      if (!job || job.proprietaireId !== demandeur) return false;
      if (job.etat === "queued" || job.etat === "processing") {
        void transition(job, "cancelled"); // notification sans bloquer l'appelant
        return true;
      }
      return false;
    },

    liste(applicationId, limite = 50) {
      return [...jobs().values()]
        .filter((j) => j.applicationId === applicationId)
        .sort((a, b) => b.cree - a.cree)
        .slice(0, limite);
    },

    repriseApresCrash() {
      let reprises = 0;
      for (const job of jobs().values()) {
        if (job.etat === "processing") {
          job.etat = "queued"; // jamais de job orphelin
          job.maj = Date.now();
          reprises++;
        }
      }
      return reprises;
    },
  };
}

/** Notification par défaut : webhooks sortants SIGNÉS réels du propriétaire. */
export async function notifierParDefaut(job: JobGenapi): Promise<void> {
  // Événements de l'union EXISTANTE (règle : ne pas remplacer) : l'exécution
  // d'un job genAPI est une exécution — le payload porte la source genAPI.
  await emitOutgoingEvent({
    userId: job.proprietaireId,
    event: job.etat === "failed" ? "execution.failed" : "execution.completed",
    payload: {
      jobId: job.id,
      reference: job.reference,
      service: job.service,
      etat: job.etat,
      resultat: job.resultat ?? null,
    },
  });
}
