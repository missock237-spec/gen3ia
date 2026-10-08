/**
 * Protocole filaire « Live Voix » (Task 110-a) — types partagés entre le
 * serveur (pipeline + routes API) et le client (Task 110-b, qui CONSOMME ce
 * module sans jamais le modifier).
 *
 * Un tour de parole est diffusé en NDJSON : chaque événement est une ligne
 * `JSON + "\n"`. La séquence nominale est :
 *   transcript → (sentence, audio)* → usage → done
 * Toute anomalie interrompt la séquence par un événement `error` FINAL
 * (le client doit cesser d'attendre dès réception d'une erreur).
 *
 * Module PUR (aucun import, aucune API Node) : sûr à importer côté client.
 */

/** Difficulté d'un tour de parole (pilote le multiplicateur de facturation). */
export type LiveVoiceDifficulty = "simple" | "standard" | "avance";

/** Codes d'erreur machine du protocole (événement `error` + réponses HTTP). */
export type LiveVoiceErrorCode =
  | "LIVE_INSUFFICIENT_FUNDS"
  | "LIVE_SESSION_EXPIRED"
  | "LIVE_SESSION_INVALID"
  | "LIVE_PC_ONLY"
  | "LIVE_RATE_LIMITED"
  | "LIVE_TURN_FAILED"
  | "LIVE_STT_EMPTY"
  | "LIVE_UNCONFIGURED";

/** Répartition du coût d'un tour (centimes d'euro, même unité que le wallet). */
export interface LiveVoiceUsageBreakdown {
  sttMinor: number;
  ttsMinor: number;
  agentMinor: number;
}

/**
 * Flux d'événements d'un tour de parole Live Voix :
 *  - `transcript` : texte reconnu par le STT (émis dès disponibilité) ;
 *  - `sentence`   : phrase isolée de la réponse (index croissant) ;
 *  - `audio`      : audio TTS de la phrase (data URI, jouable immédiatement) ;
 *  - `usage`      : coût facturé pour CE tour (turnId = référence billing) ;
 *  - `error`      : anomalie — événement FINAL du flux ;
 *  - `done`       : fin nominale du tour (texte complet de la réponse).
 */
export type LiveVoiceTurnEvent =
  | { type: "transcript"; text: string }
  | { type: "sentence"; index: number; text: string }
  | { type: "audio"; index: number; dataUri: string; mimeType: string }
  | {
      type: "usage";
      turnId: string;
      difficulty: LiveVoiceDifficulty;
      costMinor: number;
      breakdown: LiveVoiceUsageBreakdown;
    }
  | { type: "error"; code: LiveVoiceErrorCode; message: string }
  | { type: "done"; turnId: string; replyText: string };

/**
 * Charge utile SANS ÉTAT du jeton de session HMAC-SHA256 : le serveur ne
 * stocke rien — la session vit entièrement dans ce jeton signé.
 */
export interface LiveVoiceSessionPayload {
  uid: string;
  conversationId: string;
  /** Numéro de renouvellement (1 à la création, +1 à chaque renew). */
  epoch: number;
  /** Émission (ms epoch). */
  issuedAt: number;
  /** Expiration (ms epoch) — issuedAt + durée de session. */
  exp: number;
  /** Identifiant unique du jeton (anti-rejeu informel, audit). */
  jti: string;
}

/** Réponse de POST /api/live/voice/session (création de session). */
export interface CreateSessionResponse {
  token: string;
  conversationId: string;
  /** Expiration du jeton (ms epoch). */
  expiresAt: number;
  epoch: number;
  maxEpochs: number;
}

/** Réponse de POST /api/live/voice/renew (même forme qu'une création). */
export type RenewResponse = CreateSessionResponse;
