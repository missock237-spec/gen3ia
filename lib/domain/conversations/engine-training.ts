import "server-only";

/**
 * TOUR « ENTRAÎNEMENT DEPUIS LE CHAT » — l'entrée UNIQUE pour enseigner à
 * gen3 (demande utilisateur : « les utilisateurs doivent entraîner gen3
 * depuis le chat IA et pas ailleurs »).
 *
 * Détection déterministe (aucune variance LLM) : « apprends que / retiens
 * que / entraîne-toi / souviens-toi / note que / teach you / learn that ».
 * Le tour exécute RÉELLEMENT l'outil brain.train (cortex langagier —
 * plasticité par paires motif/réponse, idempotent) et répond honnêtement
 * avec les compteurs d'apprentissage.
 */

import { safeEmitter } from "./stream-events";
import { appendMessage } from "@/lib/chat/repository";
import { createArtifact } from "@/lib/domain/artifacts/repository";
import type { TurnBase } from "./engine-chat";
import type { ConversationTurnResult } from "./engine-turn";

/** Détection d'une intention d'entraînement (FR + EN). */
const MOTIFS_ENTRAINEMENT: RegExp[] = [
  /^\s*(apprends?|retiens?|souviens?-toi|note)\s+(?:que\s+|ça\s+que\s+|bien\s+)?/i,
  /^\s*entra[iî]ne[- ]toi\b/i,
  /^\s*je t'enseigne\b/i,
  /^\s*(learn|teach)\s+(you|this|that)\b/i,
  /^\s*remember that\b/i,
];

/** Contenu effectif après retrait du préfixe d'entraînement. */
export function extraireConnaissance(message: string): string | null {
  for (const motif of MOTIFS_ENTRAINEMENT) {
    const m = message.match(motif);
    if (m) {
      const reste = message.slice(m[0].length).trim();
      if (reste.length >= 3) return reste;
    }
  }
  return null;
}

/** Le message est-il un ordre d'entraînement ? (export pour tests/télémétrie) */
export function estIntentionEntrainement(message: string): boolean {
  return extraireConnaissance(message) !== null;
}

/** Le message demande-t-il explicitement le domaine abréviations ? */
function veutAbréviations(message: string): boolean {
  return /\babr[eé]viations?\b|\bsigles?\b|\bacronymes?\b/i.test(message);
}

export async function runTrainingTurn(ctx: TurnBase): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  try {
    const connaissance = extraireConnaissance(ctx.message) ?? ctx.message;
    const domain = veutAbréviations(ctx.message) ? "abbreviations" : "libre";

    await onEvent({ type: "status", phase: "execution", label: "Entraînement du cerveau en cours…" });

    const { brainTrainTool } = await import("@/lib/tools/brain-train");
    const résultat = await brainTrainTool.execute(
      { domain, texte: connaissance },
      { userId: ctx.userId, metadata: { conversationId: ctx.conversationId } },
    );

    const contenu =
      `✅ ${résultat.details}` +
      (domain === "abbreviations" && résultat.dictionnaireAbréviations
        ? `\n\nDictionnaire d'abréviations actif : ${résultat.dictionnaireAbréviations} sigles reconnus à chaque message.`
        : "") +
      "\n\nContinuez à m'enseigner depuis ce chat : chaque ligne « apprends que X signifie Y » est réellement apprise dans mon cortex langagier.";

    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: contenu,
      provider: "gen3-snn",
      model: "gen3-brain-train",
      generationStatus: "complete",
    });

    // Traçabilité : artefact « entraînement » consultable dans la bibliothèque.
    const artifact = await createArtifact({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      type: "document",
      title: `Entraînement : ${connaissance.slice(0, 60)}`,
      url: "",
      note: résultat.details,
    });

    await onEvent({ type: "message_complete", message: assistantMessage });
    await onEvent({ type: "artifact_created", artifact });

    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [artifact],
      approvals: [],
      intent: { mode: "chat", understanding: "Entraînement du cerveau depuis le chat (brain.train)." },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "L'entraînement a échoué.";
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content:
        `Je n'ai pas réussi à intégrer cette connaissance (${message}). ` +
        "Formule : « apprends que X signifie Y » — une connaissance par ligne.",
      provider: "gen3",
      model: "gen3-brain-train",
      generationStatus: "complete",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Entraînement échoué (message honnête)." },
    };
  }
}
