/**
 * CLIENT GEMINI LIVE (ÉCRAN + VOIX) — Task 2-a.
 *
 * Intégration au système agent live du fichier autonome fourni par
 * l'opérateur « Gemini Live Screen & Voice App.html » : WebSocket bidirectionnel
 * BidiGenerateContent (v1alpha) vers generativelanguage.googleapis.com, envoi
 * realtimeInput.mediaChunks (audio PCM16 16 kHz + images JPEG), réception des
 * tours du modèle (texte + audio PCM 24 kHz), barge-in VAD (RMS > 0,06) et
 * arrêt propre de toutes les ressources.
 *
 * HONNÊTETÉ SUR LE PÉRIMÈTRE RÉEL :
 *  - Ce client fonctionne ENTIÈREMENT dans le navigateur de l'opérateur : la
 *    clé API Gemini y est saisie et reste en mémoire (sessionStorage), elle
 *    n'est JAMAIS transmise au backend gen3ia. C'est exactement le modèle du
 *    fichier HTML d'origine.
 *  - Le modèle `gemini-2.0-flash-exp` est un modèle EXPERIMENTAL Google :
 *    disponibilité, quotas et format de réponse peuvent évoluer sans préavis.
 *  - Le WebSocket est le seul transport : la CSP du middleware autorise déjà
 *    `wss://*.googleapis.com` (aucune modification nécessaire).
 *  - Ce canal est COMPLÉMENTAIRE : le décideur interne lib/live/vision-decider.ts
 *    (perception structurelle, moteur Gen3) reste inchangé.
 *
 * Ce module est PUR (aucun accès DOM au chargement) : les helpers sont
 * testables en Node ; la classe GeminiLiveSession n'instancie WebSocket ni
 * AudioContext qu'au moment de connect()/lecture, et accepte des fabriques
 * injectées pour les tests.
 */

/* ------------------------------------------------------------------ */
/* Constantes du protocole (issues du fichier HTML d'origine)          */
/* ------------------------------------------------------------------ */

/** Endpoint WebSocket officiel Gemini Live (BidiGenerateContent v1alpha). */
const GEMINI_LIVE_WS_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent";

export const GEMINI_LIVE_MODEL = "models/gemini-2.0-flash-exp";
export const GEMINI_LIVE_VOICE_NAME = "Puck";
/** Modalités de réponse demandées (le serveur peut n'en honorer qu'une). */
export const GEMINI_LIVE_RESPONSE_MODALITIES = ["AUDIO", "TEXT"] as const;
/** Entrée micro : PCM 16 bits signé, little-endian, 16 kHz. */
export const GEMINI_INPUT_SAMPLE_RATE = 16_000;
/** Sortie voix : PCM 16 bits signé, little-endian, 24 kHz (inlineData audio/pcm;rate=24000). */
export const GEMINI_OUTPUT_SAMPLE_RATE = 24_000;
export const GEMINI_AUDIO_MIME = "audio/pcm";
export const GEMINI_IMAGE_MIME = "image/jpeg";
/** Seuil VAD du barge-in, identique au fichier HTML d'origine. */
export const BARGE_IN_RMS_THRESHOLD = 0.06;

/** États de prêt de l'API WebSocket (constantes DOM, rédéclarées pour Node). */
const WS_OPEN = 1;
const WS_CLOSED = 3;

/** Construit l'URL WebSocket signée par la clé API (saisie côté opérateur). */
export function buildLiveWsUrl(apiKey: string): string {
  const key = apiKey.trim();
  if (!key) throw new Error("Clé API Gemini manquante.");
  return `${GEMINI_LIVE_WS_ENDPOINT}?key=${encodeURIComponent(key)}`;
}

/* ------------------------------------------------------------------ */
/* Base64 pur (aucune dépendance DOM/Node : btoa/atob NON utilisés)    */
/* ------------------------------------------------------------------ */

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/** Encode des octets en base64 (alphabet standard, padding `=`). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += BASE64_ALPHABET[(n >> 18) & 63] + BASE64_ALPHABET[(n >> 12) & 63] + BASE64_ALPHABET[(n >> 6) & 63] + BASE64_ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += BASE64_ALPHABET[(n >> 18) & 63] + BASE64_ALPHABET[(n >> 12) & 63] + "==";
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += BASE64_ALPHABET[(n >> 18) & 63] + BASE64_ALPHABET[(n >> 12) & 63] + BASE64_ALPHABET[(n >> 6) & 63] + "=";
  }
  return out;
}

/** Décode une chaîne base64 stricte (sans préfixe data:, sans espaces). */
export function base64ToBytes(value: string): Uint8Array {
  const cleaned = value.replace(/[\s]/g, "");
  const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  const length = cleaned.length;
  const usable = length - padding;
  const out = new Uint8Array(Math.max(0, Math.floor((usable * 3) / 4)));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < usable; i += 1) {
    const code = cleaned.charCodeAt(i);
    const six = code < 128 ? BASE64_LOOKUP[code] : -1;
    if (six < 0) throw new Error("Base64 invalide : caractère inattendu.");
    buffer = (buffer << 6) | six;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (buffer >> bits) & 0xff;
      outIndex += 1;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Conversions PCM (formules identiques au fichier HTML d'origine)     */
/* ------------------------------------------------------------------ */

/**
 * Float32 [-1, 1] → Int16 saturé. Formule du fichier HTML :
 * `Math.max(-1, Math.min(1, x)) * 0x7FFF` (truncation par Int16Array).
 */
export function float32ToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out[i] = clamped * 0x7fff;
  }
  return out;
}

/** Int16 → base64 (little-endian) : format exact attendu par realtimeInput. */
export function pcm16ToBase64(pcm: Int16Array): string {
  return bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
}

/** Chaîne de capture micro complète : Float32 → PCM16 → base64. */
export function float32ToPcm16Base64(samples: Float32Array): string {
  return pcm16ToBase64(float32ToPcm16(samples));
}

/**
 * PCM16 (little-endian) → Float32 [-1, 1]. Formule du fichier HTML pour la
 * lecture des réponses : `getInt16(i * 2, true) / 32768.0`.
 */
export function pcm16BytesToFloat32(bytes: Uint8Array): Float32Array {
  const count = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

/** Réponse voix Gemini (inlineData audio/pcm;rate=24000) → Float32 jouable. */
export function pcm16Base64ToFloat32(base64: string): Float32Array {
  return pcm16BytesToFloat32(base64ToBytes(base64));
}

/** Alias de lisibilité (même conversion, nommage miroir des helpers audit). */
export const base64PcmToFloat32 = pcm16Base64ToFloat32;

/* ------------------------------------------------------------------ */
/* VAD : RMS + seuil de barge-in                                       */
/* ------------------------------------------------------------------ */

/** RMS d'un signal Float32 (0 = silence ; identique à la boucle du fichier HTML). */
export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i];
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/** Mesureur RMS avec seuil configurable (défaut 0,06 — fichier HTML). */
export class RmsMeter {
  lastLevel = 0;

  constructor(readonly threshold: number = BARGE_IN_RMS_THRESHOLD) {}

  /** Mesure et retient le niveau courant. */
  level(samples: Float32Array): number {
    this.lastLevel = computeRms(samples);
    return this.lastLevel;
  }

  /** Vrai si le niveau mesuré dépasse le seuil (activité vocale). */
  isVoiceActive(samples: Float32Array): boolean {
    return this.level(samples) > this.threshold;
  }

  /** Vrai si une valeur RMS déjà calculée dépasse le seuil. */
  isAbove(rms: number): boolean {
    return rms > this.threshold;
  }
}

/* ------------------------------------------------------------------ */
/* Messages du protocole (schémas exacts du fichier HTML)              */
/* ------------------------------------------------------------------ */

export interface GeminiSetupOptions {
  model?: string;
  voiceName?: string;
}

/** Message setup — conforme au schéma exact du fichier HTML d'origine. */
export function buildSetupMessage(options: GeminiSetupOptions = {}): {
  setup: {
    model: string;
    generationConfig: {
      responseModalities: string[];
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
    };
  };
} {
  return {
    setup: {
      model: options.model ?? GEMINI_LIVE_MODEL,
      generationConfig: {
        responseModalities: [...GEMINI_LIVE_RESPONSE_MODALITIES],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: options.voiceName ?? GEMINI_LIVE_VOICE_NAME },
          },
        },
      },
    },
  };
}

/** Chunk audio realtimeInput (PCM 16 kHz 16 bits, base64). */
export function buildRealtimeAudioChunk(base64Pcm16: string): {
  realtimeInput: { mediaChunks: { mimeType: string; data: string }[] };
} {
  return {
    realtimeInput: {
      mediaChunks: [{ mimeType: GEMINI_AUDIO_MIME, data: base64Pcm16 }],
    },
  };
}

/** Chunk image realtimeInput (JPEG, base64). */
export function buildRealtimeImageChunk(jpegBase64: string): {
  realtimeInput: { mediaChunks: { mimeType: string; data: string }[] };
} {
  return {
    realtimeInput: {
      mediaChunks: [{ mimeType: GEMINI_IMAGE_MIME, data: jpegBase64 }],
    },
  };
}

export type GeminiParsedMessageKind = "server-content" | "setup-complete" | "unrecognized";

export interface GeminiParsedMessage {
  /** Discriminant du message reconnu. */
  kind: GeminiParsedMessageKind;
  /** Texte du tour du modèle (parts `text` concaténés), null si absent. */
  text: string | null;
  /** Chunks audio inlineData (base64 PCM 24 kHz), dans l'ordre du protocole. */
  audioBase64: string[];
  /** serverContent.turnComplete — le modèle a terminé son tour. */
  turnComplete: boolean;
  /** serverContent.interrupted — le serveur a coupé la lecture (barge-in). */
  interrupted: boolean;
  /** Un serverContent/setupComplete a été reconnu (formes inconnues : false). */
  recognized: boolean;
  /** Message setupComplete reçu — la session Gemini est prête. */
  setupComplete: boolean;
  /** Description de l'erreur de décodage JSON, si le message est illisible. */
  parseError?: string;
}

const EMPTY_PARSED: Omit<GeminiParsedMessage, "kind"> = {
  text: null,
  audioBase64: [],
  turnComplete: false,
  interrupted: false,
  recognized: false,
  setupComplete: false,
};

/**
 * Parseur TOLÉRANT des messages serveur Gemini Live : ne lève jamais, ignore
 * les formes inconnues (toolCall, usageMetadata, goAway, extensions futures…)
 * et extrait les éléments réellement consommés par l'UI : texte, audio, fin de
 * tour, interruption. Accepte une chaîne JSON brute ou un objet déjà parsé.
 */
export function parseServerMessage(input: unknown): GeminiParsedMessage {
  let payload: unknown = input;
  if (typeof input === "string") {
    try {
      payload = JSON.parse(input);
    } catch {
      return { ...EMPTY_PARSED, kind: "unrecognized", parseError: "JSON illisible" };
    }
  }
  if (typeof payload !== "object" || payload === null) {
    return { ...EMPTY_PARSED, kind: "unrecognized" };
  }
  const record = payload as Record<string, unknown>;

  if (record.setupComplete !== undefined) {
    return { ...EMPTY_PARSED, kind: "setup-complete", recognized: true, setupComplete: true };
  }

  const serverContent = record.serverContent;
  if (typeof serverContent !== "object" || serverContent === null) {
    return { ...EMPTY_PARSED, kind: "unrecognized" };
  }
  const content = serverContent as Record<string, unknown>;

  const textParts: string[] = [];
  const audioChunks: string[] = [];
  const modelTurn = content.modelTurn;
  if (typeof modelTurn === "object" && modelTurn !== null) {
    const parts = (modelTurn as Record<string, unknown>).parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part !== "object" || part === null) continue;
        const typed = part as Record<string, unknown>;
        if (typeof typed.text === "string") textParts.push(typed.text);
        const inlineData = typed.inlineData;
        if (typeof inlineData === "object" && inlineData !== null) {
          const media = inlineData as Record<string, unknown>;
          const mime = typeof media.mimeType === "string" ? media.mimeType : "";
          if (mime.startsWith("audio/") && typeof media.data === "string" && media.data.length > 0) {
            audioChunks.push(media.data);
          }
          // Les inlineData non audio (images…) ne sont pas consommés : ignorés
          // volontairement, sans crash ni perte de message.
        }
      }
    }
  }

  const text = textParts.length > 0 ? textParts.join("") : null;
  return {
    kind: "server-content",
    text,
    audioBase64: audioChunks,
    turnComplete: content.turnComplete === true,
    interrupted: content.interrupted === true,
    recognized: true,
    setupComplete: false,
  };
}

/* ------------------------------------------------------------------ */
/* GeminiLiveSession — client navigateur (fabriques injectables)       */
/* ------------------------------------------------------------------ */

/** Socket minimal structurellement compatible avec l'API DOM WebSocket. */
export interface GeminiWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => unknown): void;
  addEventListener(type: "message", listener: (event: { readonly data?: unknown }) => unknown): void;
  addEventListener(type: "close", listener: () => unknown): void;
  addEventListener(type: "error", listener: (event: { readonly message?: unknown }) => unknown): void;
}

export interface GeminiAudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface GeminiAudioBufferSourceLike {
  buffer: GeminiAudioBufferLike | null;
  connect(node: unknown): void;
  start(when?: number): void;
  stop(): void;
  addEventListener(type: "ended", listener: () => unknown): void;
  removeEventListener(type: "ended", listener: () => unknown): void;
}

/** Contexte audio minimal : uniquement ce que la file de lecture consomme. */
export interface GeminiAudioContextLike {
  readonly sampleRate: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  createBuffer(channels: number, length: number, sampleRate: number): GeminiAudioBufferLike;
  createBufferSource(): GeminiAudioBufferSourceLike;
}

export type GeminiLiveState = "idle" | "connecting" | "live" | "closed";
export type GeminiInterruptSource = "server" | "vad" | "manual";

export interface GeminiLiveSessionCallbacks {
  onStateChange?: (state: GeminiLiveState) => void;
  onText?: (text: string) => void;
  /** Transition réelle de la file de lecture (true = la voix commence). */
  onAudioPlaying?: (playing: boolean) => void;
  onInterrupt?: (source: GeminiInterruptSource) => void;
  onTurnComplete?: () => void;
  onSetupComplete?: () => void;
  onError?: (message: string) => void;
}

export interface GeminiLiveSessionOptions {
  /** Injection pour tests (défaut : WebSocket global du navigateur). */
  webSocketFactory?: (url: string) => GeminiWebSocketLike;
  /** Injection pour tests (défaut : AudioContext 24 kHz du navigateur). */
  audioContextFactory?: () => GeminiAudioContextLike;
  /** Seuil VAD du barge-in micro (défaut 0,06 — fichier HTML). */
  bargeInRmsThreshold?: number;
}

/**
 * Session Gemini Live : WebSocket + file d'attente audio de lecture (PCM
 * 24 kHz) + barge-in. Instancier UNIQUEMENT côté navigateur (ou en tests avec
 * des fabriques injectées) ; aucun accès réseau/DOM au constructeur.
 */
export class GeminiLiveSession {
  private socket: GeminiWebSocketLike | null = null;
  private playbackContext: GeminiAudioContextLike | null = null;
  private readonly callbacks: GeminiLiveSessionCallbacks;
  private readonly bargeInThreshold: number;
  private readonly webSocketFactory: (url: string) => GeminiWebSocketLike;
  private readonly audioContextFactory: () => GeminiAudioContextLike;

  private queue: string[] = [];
  private playing = false;
  private currentSource: GeminiAudioBufferSourceLike | null = null;
  private currentState: GeminiLiveState = "idle";
  /** Incrémenté à chaque interruption/fermeture : invalide les callbacks en vol. */
  private generation = 0;
  private closedByUser = false;

  constructor(callbacks: GeminiLiveSessionCallbacks = {}, options: GeminiLiveSessionOptions = {}) {
    this.callbacks = callbacks;
    this.bargeInThreshold = options.bargeInRmsThreshold ?? BARGE_IN_RMS_THRESHOLD;
    this.webSocketFactory =
      options.webSocketFactory ??
      ((url) =>
        // API DOM WebSocket : structurellement compatible (méthodes
        // bivariantes) ; le cast borne la dépendance à lib.dom dans ce module.
        new WebSocket(url) as unknown as GeminiWebSocketLike);
    this.audioContextFactory =
      options.audioContextFactory ??
      (() => new AudioContext({ sampleRate: GEMINI_OUTPUT_SAMPLE_RATE }));
  }

  get state(): GeminiLiveState {
    return this.currentState;
  }

  /** Vrai tant que la file de lecture émet du son (fenêtre de barge-in). */
  get isPlayingAudio(): boolean {
    return this.playing;
  }

  /**
   * Ouvre le WebSocket et envoie le setup. Résout une fois la session réellement
   * « live » ; rejette sur erreur socket ou fermeture avant ouverture.
   */
  connect(apiKey: string): Promise<void> {
    if (this.currentState === "connecting" || this.currentState === "live") {
      return Promise.reject(new Error("Une session Gemini Live est déjà active."));
    }
    let url: string;
    try {
      url = buildLiveWsUrl(apiKey);
    } catch (error) {
      return Promise.reject(error);
    }
    this.generation += 1;
    this.closedByUser = false;
    this.queue = [];
    this.setState("connecting");

    const socket = this.webSocketFactory(url);
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      socket.addEventListener("open", () => {
        if (this.socket !== socket) return;
        settled = true;
        this.setState("live");
        this.sendJson(buildSetupMessage());
        resolve();
      });
      socket.addEventListener("error", (event) => {
        const detail = typeof event?.message === "string" && event.message.length > 0 ? event.message : "";
        const message = `Erreur WebSocket Gemini Live${detail ? ` : ${detail}` : " (clé invalide, quota Google, réseau ou modèle indisponible)."}`;
        this.callbacks.onError?.(message);
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
      });
      socket.addEventListener("close", () => {
        this.handleSocketClosed();
        if (!settled) {
          settled = true;
          reject(new Error("Connexion WebSocket Gemini fermée avant l'ouverture."));
        }
      });
      socket.addEventListener("message", (event) => {
        void this.ingestMessageData(event.data);
      });
    });
  }

  /**
   * Alimente le VAD barge-in depuis la capture micro : si la voix de l'IA est
   * en cours de lecture et que le micro dépasse le seuil, la file est coupée
   * (comportement « manualInterrupt » du fichier HTML sur RMS > 0,06).
   */
  notifyMicRms(rms: number): boolean {
    if (this.playing && rms > this.bargeInThreshold) {
      this.interrupt("vad");
      return true;
    }
    return false;
  }

  /** Envoi d'un chunk audio PCM16 16 kHz (base64). False si le socket n'est pas OPEN. */
  sendAudioChunk(base64Pcm16: string): boolean {
    return this.sendJson(buildRealtimeAudioChunk(base64Pcm16));
  }

  /** Envoi d'une frame JPEG (base64). False si le socket n'est pas OPEN. */
  sendImageFrame(jpegBase64: string): boolean {
    return this.sendJson(buildRealtimeImageChunk(jpegBase64));
  }

  /**
   * Barge-in : vide la file de lecture, stoppe la source en cours (vad, serveur
   * ou manuel) — équivalent exact de `manualInterrupt()` du fichier HTML.
   */
  interrupt(source: GeminiInterruptSource): void {
    this.queue = [];
    this.generation += 1;
    const current = this.currentSource;
    this.currentSource = null;
    if (current) {
      try {
        current.stop();
      } catch {
        // Source déjà arrêtée : le barge-in reste valide.
      }
    }
    if (this.playing) {
      this.playing = false;
      this.callbacks.onAudioPlaying?.(false);
    }
    this.callbacks.onInterrupt?.(source);
  }

  /**
   * Arrêt propre : file vidée, source stoppée, WebSocket fermé (code 1000),
   * AudioContext de lecture fermé. Idempotent.
   */
  close(): void {
    this.closedByUser = true;
    this.generation += 1;
    this.queue = [];
    const current = this.currentSource;
    this.currentSource = null;
    if (current) {
      try {
        current.stop();
      } catch {
        // Déjà arrêtée.
      }
    }
    if (this.playing) {
      this.playing = false;
      this.callbacks.onAudioPlaying?.(false);
    }
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== WS_CLOSED) {
      try {
        socket.close(1000, "session fermée par l'opérateur");
      } catch {
        // Socket déjà fermé.
      }
    }
    const context = this.playbackContext;
    this.playbackContext = null;
    if (context) void context.close().catch(() => undefined);
    this.setState("closed");
  }

  /* -------------------------- interne ---------------------------- */

  private setState(state: GeminiLiveState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.callbacks.onStateChange?.(state);
  }

  private sendJson(payload: unknown): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      this.callbacks.onError?.(`Envoi WebSocket impossible : ${error instanceof Error ? error.message : "erreur inconnue"}`);
      return false;
    }
  }

  private handleSocketClosed(): void {
    this.socket = null;
    this.queue = [];
    this.generation += 1;
    const current = this.currentSource;
    this.currentSource = null;
    if (current) {
      try {
        current.stop();
      } catch {
        // Déjà arrêtée.
      }
    }
    if (this.playing) {
      this.playing = false;
      this.callbacks.onAudioPlaying?.(false);
    }
    if (!this.closedByUser && this.currentState === "live") {
      this.callbacks.onError?.("La connexion Gemini Live a été fermée par le serveur.");
    }
    this.setState("closed");
  }

  /** Reçoit un frame WebSocket : string JSON, ArrayBuffer ou Blob (navigateur). */
  private async ingestMessageData(data: unknown): Promise<void> {
    let text: string | null = null;
    if (typeof data === "string") {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(data);
    } else if (typeof data === "object" && data !== null && typeof (data as { text?: unknown }).text === "function") {
      // Blob (binaryType par défaut du navigateur) : lecture asynchrone.
      try {
        text = await (data as { text(): Promise<string> }).text();
      } catch {
        text = null;
      }
    }
    if (text === null) {
      this.callbacks.onError?.("Message WebSocket Gemini illisible (type de frame inattendu).");
      return;
    }
    this.handleParsedMessage(parseServerMessage(text));
  }

  private handleParsedMessage(parsed: GeminiParsedMessage): void {
    if (!parsed.recognized) return;
    if (parsed.setupComplete) {
      this.callbacks.onSetupComplete?.();
      return;
    }
    if (parsed.interrupted) this.interrupt("server");
    if (parsed.text) this.callbacks.onText?.(parsed.text);
    for (const chunk of parsed.audioBase64) this.enqueueAudio(chunk);
    if (parsed.turnComplete) this.callbacks.onTurnComplete?.();
  }

  private enqueueAudio(base64: string): void {
    if (this.currentState !== "live") return;
    this.queue.push(base64);
    if (!this.playing) this.startNextChunk();
  }

  private startNextChunk(): void {
    if (this.currentState !== "live") {
      this.queue = [];
      return;
    }
    const next = this.queue.shift();
    if (next === undefined) {
      if (this.playing) {
        this.playing = false;
        this.callbacks.onAudioPlaying?.(false);
      }
      return;
    }
    const context = this.ensurePlaybackContext();
    if (!context) {
      // Pas de sortie audio disponible : l'échec est explicite (journal), la
      // file est purgée — jamais de lecture simulée.
      this.queue = [];
      this.playing = false;
      return;
    }
    const samples = pcm16Base64ToFloat32(next);
    if (samples.length === 0) {
      this.startNextChunk();
      return;
    }
    const buffer = context.createBuffer(1, samples.length, GEMINI_OUTPUT_SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const generation = this.generation;
    source.addEventListener("ended", () => {
      if (generation !== this.generation || this.currentSource !== source) return;
      this.currentSource = null;
      this.startNextChunk();
    });
    this.currentSource = source;
    if (!this.playing) {
      this.playing = true;
      this.callbacks.onAudioPlaying?.(true);
    }
    source.start();
  }

  private ensurePlaybackContext(): GeminiAudioContextLike | null {
    if (!this.playbackContext) {
      try {
        const context = this.audioContextFactory();
        this.playbackContext = context;
        // Politique autoplay : le contexte peut naître suspendu — reprise
        // best-effort, l'échec réel se verra à la lecture (aucun son simulé).
        void context.resume().catch(() => undefined);
      } catch (error) {
        this.callbacks.onError?.(`Sortie audio indisponible : ${error instanceof Error ? error.message : "erreur inconnue"}`);
        return null;
      }
    }
    return this.playbackContext;
  }
}
