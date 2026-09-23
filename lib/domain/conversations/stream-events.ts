/**
 * Événements de flux du tour conversationnel — le moteur émet une suite
 * d'événements typés au fil de l'exécution ; la route de streaming les
 * sérialise en NDJSON et le client les consomme pour un rendu en direct :
 * phases de travail, fragments de texte, étapes d'outils, validations,
 * artefacts, résultat final.
 *
 * Garantie de persistance : le serveur persiste TOUT (messages, run,
 * validations, artefacts) indépendamment du flux — un client qui perd la
 * connexion retrouve la conversation complète au rechargement.
 */

import type {
  ConversationApproval,
  ConversationArtifact,
  ConversationMessage,
  ConversationRun,
  RunStep,
} from "./types";

export type StreamPhase = "intention" | "image" | "plan" | "execution" | "synthesis";

export type ConversationStreamEvent =
  /** Le message utilisateur est persisté — le tour démarre réellement. */
  | { type: "turn_started"; conversationId: string; userMessage: ConversationMessage }
  /** Étape de travail en cours (compréhension, planification, exécution…). */
  | { type: "status"; phase: StreamPhase; label: string }
  /** Un run vient d'être créé (plan d'exécution suivi étape par étape). */
  | { type: "run_created"; run: ConversationRun }
  | { type: "run_status"; runId: string; status: ConversationRun["status"] }
  /** Mise à jour d'une étape du run (démarrage, sortie, échec, attente…). */
  | { type: "step_update"; runId: string; step: RunStep }
  /** Une action sensible attend la validation humaine (carte inline). */
  | { type: "approval_created"; approval: ConversationApproval }
  /** Un livrable vient d'être produit (aperçu immédiat). */
  | { type: "artifact_created"; artifact: ConversationArtifact }
  /** Fragment de texte de la réponse de l'assistant (token streaming). */
  | { type: "message_delta"; delta: string }
  /** Réponse de l'assistant persistée (remplace la version en cours). */
  | { type: "message_complete"; message: ConversationMessage }
  /** Tour terminé : état final consolidé. */
  | {
      type: "done";
      assistantMessage: ConversationMessage;
      run?: ConversationRun;
      artifacts: ConversationArtifact[];
      approvals: ConversationApproval[];
    }
  /** Erreur en cours de tour (le client affiche une erreur inline). */
  | { type: "error"; message: string };

/** Émetteur d'événements : ne doit JAMAIS interrompre le tour (client
 *  déconnecté, sérialisation impossible…) — les erreurs d'émission sont
 *  avalées volontairement, la persistance serveur reste autoritaire. */
export type StreamEventEmitter = (event: ConversationStreamEvent) => Promise<void> | void;

/** Émetteur no-op utilisé quand aucun flux n'est demandé (API classique). */
export const silentEmitter: StreamEventEmitter = () => {};

/** Enveloppe un émetteur pour garantir l'absence d'effet de bord. */
export function safeEmitter(emitter?: StreamEventEmitter): StreamEventEmitter {
  if (!emitter) return silentEmitter;
  return (event) => {
    try {
      const outcome = emitter(event);
      if (outcome instanceof Promise) {
        return outcome.catch(() => undefined).then(() => undefined);
      }
    } catch {
      /* émission impossible : le tour continue */
    }
    return Promise.resolve();
  };
}
