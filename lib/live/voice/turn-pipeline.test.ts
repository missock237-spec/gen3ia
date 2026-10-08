import { beforeEach, describe, expect, it, vi } from "vitest";

import { runLiveVoiceTurn, resolveTurnAgent, type LiveVoiceTurnInput } from "./turn-pipeline";
import type { LiveVoiceSessionPayload, LiveVoiceTurnEvent } from "./protocol";

/**
 * Tests du pipeline de tour Live Voix (Task 110-a) — toutes les briques
 * externes sont mockées in-memory (ElevenLabs, answerAsAgent, repository
 * conversations, agents, mémoire épisodique, user-data-store, billUsage) :
 * on vérifie la SÉQUENCE d'événements du protocole
 * transcript → sentences → audios → usage → done, la persistance
 * best-effort, et les cas d'erreur (LIVE_STT_EMPTY, LIVE_TURN_FAILED,
 * LIVE_INSUFFICIENT_FUNDS).
 */

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

const sttMock = vi.fn();
const ttsMock = vi.fn();

vi.mock("@/lib/integrations/elevenlabs/client", () => ({
  elevenLabsSpeechToText: (...args: unknown[]) => sttMock(...args),
  elevenLabsTextToSpeech: (...args: unknown[]) => ttsMock(...args),
}));

const answerAsAgentMock = vi.fn();

vi.mock("@/lib/agents/chat-engine", () => ({
  answerAsAgent: (...args: unknown[]) => answerAsAgentMock(...args),
}));

const getAgentForUserMock = vi.fn();
const listAgentsForUserMock = vi.fn();

vi.mock("@/lib/agents/repository", () => ({
  getAgentForUser: (...args: unknown[]) => getAgentForUserMock(...args),
  listAgentsForUser: (...args: unknown[]) => listAgentsForUserMock(...args),
}));

const listMessagesMock = vi.fn();
const appendMessageMock = vi.fn();

vi.mock("@/lib/chat/repository", () => ({
  listMessages: (...args: unknown[]) => listMessagesMock(...args),
  appendMessage: (...args: unknown[]) => appendMessageMock(...args),
}));

const recallAgentContextMock = vi.fn();
const recordExchangeMock = vi.fn();

vi.mock("@/lib/memory/episodic", () => ({
  recallAgentContext: (...args: unknown[]) => recallAgentContextMock(...args),
  recordExchange: (...args: unknown[]) => recordExchangeMock(...args),
}));

const writeJsonMock = vi.fn();

vi.mock("@/lib/storage/user-data-store", () => ({
  newUlid: () => "01JTURNTURN000000000000TEST",
  userKey: (uid: string, ...segments: string[]) => `users/${uid}/${segments.join("/")}.json`,
  writeJson: (...args: unknown[]) => writeJsonMock(...args),
}));

const billUsageMock = vi.fn();

vi.mock("@/lib/billing/media-meter", () => ({
  billUsage: (...args: unknown[]) => billUsageMock(...args),
}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/* ------------------------------------------------------------------ */
/* Aides                                                               */
/* ------------------------------------------------------------------ */

function sessionPayload(overrides: Partial<LiveVoiceSessionPayload> = {}): LiveVoiceSessionPayload {
  const now = Date.now();
  return {
    uid: "user-1",
    conversationId: "conv-1",
    epoch: 1,
    issuedAt: now,
    exp: now + 600_000,
    jti: "jti-de-test",
    ...overrides,
  };
}

/** Réponse d'agent : deux phrases longues → deux chunks TTS distincts. */
const PHRASE_1 =
  "Voici la synthèse détaillée de votre activité commerciale sur les douze derniers mois avec les tendances par canal de vente, les marges observées et les points d'attention pour le trimestre à venir.";
const REPLY_DEUX_PHRASES = `${PHRASE_1} ${PHRASE_1.replace("Voici", "Voilà")}`;

function baseInput(overrides: Partial<LiveVoiceTurnInput> = {}): LiveVoiceTurnInput {
  return {
    userId: "user-1",
    conversationId: "conv-1",
    session: sessionPayload(),
    audioBuffer: Buffer.from("audio-factice"),
    audioMimeType: "audio/wav",
    audioDurationSec: 6,
    ...overrides,
  };
}

async function collect(input: LiveVoiceTurnInput): Promise<LiveVoiceTurnEvent[]> {
  const events: LiveVoiceTurnEvent[] = [];
  for await (const event of runLiveVoiceTurn(input)) events.push(event);
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  sttMock.mockResolvedValue({ text: "  Quelle est la météo ?  " });
  ttsMock.mockImplementation(async (options: { text: string }) => ({
    audioBase64: "QUJDREVG",
    mimeType: "audio/mpeg",
    voiceId: "voice-1",
    modelId: "eleven_flash_v2_5",
    charactersUsed: options.text.length,
  }));
  answerAsAgentMock.mockResolvedValue(REPLY_DEUX_PHRASES);
  listMessagesMock.mockResolvedValue([]);
  appendMessageMock.mockResolvedValue({});
  getAgentForUserMock.mockResolvedValue(null);
  listAgentsForUserMock.mockResolvedValue([]);
  recallAgentContextMock.mockResolvedValue(undefined);
  recordExchangeMock.mockResolvedValue(undefined);
  writeJsonMock.mockResolvedValue(undefined);
  billUsageMock.mockImplementation(async (params: { kind: string }) => ({
    reference: `ref_${params.kind}`,
    chargeMinor: params.kind === "audio_transcription" ? 5 : params.kind === "tts" ? 10 : 20,
    reserveMinor: 40,
  }));
});

/* ------------------------------------------------------------------ */
/* Scénarios                                                           */
/* ------------------------------------------------------------------ */

describe("runLiveVoiceTurn — flux nominal", () => {
  it("séquence transcript → sentences → audios → usage → done", async () => {
    const events = await collect(baseInput());

    expect(events.map((event) => event.type)).toEqual([
      "transcript",
      "sentence",
      "audio",
      "sentence",
      "audio",
      "usage",
      "done",
    ]);
    expect(events[0]).toEqual({ type: "transcript", text: "Quelle est la météo ?" });
    expect(events[1]).toMatchObject({ type: "sentence", index: 0 });
    expect(events[2]).toEqual({
      type: "audio",
      index: 0,
      dataUri: "data:audio/mpeg;base64,QUJDREVG",
      mimeType: "audio/mpeg",
    });
    const usage = events[5] as Extract<LiveVoiceTurnEvent, { type: "usage" }>;
    const done = events[6] as Extract<LiveVoiceTurnEvent, { type: "done" }>;
    expect(usage.breakdown).toEqual({ sttMinor: 5, ttsMinor: 10, agentMinor: 20 });
    expect(usage.costMinor).toBe(35);
    expect(usage.difficulty).toBe("standard"); // réponse > 350 chars (et ≤ 900)
    expect(done.turnId).toBe("01JTURNTURN000000000000TEST");
    expect(done.replyText).toBe(REPLY_DEUX_PHRASES);
  });

  it("STT appelé avec un data URI data:<mime>;base64 du buffer ; TTS eleven_flash_v2_5", async () => {
    await collect(baseInput());
    const sttArg = sttMock.mock.calls[0]![0] as { audioDataUri: string };
    expect(sttArg.audioDataUri).toBe(
      `data:audio/wav;base64,${Buffer.from("audio-factice").toString("base64")}`,
    );
    expect(ttsMock).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "eleven_flash_v2_5" }),
    );
  });

  it("historique chargé (fenêtre recent 20) et répondu via answerAsAgent avec la consigne orale", async () => {
    listMessagesMock.mockResolvedValue([
      { id: "m1", role: "user", content: "Bonjour" },
      { id: "m2", role: "assistant", content: "Bonjour !" },
      { id: "m3", role: "system", content: "interne ignoré" },
    ]);
    await collect(baseInput());

    expect(listMessagesMock).toHaveBeenCalledWith("user-1", "conv-1", 20, { order: "recent" });
    expect(answerAsAgentMock).toHaveBeenCalledTimes(1);
    const [userId, , history, message, contextNote] = answerAsAgentMock.mock.calls[0]!;
    expect(userId).toBe("user-1");
    expect(history).toEqual([
      { role: "user", content: "Bonjour" },
      { role: "assistant", content: "Bonjour !" },
    ]);
    expect(message).toBe("Quelle est la météo ?");
    expect(contextNote).toContain("SESSION LIVE VOIX");
  });

  it("facturation par tour : STT (secondes audio) puis TTS (caractères) + voice_agent (minutes)", async () => {
    await collect(baseInput({ audioDurationSec: 12.5 }));
    const kinds = billUsageMock.mock.calls.map((call) => call[0].kind);
    expect(kinds).toEqual(["audio_transcription", "tts", "voice_agent"]);

    const sttCall = billUsageMock.mock.calls[0]![0];
    expect(sttCall.quantity).toBe(12.5);
    expect(sttCall.executionId).toBe("01JTURNTURN000000000000TEST");

    const composition = billUsageMock.mock.calls.find((call) => call[0].kind === "voice_agent")![0];
    expect(complexityOf(composition)).toBe(1.6); // difficulté standard
    expect(composition.quantity).toBeGreaterThanOrEqual(0.01); // durée du tour en minutes
  });

  it("persistance best-effort : messages user/assistant, mémoire épisodique, audit usage R2", async () => {
    const events = await collect(baseInput());
    const usage = events.find((event): event is Extract<LiveVoiceTurnEvent, { type: "usage" }> => event.type === "usage")!;

    expect(appendMessageMock).toHaveBeenCalledTimes(2);
    const userMessage = appendMessageMock.mock.calls[0]![0] as Record<string, unknown>;
    const assistantMessage = appendMessageMock.mock.calls[1]![0] as Record<string, unknown>;
    expect(userMessage).toMatchObject({
      userId: "user-1",
      conversationId: "conv-1",
      role: "user",
      content: "Quelle est la météo ?",
      metadata: { live: true, epoch: 1, difficulty: "standard" },
    });
    expect(assistantMessage).toMatchObject({
      role: "assistant",
      content: REPLY_DEUX_PHRASES,
      metadata: { live: true, costMinor: usage.costMinor, difficulty: "standard" },
    });

    expect(recordExchangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        conversationId: "conv-1",
        userMessage: "Quelle est la météo ?",
        assistantReply: REPLY_DEUX_PHRASES,
        mode: "chat",
      }),
    );

    expect(writeJsonMock).toHaveBeenCalledWith(
      "users/user-1/live/usage/01JTURNTURN000000000000TEST.json",
      expect.objectContaining({
        turnId: "01JTURNTURN000000000000TEST",
        uid: "user-1",
        conversationId: "conv-1",
        epoch: 1,
        difficulty: "standard",
        costMinor: usage.costMinor,
        breakdown: usage.breakdown,
        audioSeconds: 6,
      }),
    );
  });

  it("agent actif de l'utilisateur résolu : mémoire épisodique rappelée et rattachée à son id", async () => {
    listAgentsForUserMock.mockResolvedValue([
      {
        id: "agent-1",
        ownerId: "user-1",
        name: "Coach Pro",
        description: "Coach commercial",
        type: "universal",
        typeLabel: "Coach",
        skills: ["vente"],
        agentMode: "standard",
        status: "active",
      },
    ]);
    recallAgentContextMock.mockResolvedValue("[Souvenirs pertinents…]");
    const events = await collect(baseInput());

    expect(events[events.length - 1]).toMatchObject({ type: "done" });
    expect(recallAgentContextMock).toHaveBeenCalledWith("user-1", "agent-1", "Quelle est la météo ?");
    const contextNote = answerAsAgentMock.mock.calls[0]![4] as string;
    expect(contextNote).toContain("SESSION LIVE VOIX");
    expect(contextNote).toContain("[Souvenirs pertinents…]");
    expect(recordExchangeMock.mock.calls[0]![0]).toMatchObject({ agentId: "agent-1" });
  });

  it("agentId demandé explicitement → getAgentForUser consulté en priorité", async () => {
    getAgentForUserMock.mockResolvedValue({
      id: "agent-42",
      ownerId: "user-1",
      name: "Agent Demandé",
      description: "",
      type: "universal",
      typeLabel: "Sur mesure",
      skills: [],
      agentMode: "standard",
      status: "active",
    });
    await resolveTurnAgent("user-1", "agent-42");
    expect(getAgentForUserMock).toHaveBeenCalledWith("user-1", "agent-42");
    expect(listAgentsForUserMock).not.toHaveBeenCalled();
  });
});

describe("runLiveVoiceTurn — anomalies du protocole", () => {
  it("STT sans texte → LIVE_STT_EMPTY, réponse ET facturation agent absentes", async () => {
    sttMock.mockResolvedValue({ text: "   " });
    const events = await collect(baseInput({ audioDurationSec: 0 }));

    expect(events.map((event) => event.type)).toEqual(["transcript", "error"]);
    expect(events[1]).toMatchObject({ type: "error", code: "LIVE_STT_EMPTY" });
    expect(answerAsAgentMock).not.toHaveBeenCalled();
    expect(ttsMock).not.toHaveBeenCalled();
    expect(billUsageMock).not.toHaveBeenCalled();
    expect(appendMessageMock).not.toHaveBeenCalled();
  });

  it("STT sans texte mais audio chronométré : la facturation STT seule reste due", async () => {
    sttMock.mockResolvedValue({ text: "" });
    const events = await collect(baseInput({ audioDurationSec: 3 }));

    expect(events[events.length - 1]).toMatchObject({ type: "error", code: "LIVE_STT_EMPTY" });
    expect(billUsageMock).toHaveBeenCalledTimes(1);
    expect(billUsageMock.mock.calls[0]![0]).toMatchObject({ kind: "audio_transcription", quantity: 3 });
  });

  it("panne STT → LIVE_TURN_FAILED (événement final unique)", async () => {
    sttMock.mockRejectedValue(new Error("ElevenLabs speech-to-text returned 500: boom"));
    const events = await collect(baseInput());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "LIVE_TURN_FAILED" });
    expect(answerAsAgentMock).not.toHaveBeenCalled();
    expect(billUsageMock).not.toHaveBeenCalled();
  });

  it("solde insuffisant à la facturation STT → LIVE_INSUFFICIENT_FUNDS (tour interrompu)", async () => {
    billUsageMock.mockRejectedValue(new Error("Insufficient wallet balance for this operation."));
    const events = await collect(baseInput());

    expect(events.map((event) => event.type)).toEqual(["transcript", "error"]);
    expect(events[1]).toMatchObject({ type: "error", code: "LIVE_INSUFFICIENT_FUNDS" });
    expect(answerAsAgentMock).not.toHaveBeenCalled();
  });

  it("solde insuffisant à la composition (TTS/agent) → LIVE_INSUFFICIENT_FUNDS après les audios", async () => {
    billUsageMock.mockImplementation(async (params: { kind: string }) => {
      if (params.kind === "audio_transcription") return { chargeMinor: 5, reserveMinor: 10 };
      throw new Error("Insufficient wallet balance for this operation.");
    });
    const events = await collect(baseInput());

    expect(events.map((event) => event.type)).toEqual([
      "transcript",
      "sentence",
      "audio",
      "sentence",
      "audio",
      "error",
    ]);
    expect(events[events.length - 1]).toMatchObject({ type: "error", code: "LIVE_INSUFFICIENT_FUNDS" });
    expect(events.some((event) => event.type === "usage")).toBe(false);
  });

  it("panne TTS d'une phrase → tour poursuivi : sentence sans audio, usage + done présents", async () => {
    ttsMock.mockImplementation(async (options: { text: string }) => {
      if (options.text.startsWith("Voilà")) throw new Error("ElevenLabs TTS returned 503");
      return { audioBase64: "QUJDREVG", mimeType: "audio/mpeg", charactersUsed: options.text.length };
    });
    const events = await collect(baseInput());

    expect(events.map((event) => event.type)).toEqual([
      "transcript",
      "sentence",
      "audio",
      "sentence",
      "usage",
      "done",
    ]);
    const usage = events.find((event): event is Extract<LiveVoiceTurnEvent, { type: "usage" }> => event.type === "usage")!;
    // Seuls les caractères réellement synthétisés sont facturés.
    expect(usage.breakdown.ttsMinor).toBe(10);
    expect(usage.breakdown.ttsMinor).toBeLessThan(20);
  });

  it("réponse vide de l'agent → LIVE_TURN_FAILED sans facturation ni TTS", async () => {
    answerAsAgentMock.mockResolvedValue("   ");
    const events = await collect(baseInput());

    expect(events.map((event) => event.type)).toEqual(["transcript", "error"]);
    expect(events[1]).toMatchObject({ type: "error", code: "LIVE_TURN_FAILED" });
    expect(ttsMock).not.toHaveBeenCalled();
    expect(billUsageMock).toHaveBeenCalledTimes(1); // STT seul
  });

  it("historique indisponible (conversation supprimée) → LIVE_TURN_FAILED", async () => {
    listMessagesMock.mockRejectedValue(new Error("Conversation introuvable."));
    const events = await collect(baseInput());

    expect(events.map((event) => event.type)).toEqual(["transcript", "error"]);
    expect(events[1]).toMatchObject({ type: "error", code: "LIVE_TURN_FAILED" });
    expect(answerAsAgentMock).not.toHaveBeenCalled();
  });

  it("échec de persistance : avalé (logger) — le flux nominal reste complet", async () => {
    appendMessageMock.mockRejectedValue(new Error("R2 indisponible"));
    recordExchangeMock.mockRejectedValue(new Error("R2 indisponible"));
    writeJsonMock.mockRejectedValue(new Error("R2 indisponible"));
    const events = await collect(baseInput());

    expect(events[events.length - 1]).toMatchObject({ type: "done" });
    expect(events.some((event) => event.type === "usage")).toBe(true);
  });
});

/** helper : complexité portée par l'appel billUsage. */
function complexityOf(call: Record<string, unknown>): number {
  return call.complexity as number;
}
