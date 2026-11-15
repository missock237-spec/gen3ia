import { describe, expect, it } from "vitest";

import {
  BARGE_IN_RMS_THRESHOLD,
  GeminiLiveSession,
  RmsMeter,
  base64PcmToFloat32,
  base64ToBytes,
  buildLiveWsUrl,
  buildRealtimeAudioChunk,
  buildRealtimeImageChunk,
  buildSetupMessage,
  bytesToBase64,
  computeRms,
  float32ToPcm16Base64,
  parseServerMessage,
  pcm16Base64ToFloat32,
  type GeminiAudioBufferLike,
  type GeminiAudioBufferSourceLike,
  type GeminiAudioContextLike,
  type GeminiInterruptSource,
  type GeminiLiveState,
  type GeminiWebSocketLike,
} from "./gemini-live-client";

/* ------------------------------------------------------------------ */
/* Doubles de test (WebSocket + AudioContext) — WebAudio mocké propre  */
/* ------------------------------------------------------------------ */

type SocketListener = (event: { data?: unknown; message?: unknown }) => unknown;

/** WebSocket factice : même contrat structurel que l'API DOM utilisée. */
class FakeWebSocket implements GeminiWebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closeCalls: { code?: number; reason?: string }[] = [];
  private listeners = new Map<string, SocketListener[]>();

  addEventListener(type: "open" | "message" | "close" | "error", listener: SocketListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.emit("close");
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(data: unknown): void {
    this.emit("message", { data });
  }

  fail(message: string): void {
    this.readyState = 3;
    this.emit("error", { message });
  }

  serverClose(): void {
    this.readyState = 3;
    this.emit("close");
  }

  private emit(type: string, event: { data?: unknown; message?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeBuffer implements GeminiAudioBufferLike {
  private channelData: Float32Array | null = null;
  constructor(
    readonly length: number,
    readonly createdWithSampleRate: number,
  ) {}

  getChannelData(): Float32Array {
    if (!this.channelData) this.channelData = new Float32Array(this.length);
    return this.channelData;
  }
}

class FakeSource implements GeminiAudioBufferSourceLike {
  buffer: GeminiAudioBufferLike | null = null;
  connectedTo: unknown = null;
  started = false;
  stopped = false;
  private endedListener: (() => unknown) | null = null;

  constructor(private readonly context: FakeAudioContext) {}

  connect(node: unknown): void {
    this.connectedTo = node;
  }

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  addEventListener(type: "ended", listener: () => unknown): void {
    if (type === "ended") this.endedListener = listener;
  }

  removeEventListener(type: "ended", listener: () => unknown): void {
    if (type === "ended" && this.endedListener === listener) this.endedListener = null;
  }

  /** Simule la fin réelle de lecture de la source. */
  end(): void {
    this.stopped = true;
    this.endedListener?.();
  }
}

class FakeAudioContext implements GeminiAudioContextLike {
  readonly sampleRate = 24000;
  readonly destination = { nodeType: "destination" };
  readonly buffers: FakeBuffer[] = [];
  readonly sources: FakeSource[] = [];
  resumeCalls = 0;
  closeCalls = 0;

  createBuffer(_channels: number, length: number, sampleRate: number): GeminiAudioBufferLike {
    const buffer = new FakeBuffer(length, sampleRate);
    this.buffers.push(buffer);
    return buffer;
  }

  createBufferSource(): GeminiAudioBufferSourceLike {
    const source = new FakeSource(this);
    this.sources.push(source);
    return source;
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }
}

interface RecordedEvents {
  states: GeminiLiveState[];
  texts: string[];
  playing: boolean[];
  interrupts: GeminiInterruptSource[];
  errors: string[];
  turns: number;
  setups: number;
}

function makeSession(socket: FakeWebSocket, context: FakeAudioContext) {
  const events: RecordedEvents = { states: [], texts: [], playing: [], interrupts: [], errors: [], turns: 0, setups: 0 };
  const session = new GeminiLiveSession(
    {
      onStateChange: (state) => events.states.push(state),
      onText: (text) => events.texts.push(text),
      onAudioPlaying: (playing) => events.playing.push(playing),
      onInterrupt: (source) => events.interrupts.push(source),
      onError: (message) => events.errors.push(message),
      onTurnComplete: () => {
        events.turns += 1;
      },
      onSetupComplete: () => {
        events.setups += 1;
      },
    },
    {
      webSocketFactory: () => socket,
      audioContextFactory: () => context,
    },
  );
  return { session, events };
}

/** Ouvre une session (socket factice ouvert) et renvoie les événements. */
async function startLiveSession(socket: FakeWebSocket, context: FakeAudioContext) {
  const { session, events } = makeSession(socket, context);
  const pending = session.connect("cle-operateur-test");
  socket.open();
  await pending;
  return { session, events };
}

function audioPart(base64: string) {
  return { inlineData: { mimeType: "audio/pcm;rate=24000", data: base64 } };
}

function serverContentMessage(payload: Record<string, unknown>): string {
  return JSON.stringify({ serverContent: payload });
}

/* ------------------------------------------------------------------ */
/* URL + messages du protocole                                        */
/* ------------------------------------------------------------------ */

describe("buildLiveWsUrl", () => {
  it("construit l'endpoint BidiGenerateContent v1alpha avec la clé", () => {
    expect(buildLiveWsUrl("AIzaTest123")).toBe(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=AIzaTest123",
    );
  });

  it("encode la clé et refuse une clé vide", () => {
    expect(buildLiveWsUrl(" abc&def ")).toContain(`key=${encodeURIComponent("abc&def")}`);
    expect(() => buildLiveWsUrl("   ")).toThrow("Clé API Gemini manquante");
  });
});

describe("buildSetupMessage", () => {
  it("produit exactement le schéma setup du fichier HTML d'origine", () => {
    expect(buildSetupMessage()).toEqual({
      setup: {
        model: "models/gemini-2.0-flash-exp",
        generationConfig: {
          responseModalities: ["AUDIO", "TEXT"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: "Puck" },
            },
          },
        },
      },
    });
  });

  it("accepte des surcharges explicites de modèle et de voix", () => {
    const message = buildSetupMessage({ model: "models/autre", voiceName: "Kore" });
    expect(message.setup.model).toBe("models/autre");
    expect(message.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
  });
});

describe("buildRealtimeAudioChunk / buildRealtimeImageChunk", () => {
  it("empacte l'audio en realtimeInput.mediaChunks audio/pcm", () => {
    expect(buildRealtimeAudioChunk("QUJDRA==")).toEqual({
      realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm", data: "QUJDRA==" }] },
    });
  });

  it("empacte l'image en realtimeInput.mediaChunks image/jpeg", () => {
    expect(buildRealtimeImageChunk("L2ppeGVn")).toEqual({
      realtimeInput: { mediaChunks: [{ mimeType: "image/jpeg", data: "L2ppeGVn" }] },
    });
  });
});

/* ------------------------------------------------------------------ */
/* Conversions PCM / base64 (formules du fichier HTML)                */
/* ------------------------------------------------------------------ */

describe("conversions PCM base64", () => {
  it("float32ToPcm16Base64 correspond à la référence Node (formule HTML)", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.75, -0.75]);
    const reference = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      reference[i] = Math.max(-1, Math.min(1, samples[i])) * 0x7fff;
    }
    expect(float32ToPcm16Base64(samples)).toBe(Buffer.from(reference.buffer).toString("base64"));
  });

  it("effectue un aller-retour Float32 → PCM16 base64 → Float32 fidèle", () => {
    const samples = new Float32Array([0, 0.25, -0.25, 0.5, -0.5, 1, -1]);
    const decoded = pcm16Base64ToFloat32(float32ToPcm16Base64(samples));
    expect(decoded.length).toBe(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      expect(decoded[i]).toBeCloseTo(samples[i], 4);
    }
  });

  it("décode le PCM 24 kHz serveur avec la formule HTML getInt16/32768", () => {
    // -32768 → -1.0 et 32767 → 0.999969… (little-endian).
    const base64 = Buffer.from(new Int16Array([-32768, 32767]).buffer).toString("base64");
    const decoded = pcm16Base64ToFloat32(base64);
    expect(decoded[0]).toBe(-1);
    expect(decoded[1]).toBeCloseTo(32767 / 32768, 6);
    expect(base64PcmToFloat32(base64)).toEqual(decoded);
  });

  it("enc et décode le base64 en accord avec la référence Node", () => {
    expect(base64ToBytes("QUJD")).toEqual(new Uint8Array([65, 66, 67]));
    const random = new Uint8Array(1024);
    for (let i = 0; i < random.length; i += 1) random[i] = (i * 37 + 11) % 256;
    const encoded = bytesToBase64(random);
    expect(encoded).toBe(Buffer.from(random).toString("base64"));
    expect(Array.from(base64ToBytes(encoded))).toEqual(Array.from(random));
  });

  it("gère les longueurs non alignées (padding 1 et 2 symboles)", () => {
    for (const length of [1, 2, 3, 4, 5, 7]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i + 1) * 29;
      const encoded = bytesToBase64(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
      expect(Array.from(base64ToBytes(encoded))).toEqual(Array.from(bytes));
    }
  });

  it("rejette un base64 invalide au décodage", () => {
    expect(() => base64ToBytes("QU*J")).toThrow("Base64 invalide");
  });
});

/* ------------------------------------------------------------------ */
/* VAD : RMS + seuil                                                  */
/* ------------------------------------------------------------------ */

describe("computeRms et RmsMeter", () => {
  it("renvoie 0 pour le silence et pour un signal vide", () => {
    expect(computeRms(new Float32Array(1024))).toBe(0);
    expect(computeRms(new Float32Array(0))).toBe(0);
  });

  it("mesure une sinusoïde 0,5 d'amplitude à 0,5/√2", () => {
    const sine = new Float32Array(640);
    for (let i = 0; i < sine.length; i += 1) sine[i] = 0.5 * Math.sin((2 * Math.PI * i) / 64);
    expect(computeRms(sine)).toBeCloseTo(0.5 / Math.SQRT2, 3);
  });

  it("applique le seuil par défaut 0,06 du fichier HTML", () => {
    expect(BARGE_IN_RMS_THRESHOLD).toBe(0.06);
    const meter = new RmsMeter();
    const loud = new Float32Array(512).fill(0.3);
    const quiet = new Float32Array(512).fill(0.03);
    expect(meter.isVoiceActive(loud)).toBe(true);
    expect(meter.isVoiceActive(quiet)).toBe(false);
    expect(meter.isAbove(0.06)).toBe(false);
    expect(meter.isAbove(0.0601)).toBe(true);
    expect(meter.lastLevel).toBeCloseTo(computeRms(quiet), 6);
  });

  it("accepte un seuil personnalisé", () => {
    const strict = new RmsMeter(0.5);
    expect(strict.isVoiceActive(new Float32Array(128).fill(0.4))).toBe(false);
    expect(strict.isVoiceActive(new Float32Array(128).fill(0.6))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* parseServerMessage — exemples réels du protocole                   */
/* ------------------------------------------------------------------ */

describe("parseServerMessage", () => {
  it("extrait le texte de serverContent.modelTurn.parts", () => {
    const parsed = parseServerMessage(
      JSON.stringify({
        serverContent: { modelTurn: { parts: [{ text: "Bonjour, comment puis-je aider ?" }] } },
        usageMetadata: { totalTokenCount: 42 },
      }),
    );
    expect(parsed.kind).toBe("server-content");
    expect(parsed.recognized).toBe(true);
    expect(parsed.text).toBe("Bonjour, comment puis-je aider ?");
    expect(parsed.audioBase64).toEqual([]);
    expect(parsed.turnComplete).toBe(false);
    expect(parsed.interrupted).toBe(false);
  });

  it("extrait l'audio inlineData audio/pcm;rate=24000", () => {
    const parsed = parseServerMessage(
      serverContentMessage({ modelTurn: { parts: [audioPart("QUJDRA==")] } }),
    );
    expect(parsed.recognized).toBe(true);
    expect(parsed.text).toBeNull();
    expect(parsed.audioBase64).toEqual(["QUJDRA=="]);
  });

  it("concatène plusieurs parts texte+audio dans l'ordre du protocole", () => {
    const parsed = parseServerMessage(
      serverContentMessage({
        modelTurn: {
          parts: [{ text: "Voici " }, audioPart("AAA="), { text: "la réponse." }, audioPart("BBB=")],
        },
      }),
    );
    expect(parsed.text).toBe("Voici la réponse.");
    expect(parsed.audioBase64).toEqual(["AAA=", "BBB="]);
  });

  it("reconnaît serverContent.interrupted (barge-in serveur)", () => {
    const parsed = parseServerMessage(serverContentMessage({ interrupted: true }));
    expect(parsed.recognized).toBe(true);
    expect(parsed.interrupted).toBe(true);
  });

  it("reconnaît serverContent.turnComplete", () => {
    const parsed = parseServerMessage(serverContentMessage({ turnComplete: true }));
    expect(parsed.recognized).toBe(true);
    expect(parsed.turnComplete).toBe(true);
  });

  it("reconnaît setupComplete (session prête)", () => {
    const parsed = parseServerMessage(JSON.stringify({ setupComplete: {} }));
    expect(parsed.kind).toBe("setup-complete");
    expect(parsed.setupComplete).toBe(true);
    expect(parsed.recognized).toBe(true);
  });

  it("ignore les formes inconnues sans crash (toolCall, objets étrangers)", () => {
    for (const raw of [
      JSON.stringify({ toolCall: { functionCalls: [{ name: "x", args: {} }] } }),
      JSON.stringify({ foo: "bar" }),
      JSON.stringify([]),
      "42",
      "null",
      null,
      undefined,
    ]) {
      const parsed = parseServerMessage(raw);
      expect(parsed.recognized).toBe(false);
      expect(parsed.kind).toBe("unrecognized");
      expect(parsed.text).toBeNull();
      expect(parsed.audioBase64).toEqual([]);
    }
  });

  it("signale un JSON illisible sans lever d'exception", () => {
    const parsed = parseServerMessage('{"serverContent":');
    expect(parsed.recognized).toBe(false);
    expect(parsed.parseError).toBe("JSON illisible");
  });

  it("ignore les inlineData non audio et accepte un objet déjà parsé", () => {
    const objectInput = {
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: "L2ppeGVn" } },
            { inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAA=" } },
            { unknownField: true },
          ],
        },
      },
    };
    const parsed = parseServerMessage(objectInput);
    expect(parsed.recognized).toBe(true);
    expect(parsed.audioBase64).toEqual(["AAA="]);
  });

  it("traite un serverContent vide comme reconnu mais sans contenu", () => {
    const parsed = parseServerMessage(serverContentMessage({}));
    expect(parsed.recognized).toBe(true);
    expect(parsed.text).toBeNull();
    expect(parsed.audioBase64).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* GeminiLiveSession — socket et WebAudio factices                    */
/* ------------------------------------------------------------------ */

describe("GeminiLiveSession", () => {
  it("passe par idle → connecting → live et envoie le setup en premier message", async () => {
    const socket = new FakeWebSocket();
    const context = new FakeAudioContext();
    const { session, events } = await startLiveSession(socket, context);
    expect(session.state).toBe("live");
    expect(events.states).toEqual(["connecting", "live"]);
    expect(socket.sent.length).toBe(1);
    expect(JSON.parse(socket.sent[0])).toEqual(buildSetupMessage());
    session.close();
  });

  it("rejette la connexion si la socket signale une erreur avant ouverture", async () => {
    const socket = new FakeWebSocket();
    const context = new FakeAudioContext();
    const { session } = makeSession(socket, context);
    const pending = session.connect("cle-test");
    socket.fail("HTTP 401");
    await expect(pending).rejects.toThrow("401");
    socket.serverClose();
    expect(session.state).toBe("closed");
  });

  it("rejette si la socket se ferme avant l'ouverture", async () => {
    const socket = new FakeWebSocket();
    const context = new FakeAudioContext();
    const { session } = makeSession(socket, context);
    const pending = session.connect("cle-test");
    socket.serverClose();
    await expect(pending).rejects.toThrow("fermée avant l'ouverture");
    expect(session.state).toBe("closed");
  });

  it("refuse une double connexion", async () => {
    const socket = new FakeWebSocket();
    const context = new FakeAudioContext();
    const { session } = await startLiveSession(socket, context);
    await expect(session.connect("autre-cle")).rejects.toThrow("déjà active");
    session.close();
  });

  it("envoie l'audio et l'image uniquement quand le socket est OPEN", async () => {
    const socket = new FakeWebSocket();
    const context = new FakeAudioContext();
    const { session } = makeSession(socket, context);
    // Avant connexion : rien n'est envoyé, aucun crash.
    expect(session.sendAudioChunk("AAA=")).toBe(false);
    expect(session.sendImageFrame("L2ppeGVn")).toBe(false);
    expect(socket.sent).toEqual([]);

    await startOpen(socket, session);
    expect(session.sendAudioChunk("AAA=")).toBe(true);
    expect(session.sendImageFrame("L2ppeGVn")).toBe(true);
    expect(JSON.parse(socket.sent[1])).toEqual(buildRealtimeAudioChunk("AAA="));
    expect(JSON.parse(socket.sent[2])).toEqual(buildRealtimeImageChunk("L2ppeGVn"));

    // Socket en fermeture : envois protégés.
    socket.readyState = 2;
    expect(session.sendAudioChunk("AAA=")).toBe(false);
    session.close();
    expect(session.sendAudioChunk("AAA=")).toBe(false);
  });

  it("met en file la voix PCM 24 kHz et enchaîne les chunks à la fin de lecture", async () => {
    const socket = new FakeWebSocket();
    const context = new FakeAudioContext();
    const { session, events } = await startLiveSession(socket, context);

    const chunkA = float32ToPcm16Base64(new Float32Array([0.5, -0.5, 0.25]));
    const chunkB = float32ToPcm16Base64(new Float32Array([0.1, -0.1]));
    socket.message(
      serverContentMessage({ modelTurn: { parts: [audioPart(chunkA), audioPart(chunkB)] } }),
    );

    // Premier chunk en lecture, second en attente : Buffer 24 kHz réel.
    expect(context.sources.length).toBe(1);
    expect(context.sources[0].started).toBe(true);
    expect(context.sources[0].buffer).toBe(context.buffers[0]);
    expect(context.buffers[0].createdWithSampleRate).toBe(24000);
    const played = context.buffers[0].getChannelData(0);
    expect(played[0]).toBeCloseTo(0.5, 3);
    expect(played[1]).toBeCloseTo(-0.5, 3);
    expect(played[2]).toBeCloseTo(0.25, 3);
    expect(events.playing).toEqual([true]);

    // Fin réelle de la première source → le second démarre.
    context.sources[0].end();
    expect(context.sources.length).toBe(2);
    expect(context.sources[1].started).toBe(true);
    expect(events.playing).toEqual([true]);

    context.sources[1].end();
    expect(events.playing).toEqual([true, false]);
    expect(session.isPlayingAudio).toBe(false);
    session.close();
  });

  it("journalise le texte du modèle et la fin de tour", async () => {
    const socket = new FakeWebSocket();
    const context = new FakeAudioContext();
    const { session, events } = await startLiveSession(socket, context);
    socket.message(
      serverContentMessage({ modelTurn: { parts: [{ text: "Je vous guide." }] }, turnComplete: true }),
    );
    expect(events.texts).toEqual(["Je vous guide."]);
    expect(events.turns).toBe(1);
    session.close();
  });

  it("détecte setupComplete", async () => {
    const socket = new FakeWebSocket();
    const context = new FakeAudioContext();
    const { session, events } = await startLiveSession(socket, context);
    socket.message(JSON.stringify({ setupComplete: {} }));
    expect(events.setups).toBe(1);
    session.close();
  });

  it("coupe la file au barge-in VAD pendant la lecture uniquement", async () => {
    const socket = new FakeWebSocket();
    const context = new FakeAudioContext();
    const { session, events } = await startLiveSession(socket, context);

    // Hors lecture : le VAD ne déclenche rien.
    expect(session.notifyMicRms(0.5)).toBe(false);

    socket.message(
      serverContentMessage({ modelTurn: { parts: [audioPart("AAA="), audioPart("BBB=")] } }),
    );
    expect(session.isPlayingAudio).toBe(true);
    expect(session.notifyMicRms(BARGE_IN_RMS_THRESHOLD)).toBe(false); // strictement supérieur
    expect(session.notifyMicRms(0.2)).toBe(true);
    expect(events.interrupts).toEqual(["vad"]);
    expect(events.playing).toEqual([true, false]);
    expect(context.sources[0].stopped).toBe(true);
    // La source suivante n'est jamais démarrée : file vidée.
    expect(context.sources.length).toBe(1);

    // Fin « fantôme » de la source coupée : rien ne repart (génération invalidée).
    context.sources[0].end();
    expect(context.sources.length).toBe(1);
    session.close();
  });

  it("applique le barge-in serveur (serverContent.interrupted)", async () => {
    const socket = new FakeWebSocket();
    const context = new FakeAudioContext();
    const { session, events } = await startLiveSession(socket, context);
    socket.message(serverContentMessage({ modelTurn: { parts: [audioPart("AAA=")] } }));
    socket.message(serverContentMessage({ interrupted: true }));
    expect(events.interrupts).toEqual(["server"]);
    expect(session.isPlayingAudio).toBe(false);
    session.close();
  });

  it("exécute le barge-in manuel sur demande de l'opérateur", async () => {
    const socket = new FakeWebSocket();
    const context = new FakeAudioContext();
    const { session, events } = await startLiveSession(socket, context);
    session.interrupt("manual");
    expect(events.interrupts).toEqual(["manual"]);

    socket.message(serverContentMessage({ modelTurn: { parts: [audioPart("AAA=")] } }));
    session.interrupt("manual");
    expect(events.interrupts).toEqual(["manual", "manual"]);
    expect(events.playing).toEqual([true, false]);
    expect(context.sources[0].stopped).toBe(true);
    session.close();
  });

  it("ferme proprement : socket (code 1000), source, file et AudioContext", async () => {
    const socket = new FakeWebSocket();
    const context = new FakeAudioContext();
    const { session, events } = await startLiveSession(socket, context);
    socket.message(serverContentMessage({ modelTurn: { parts: [audioPart("AAA="), audioPart("BBB=")] } }));

    session.close();
    expect(events.states).toEqual(["connecting", "live", "closed"]);
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "session fermée par l'opérateur" }]);
    expect(context.closeCalls).toBe(1);
    expect(context.sources[0].stopped).toBe(true);
    expect(session.isPlayingAudio).toBe(false);
    expect(events.playing).toEqual([true, false]);

    // Après fermeture : les messages serveur ne relancent aucune lecture.
    socket.message(serverContentMessage({ modelTurn: { parts: [audioPart("CCC=")] } }));
    expect(context.sources.length).toBe(1);
    expect(session.state).toBe("closed");
  });

  it("reste robuste si le serveur ferme la connexion en pleine lecture", async () => {
    const socket = new FakeWebSocket();
    const context = new FakeAudioContext();
    const { session, events } = await startLiveSession(socket, context);
    socket.message(serverContentMessage({ modelTurn: { parts: [audioPart("AAA=")] } }));
    socket.serverClose();
    expect(session.state).toBe("closed");
    expect(events.playing).toEqual([true, false]);
    expect(events.errors).toEqual(["La connexion Gemini Live a été fermée par le serveur."]);
    expect(context.sources[0].stopped).toBe(true);
  });

  it("signale explicitement l'absence de sortie audio (aucune lecture simulée)", async () => {
    const socket = new FakeWebSocket();
    const errors: string[] = [];
    const session = new GeminiLiveSession(
      { onError: (message) => errors.push(message) },
      {
        webSocketFactory: () => socket,
        audioContextFactory: () => {
          throw new Error("périphérique audio absent");
        },
      },
    );
    const pending = session.connect("cle-test");
    socket.open();
    await pending;
    socket.message(serverContentMessage({ modelTurn: { parts: [audioPart("AAA=")] } }));
    expect(errors.some((message) => message.includes("Sortie audio indisponible"))).toBe(true);
    expect(session.isPlayingAudio).toBe(false);
    session.close();
  });
});

/** Ouvre le socket d'une session déjà construite (helper de lisibilité). */
async function startOpen(socket: FakeWebSocket, session: GeminiLiveSession): Promise<void> {
  const pending = session.connect("cle-operateur-test");
  socket.open();
  await pending;
}
