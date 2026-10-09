import "server-only";

import { logger } from "@/lib/observability/logger";
import {
  elevenLabsSpeechToText,
  elevenLabsTextToSpeech,
} from "@/lib/integrations/elevenlabs/client";
import {
  appendMessage,
  listMessages,
  type ChatMessage,
} from "@/lib/chat/repository";
import { answerAsAgent, type ChatHistoryMessage } from "@/lib/agents/chat-engine";
import { getAgentForUser, listAgentsForUser } from "@/lib/agents/repository";
import type { AgentRecord } from "@/lib/agents/schema";
import { recallAgentContext, recordExchange } from "@/lib/memory/episodic";
import { newUlid, userKey, writeJson } from "@/lib/storage/user-data-store";

import { billCompositionUsage, billSttUsage, isInsufficientFundsError, resolveDifficulty } from "./cost";
import type {
  LiveVoiceSessionPayload,
  LiveVoiceTurnEvent,
  LiveVoiceUsageBreakdown,
} from "./protocol";
import { splitSentences } from "./sentence-split";
import { voiceCharterNote } from "./voice-charter";

/**
 * Pipeline d'un TOUR de parole « Live Voix » (Task 110-a) — orchestrateur en
 * async generator : chaque étape réelle ÉMET un événement du protocole
 * (NDJSON côté route /api/live/voice/turn) :
 *
 *   STT ElevenLabs (Scribe) → `transcript`
 *   → facturation STT (solde insuffisant → `error` LIVE_INSUFFICIENT_FUNDS)
 *   → historique R2 (fenêtre recent) + agent → réponse `answerAsAgent`
 *   → difficulté serveur (cost.ts) → découpe phrases FR
 *   → TTS eleven_flash_v2_5 par phrase → `sentence` + `audio`
 *   → facturation TTS + voice_agent → `usage` → `done`
 *   → persistance BEST-EFFORT (jamais bloquant) : messages R2, mémoire
 *     épisodique, audit usage users/{uid}/live/usage/{turnId}.json.
 *
 * Un échec émet un événement `error` FINAL (protocole : le client cesse
 * d'attendre dès la première erreur).
 */

/** Fenêtre d'historique chargée pour le contexte de réponse. */
const HISTORY_WINDOW = 20;

/** Modèle TTS du Live Voix (flash : latence minimale, FR correct). */
const TTS_MODEL = "eleven_flash_v2_5";

/** Identifiant mémoire de l'agent « plateforme » synthétique (sans id R2). */
const PLATFORM_AGENT_MEMORY_ID = "live-voice-universal";

/** Forme d'agent attendue par answerAsAgent (extrait de AgentRecord). */
export type LiveVoiceTurnAgent = Pick<
  AgentRecord,
  "name" | "description" | "type" | "typeLabel" | "skills" | "agentMode" | "memoryFile" | "preferredModel"
>;

/** Agent résolu pour un tour : forme answerAsAgent + id réel si disponible. */
export type ResolvedTurnAgent = LiveVoiceTurnAgent & { id?: string };

export interface LiveVoiceTurnInput {
  userId: string;
  conversationId: string;
  /** Charge utile du jeton de session vérifié (epoch pour la persistance). */
  session: LiveVoiceSessionPayload;
  audioBuffer: Buffer;
  audioMimeType: string;
  /** Secondes d'audio (facturation STT — 0 = inconnu, facturation skippée). */
  audioDurationSec: number;
  /** Optionnel : agent du Studio demandé explicitement pour la session. */
  agentId?: string;
  /** Identifiant du tour (= executionId de facturation) ; défaut : ULID. */
  turnId?: string;
  /**
   * Task 114-b — voix ElevenLabs du JUMEAU pour la synthèse du tour (voix
   * clonée/utilisateur résolue par l'appelant via lib/voice/user-voice.ts).
   * Absent ou null → comportement historique (voix plateforme). La route
   * live (app/api/live/voice/turn) branchera `voiceId: await
   * resolveUserVoiceId(auth.uid)` — paramètre prêt, périmètre 114-b.
   */
  voiceId?: string;
}

/**
 * Agent « plateforme » synthétique universel : même forme que le type
 * attendu par answerAsAgent (valeurs par défaut de lib/agents/schema.ts).
 * Utilisé quand l'utilisateur n'a aucun agent actif — le Live Voix reste
 * conversationnel et polyvalent.
 */
function syntheticUniversalAgent(): ResolvedTurnAgent {
  return {
    name: "Gen3ia",
    description:
      "Assistant universel Gen3ia en session Live Voix : conversation naturelle, questions, tâches courtes.",
    type: "universal",
    typeLabel: "Assistant universel",
    skills: [],
    agentMode: "standard",
    memoryFile: undefined,
    preferredModel: undefined,
  };
}

/**
 * Résolution d'agent pour un tour : l'agent demandé s'il existe, sinon le
 * premier agent actif de l'utilisateur, sinon l'agent plateforme synthétique.
 * Ne lève JAMAIS : un échec de lecture R2 replie sur l'agent plateforme.
 */
export async function resolveTurnAgent(userId: string, agentId?: string): Promise<ResolvedTurnAgent> {
  if (agentId) {
    try {
      const agent = await getAgentForUser(userId, agentId);
      if (agent) return agent;
    } catch (error) {
      logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          userId,
          agentId,
        },
        "[live-voice] lecture de l'agent demandé impossible, repli",
      );
    }
  }
  try {
    const agents = await listAgentsForUser(userId);
    const active = agents.find((candidate) => candidate.status === "active");
    if (active) return active;
  } catch (error) {
    logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        userId,
      },
      "[live-voice] lecture des agents impossible, repli plateforme",
    );
  }
  return syntheticUniversalAgent();
}

/** Historique récent mappé vers ChatHistoryMessage (rôles chat uniquement). */
async function loadHistory(userId: string, conversationId: string): Promise<ChatHistoryMessage[]> {
  const messages: ChatMessage[] = await listMessages(userId, conversationId, HISTORY_WINDOW, {
    order: "recent",
  });
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role, content: message.content }));
}

/** Persistance best-effort d'une étape : échec → logger.error, jamais bloquant. */
async function persistStep(label: string, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    logger.error(
      {
        err: error instanceof Error ? error.message : String(error),
        label,
      },
      "[live-voice] persistance du tour en échec",
    );
  }
}

/**
 * Orchestration complète d'un tour de parole. Async generator : consommer
 * avec `for await` et sérialiser chaque événement en NDJSON.
 */
export async function* runLiveVoiceTurn(
  input: LiveVoiceTurnInput,
): AsyncGenerator<LiveVoiceTurnEvent, void, undefined> {
  const turnId = input.turnId ?? newUlid();
  const startedAt = Date.now();
  const mimeType = input.audioMimeType?.trim() || "audio/wav";

  /* 1) STT ElevenLabs — data URI data:<mime>;base64, chargé en une fois. */
  let transcript: string;
  try {
    const audioDataUri = `data:${mimeType};base64,${input.audioBuffer.toString("base64")}`;
    const stt = await elevenLabsSpeechToText({ audioDataUri });
    transcript = (stt.text ?? "").trim();
  } catch (error) {
    logger.error(
      {
        err: error instanceof Error ? error.message : String(error),
        turnId,
        userId: input.userId,
      },
      "[live-voice] échec STT du tour",
    );
    yield {
      type: "error",
      code: "LIVE_TURN_FAILED",
      message: "La transcription vocale a échoué. Réessaie dans un instant.",
    };
    return;
  }

  yield { type: "transcript", text: transcript };

  /* STT réussi mais AUCUN texte : événement dédié, jamais de facturation
   * agent (pas de réponse) ; la facturation STT reste due (l'appel a eu
   * lieu) — tentée en best-effort pour ne pas masquer LIVE_STT_EMPTY. */
  if (!transcript) {
    try {
      await billSttUsage({ userId: input.userId, turnId, audioSeconds: input.audioDurationSec });
    } catch (error) {
      logger.error(
        {
          err: error instanceof Error ? error.message : String(error),
          turnId,
        },
        "[live-voice] facturation STT (tour sans parole) en échec",
      );
    }
    yield {
      type: "error",
      code: "LIVE_STT_EMPTY",
      message: "Aucune parole n'a été détectée dans l'audio. Rapproche-toi du micro et réessaie.",
    };
    return;
  }

  /* 2) Facturation STT (après STT réussi) — solde insuffisant : arrêt propre. */
  let sttMinor = 0;
  try {
    sttMinor = await billSttUsage({ userId: input.userId, turnId, audioSeconds: input.audioDurationSec });
  } catch (error) {
    if (isInsufficientFundsError(error)) {
      yield {
        type: "error",
        code: "LIVE_INSUFFICIENT_FUNDS",
        message: error instanceof Error ? error.message : "Crédit insuffisant pour ce tour de parole.",
      };
      return;
    }
    logger.error(
      {
        err: error instanceof Error ? error.message : String(error),
        turnId,
      },
      "[live-voice] facturation STT en échec, tour interrompu",
    );
    yield {
      type: "error",
      code: "LIVE_TURN_FAILED",
      message: "La facturation du tour a échoué. Réessaie dans un instant.",
    };
    return;
  }

  /* 3) Historique R2 (fenêtre recent) + agent, puis réponse de l'agent. */
  let history: ChatHistoryMessage[];
  let agent: ResolvedTurnAgent;
  try {
    [history, agent] = await Promise.all([
      loadHistory(input.userId, input.conversationId),
      resolveTurnAgent(input.userId, input.agentId),
    ]);
  } catch (error) {
    logger.error(
      {
        err: error instanceof Error ? error.message : String(error),
        turnId,
        conversationId: input.conversationId,
      },
      "[live-voice] chargement de l'historique/agent en échec",
    );
    yield {
      type: "error",
      code: "LIVE_TURN_FAILED",
      message: "Impossible de charger le contexte de la conversation. Réessaie dans un instant.",
    };
    return;
  }

  let reply: string;
  try {
    // Mémoire épisodique (best-effort interne : recallAgentContext ne lève
    // pas) — note combinée à la consigne orale, comme dans le chat agent.
    const memoryNote = agent.id
      ? await recallAgentContext(input.userId, agent.id, transcript)
      : undefined;
    const charter = voiceCharterNote();
    const contextNote = memoryNote ? `${charter}\n\n${memoryNote}` : charter;
    reply = await answerAsAgent(input.userId, agent, history, transcript, contextNote);
  } catch (error) {
    logger.error(
      {
        err: error instanceof Error ? error.message : String(error),
        turnId,
      },
      "[live-voice] réponse de l'agent en échec",
    );
    yield {
      type: "error",
      code: "LIVE_TURN_FAILED",
      message: "La réponse de l'agent a échoué. Réessaie dans un instant.",
    };
    return;
  }

  if (!reply.trim()) {
    yield {
      type: "error",
      code: "LIVE_TURN_FAILED",
      message: "L'agent n'a pas produit de réponse. Reformule ou réessaie.",
    };
    return;
  }

  /* 4) Difficulté serveur (transcript + réponse), 5) découpe + TTS phrase par
   * phrase : chaque phrase émet `sentence` puis, si la synthèse réussit,
   * `audio`. Un échec TTS de phrase N'ARRÊTE PAS le tour (phrase émise sans
   * audio, log) — le texte reste affiché côté client. La voix du jumeau
   * (Task 114-b) s'applique au tour ENTIER quand input.voiceId est fourni. */
  const difficulty = resolveDifficulty(transcript, reply);
  const sentences = splitSentences(reply);
  let ttsChars = 0;

  for (let index = 0; index < sentences.length; index += 1) {
    const phrase = sentences[index]!;
    yield { type: "sentence", index, text: phrase };
    try {
      const audio = await elevenLabsTextToSpeech({
        text: phrase,
        modelId: TTS_MODEL,
        ...(input.voiceId ? { voiceId: input.voiceId } : {}),
      });
      ttsChars += audio.charactersUsed;
      yield {
        type: "audio",
        index,
        dataUri: `data:${audio.mimeType};base64,${audio.audioBase64}`,
        mimeType: audio.mimeType,
      };
    } catch (error) {
      logger.error(
        {
          err: error instanceof Error ? error.message : String(error),
          turnId,
          index,
        },
        "[live-voice] échec TTS d'une phrase (tour poursuivi sans cet audio)",
      );
    }
  }

  /* 6) Facturation de composition (TTS + voice_agent, durée réelle du tour).
   * Solde insuffisant → LIVE_INSUFFICIENT_FUNDS (session stoppée proprement
   * côté client) ; autre panne → LIVE_TURN_FAILED. */
  const turnDurationMs = Date.now() - startedAt;
  let composition: { ttsMinor: number; agentMinor: number };
  try {
    composition = await billCompositionUsage({
      userId: input.userId,
      turnId,
      ttsChars,
      turnDurationMs,
      difficulty,
    });
  } catch (error) {
    if (isInsufficientFundsError(error)) {
      yield {
        type: "error",
        code: "LIVE_INSUFFICIENT_FUNDS",
        message: error instanceof Error ? error.message : "Crédit insuffisant pour ce tour de parole.",
      };
      return;
    }
    logger.error(
      {
        err: error instanceof Error ? error.message : String(error),
        turnId,
      },
      "[live-voice] facturation de composition en échec",
    );
    yield {
      type: "error",
      code: "LIVE_TURN_FAILED",
      message: "La facturation du tour a échoué. Réessaie dans un instant.",
    };
    return;
  }

  const breakdown: LiveVoiceUsageBreakdown = {
    sttMinor,
    ttsMinor: composition.ttsMinor,
    agentMinor: composition.agentMinor,
  };
  const costMinor = breakdown.sttMinor + breakdown.ttsMinor + breakdown.agentMinor;

  /* 7) Usage + done : le flux nominal se termine TOUJOURS par `done`. */
  yield { type: "usage", turnId, difficulty, costMinor, breakdown };
  yield { type: "done", turnId, replyText: reply };

  /* 8) Persistance BEST-EFFORT (après done, jamais bloquant) : messages R2
   * avec métadonnées live, mémoire épisodique, audit usage R2 par tour. */
  const appendInput = (role: "user" | "assistant", content: string, metadata: Record<string, unknown>) =>
    ({
      userId: input.userId,
      conversationId: input.conversationId,
      role,
      content,
      metadata,
    }) as Parameters<typeof appendMessage>[0];

  await persistStep("message utilisateur", async () => {
    await appendMessage(
      appendInput("user", transcript, { live: true, epoch: input.session.epoch, difficulty }),
    );
  });
  await persistStep("message assistant", async () => {
    await appendMessage(
      appendInput("assistant", reply, { live: true, costMinor, difficulty }),
    );
  });
  await persistStep("mémoire épisodique", async () => {
    await recordExchange({
      userId: input.userId,
      agentId: agent.id ?? PLATFORM_AGENT_MEMORY_ID,
      conversationId: input.conversationId,
      userMessage: transcript,
      assistantReply: reply,
      mode: "chat",
    });
  });
  await persistStep("audit usage R2", async () => {
    await writeJson(userKey(input.userId, "live", "usage", turnId), {
      v: 1,
      turnId,
      uid: input.userId,
      conversationId: input.conversationId,
      epoch: input.session.epoch,
      jti: input.session.jti,
      difficulty,
      costMinor,
      breakdown,
      audioSeconds: input.audioDurationSec,
      ttsChars,
      replyChars: reply.length,
      turnDurationMs,
      createdAt: new Date().toISOString(),
    });
  });
}
