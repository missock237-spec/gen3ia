import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";
import { signLiveVoiceSession, verifyLiveVoiceSession } from "@/lib/live/voice/session-token";
import type { LiveVoiceTurnEvent } from "@/lib/live/voice/protocol";

/**
 * Tests de POST /api/live/voice/turn (Task 110-a) : garde PC, auth, rate
 * limit, validation du formulaire (audio ≤ 15 Mo, mime wav/mpeg/webm),
 * vérification du jeton (grâce 60 s, uid propriétaire), flux NDJSON
 * transcript → … → done (ou error final), durée WAV déduite de l'entête RIFF.
 * Le pipeline est mocké (contrat testé dans turn-pipeline.test.ts).
 */

const verifyFirebaseAuthMock = vi.fn();
const enforceRateLimitMock = vi.fn();
const captureMock = vi.fn();
const runLiveVoiceTurnMock = vi.fn();

vi.mock("@/lib/firebase/auth-server", () => ({
  verifyFirebaseAuth: (...args: unknown[]) => verifyFirebaseAuthMock(...args),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  enforceRateLimit: (...args: unknown[]) => enforceRateLimitMock(...args),
}));

vi.mock("@/lib/observability/sentry", () => ({
  captureServerException: (...args: unknown[]) => captureMock(...args),
}));

vi.mock("@/lib/live/voice/turn-pipeline", () => ({
  runLiveVoiceTurn: (...args: unknown[]) => runLiveVoiceTurnMock(...args),
}));

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** WAV 16 kHz mono factice : byteRate configurable, données `dataBytes`. */
function makeWav(byteRate = 32_000, dataBytes = 64_000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

function eventsGenerator(events: LiveVoiceTurnEvent[], finalThrow?: Error): () => AsyncGenerator<LiveVoiceTurnEvent> {
  return async function* () {
    for (const event of events) yield event;
    if (finalThrow) throw finalThrow;
  };
}

function nominalEvents(): LiveVoiceTurnEvent[] {
  return [
    { type: "transcript", text: "Bonjour" },
    { type: "sentence", index: 0, text: "Bonjour !" },
    { type: "audio", index: 0, dataUri: "data:audio/mpeg;base64,QQ==", mimeType: "audio/mpeg" },
    {
      type: "usage",
      turnId: "turn-1",
      difficulty: "simple",
      costMinor: 7,
      breakdown: { sttMinor: 1, ttsMinor: 2, agentMinor: 4 },
    },
    { type: "done", turnId: "turn-1", replyText: "Bonjour !" },
  ];
}

function postForm(form: FormData, userAgent = DESKTOP_UA): Request {
  return new Request("http://localhost:3000/api/live/voice/turn", {
    method: "POST",
    headers: { "user-agent": userAgent },
    body: form,
  });
}

/** FormData nominal : jeton valide + WAV 2 s + durationSec explicite. */
function nominalForm(token: string, wav = makeWav()): FormData {
  const form = new FormData();
  form.append("token", token);
  form.append("audio", new File([wav], "audio.wav", { type: "audio/wav" }));
  form.append("durationSec", "5");
  return form;
}

function parseNdjson(text: string): LiveVoiceTurnEvent[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LiveVoiceTurnEvent);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LIVE_VOICE_SECRET = "secret-de-test-live-voice";
  verifyFirebaseAuthMock.mockResolvedValue({ uid: "user-1" });
  enforceRateLimitMock.mockResolvedValue({ allowed: true, remaining: 59, retryAfterMs: 0, distributed: false });
  runLiveVoiceTurnMock.mockImplementation(eventsGenerator(nominalEvents()));
});

describe("POST /api/live/voice/turn", () => {
  it("happy path : flux NDJSON 200 (headers anti-buffer), événements du protocole dans l'ordre", async () => {
    const token = signLiveVoiceSession({ uid: "user-1", conversationId: "conv-1", epoch: 1 }).token;
    const response = await POST(postForm(nominalForm(token)));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const events = parseNdjson(await response.text());
    expect(events.map((event) => event.type)).toEqual([
      "transcript",
      "sentence",
      "audio",
      "usage",
      "done",
    ]);
    expect(events[events.length - 1]).toMatchObject({ type: "done", turnId: "turn-1" });

    // Le pipeline reçoit le contexte vérifié du jeton + l'audio.
    const input = runLiveVoiceTurnMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.userId).toBe("user-1");
    expect(input.conversationId).toBe("conv-1");
    expect(input.audioMimeType).toBe("audio/wav");
    expect(input.audioDurationSec).toBe(5);
    expect((input.session as { uid: string }).uid).toBe("user-1");
    expect((input.audioBuffer as Buffer).length).toBe(64_044);
  });

  it("durationSec absent : durée déduite de l'entête WAV (dataBytes / byteRate)", async () => {
    const token = signLiveVoiceSession({ uid: "user-1", conversationId: "conv-1", epoch: 1 }).token;
    const form = new FormData();
    form.append("token", token);
    form.append("audio", new File([makeWav(32_000, 64_000)], "audio.wav", { type: "audio/wav" }));
    await POST(postForm(form));

    const input = runLiveVoiceTurnMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.audioDurationSec).toBe(2);
  });

  it("entête WAV illisible → durée 0 (facturation STT skippée côté pipeline)", async () => {
    const token = signLiveVoiceSession({ uid: "user-1", conversationId: "conv-1", epoch: 1 }).token;
    const form = new FormData();
    form.append("token", token);
    form.append("audio", new File([Buffer.from("pas-un-wav")], "audio.wav", { type: "audio/wav" }));
    await POST(postForm(form));

    const input = runLiveVoiceTurnMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.audioDurationSec).toBe(0);
  });

  it("garde PC : mobile → 403 code LIVE_PC_ONLY", async () => {
    const token = signLiveVoiceSession({ uid: "user-1", conversationId: "conv-1", epoch: 1 }).token;
    const response = await POST(postForm(nominalForm(token), MOBILE_UA));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("LIVE_PC_ONLY");
    expect(runLiveVoiceTurnMock).not.toHaveBeenCalled();
  });

  it("authentification manquante → 401", async () => {
    verifyFirebaseAuthMock.mockRejectedValue(new Error("Missing authorization header."));
    const token = signLiveVoiceSession({ uid: "user-1", conversationId: "conv-1", epoch: 1 }).token;
    const response = await POST(postForm(nominalForm(token)));
    expect(response.status).toBe(401);
    expect(runLiveVoiceTurnMock).not.toHaveBeenCalled();
  });

  it("rate limit dépassé → 429 code LIVE_RATE_LIMITED", async () => {
    enforceRateLimitMock.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 30_000, distributed: true });
    const token = signLiveVoiceSession({ uid: "user-1", conversationId: "conv-1", epoch: 1 }).token;
    const response = await POST(postForm(nominalForm(token)));
    expect(response.status).toBe(429);
    expect(((await response.json()) as { code: string }).code).toBe("LIVE_RATE_LIMITED");
  });

  it("jeton absent → 403 code LIVE_SESSION_INVALID", async () => {
    const form = new FormData();
    form.append("audio", new File([makeWav()], "audio.wav", { type: "audio/wav" }));
    const response = await POST(postForm(form));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("LIVE_SESSION_INVALID");
  });

  it("jeton expiré au-delà de la grâce → 401 code LIVE_SESSION_EXPIRED", async () => {
    const token = signLiveVoiceSession(
      { uid: "user-1", conversationId: "conv-1", epoch: 1 },
      Date.now() - 600_000 - 61_000,
    ).token;
    const response = await POST(postForm(nominalForm(token)));
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe("LIVE_SESSION_EXPIRED");
    expect(runLiveVoiceTurnMock).not.toHaveBeenCalled();
  });

  it("jeton d'un autre utilisateur → 403 code LIVE_SESSION_INVALID", async () => {
    const token = signLiveVoiceSession({ uid: "user-2", conversationId: "conv-1", epoch: 1 }).token;
    const response = await POST(postForm(nominalForm(token)));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("LIVE_SESSION_INVALID");
    expect(runLiveVoiceTurnMock).not.toHaveBeenCalled();
  });

  it("audio manquant → 400 ; mime non supporté → 400 ; audio trop lourd → 413", async () => {
    const token = signLiveVoiceSession({ uid: "user-1", conversationId: "conv-1", epoch: 1 }).token;

    const sansAudio = new FormData();
    sansAudio.append("token", token);
    expect((await POST(postForm(sansAudio))).status).toBe(400);

    const mauvaisMime = new FormData();
    mauvaisMime.append("token", token);
    mauvaisMime.append("audio", new File([Buffer.from("ogg")], "audio.ogg", { type: "audio/ogg" }));
    expect((await POST(postForm(mauvaisMime))).status).toBe(400);

    const tropLourd = new FormData();
    tropLourd.append("token", token);
    tropLourd.append("audio", new File([new Uint8Array(15 * 1024 * 1024 + 1)], "audio.wav", { type: "audio/wav" }));
    expect((await POST(postForm(tropLourd))).status).toBe(413);
    expect(runLiveVoiceTurnMock).not.toHaveBeenCalled();
  });

  it("panne du pipeline en plein flux : error final LIVE_TURN_FAILED après les événements déjà émis", async () => {
    runLiveVoiceTurnMock.mockImplementation(
      eventsGenerator([{ type: "transcript", text: "Bonjour" }], new Error("panne interne")),
    );
    const token = signLiveVoiceSession({ uid: "user-1", conversationId: "conv-1", epoch: 1 }).token;
    const response = await POST(postForm(nominalForm(token)));

    const events = parseNdjson(await response.text());
    expect(events.map((event) => event.type)).toEqual(["transcript", "error"]);
    expect(events[1]).toMatchObject({ type: "error", code: "LIVE_TURN_FAILED" });
  });

  it("solde insuffisant : l'événement LIVE_INSUFFICIENT_FUNDS du pipeline traverse le flux NDJSON", async () => {
    runLiveVoiceTurnMock.mockImplementation(
      eventsGenerator([
        { type: "transcript", text: "Bonjour" },
        {
          type: "error",
          code: "LIVE_INSUFFICIENT_FUNDS",
          message: "Crédit insuffisant pour poursuivre la session Live Voix. Rechargez votre portefeuille.",
        },
      ]),
    );
    const token = signLiveVoiceSession({ uid: "user-1", conversationId: "conv-1", epoch: 1 }).token;
    const response = await POST(postForm(nominalForm(token)));

    expect(response.status).toBe(200);
    const events = parseNdjson(await response.text());
    expect(events[0]).toMatchObject({ type: "transcript", text: "Bonjour" });
    expect(events[1]).toMatchObject({ type: "error", code: "LIVE_INSUFFICIENT_FUNDS" });
  });

  it("le jeton transporté reste vérifiable (cohérence protocole)", async () => {
    const { token, payload } = signLiveVoiceSession({ uid: "user-1", conversationId: "conv-1", epoch: 2 });
    const form = nominalForm(token);
    expect(verifyLiveVoiceSession(form.get("token") as string)).toMatchObject({
      uid: payload.uid,
      conversationId: payload.conversationId,
      epoch: 2,
    });
  });
});
