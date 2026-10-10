import "server-only";

import { randomUUID } from "crypto";

import { createQueuedMission, markMissionEnqueueFailed } from "@/lib/queue/mission-queue";
import { tickQueueConfigured, enqueueMissionTick } from "@/lib/queue/tick-queue";
import { resolveJobOrigin } from "@/lib/queue/origin";
import type { RuntimePlan } from "@/lib/agents/runtime/types";
import type { OutcomeContract } from "@/lib/agents/outcome-contract";

/**
 * CONTINUATION DE MISSION DEPUIS UN CHEMIN SYNCHRONE (exigence production :
 * « même si l'utilisateur actualise le projet plusieurs fois, si une tâche a
 * été lancée, la conversation ou l'agent IA doit continuer sans s'arrêter »).
 *
 * Une mission lancée dans une requête HTTP (chat d'agent, tâche workspace,
 * planification) est bornée par la fenêtre serverless. Quand le runtime
 * s'arrête PROPREMENT sur son échéance de tranche (état « paused » avec des
 * étapes restantes), ce module enfile la suite dans la FILE DE TICKS R2
 * (ex-QStash) : le tick suivant reprend depuis le checkpoint et la mission
 * se poursuit EN ARRIÈRE-PLAN — onglet fermé, actualisé ou supprimé.
 *
 * Le mécanisme est exactement celui des missions async (/api/agents/run) :
 * bail transactionnel, checkpoint, ré-enfilement. Aucun nouveau worker.
 */

export interface MissionContinuationInput {
  userId: string;
  executionId: string;
  objective: string;
  plan: RuntimePlan;
  projectId?: string;
  orgId?: string;
  outcomeContract?: OutcomeContract;
  /** Conversation à tenir informée (message final + run réconcilié au tick). */
  conversationId?: string;
  /**
   * DÉPRÉCIÉ / IGNORÉ (fix CodeQL request-forgery) : la destination du tick
   * est désormais dérivée de l'ORIGINE CANONIQUE du serveur
   * (GEN3IA_APP_ORIGIN, allowlist — lib/queue/origin.ts), jamais d'une
   * origine fournie par l'appelant (falsifiable). Champ conservé en option
   * pour compatibilité des appelants existants — sans effet.
   */
  origin?: string;
}

export interface MissionContinuationResult {
  queued: boolean;
  runId?: string;
  reason?: string;
}

/**
 * Enfile la suite d'une mission interrompue par l'échéance de tranche.
 * Retourne { queued: false } (jamais une exception) si la file n'est pas
 * configurée : l'appelant conserve alors le comportement historique
 * (checkpoint + reprise manuelle).
 */
export async function enqueueMissionContinuation(input: MissionContinuationInput): Promise<MissionContinuationResult> {
  if (!tickQueueConfigured()) {
    return { queued: false, reason: "File d'attente non configurée — reprise manuelle disponible." };
  }
  // ORIGINE CANONIQUE AVANT TOUTE ÉCRITURE (fix request-forgery) : si
  // GEN3IA_APP_ORIGIN est absente/invalide, on ne crée PAS le document de
  // file — un publish refusé après création laisserait une mission fantôme
  // « queued » sans tick. L'appelant garde la reprise manuelle.
  const resolvedOrigin = resolveJobOrigin();
  if (!resolvedOrigin.ok) {
    return { queued: false, reason: "Origine canonique non résolue (GEN3IA_APP_ORIGIN) — reprise manuelle disponible." };
  }
  const runId = randomUUID();
  try {
    await createQueuedMission({
      runId,
      executionId: input.executionId,
      userId: input.userId,
      objective: input.objective,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.orgId ? { orgId: input.orgId } : {}),
      ...(input.outcomeContract ? { outcomeContract: input.outcomeContract } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      plan: input.plan,
    });
    // enqueueMissionTick résout DÉJÀ l'origine canonique en interne ; le
    // contrôle ci-dessus garantit seulement qu'aucun document n'est créé
    // quand la publication est vouée au refus.
    await enqueueMissionTick(runId);
    return { queued: true, runId };
  } catch (error) {
    // L'enfilement a échoué : la mission de file est marquée honnêtement en
    // échec (si le doc existe), et l'appelant retombe sur la reprise manuelle.
    await markMissionEnqueueFailed(runId, error).catch(() => undefined);
    return { queued: false, reason: error instanceof Error ? error.message : "Enfilement impossible." };
  }
}
