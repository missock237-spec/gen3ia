import { NextResponse } from "next/server";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { captureServerException } from "@/lib/observability/sentry";
import { detectDeviceFromHeaders } from "@/lib/device/detect";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import {
  LiveVoiceSessionError,
  liveVoiceErrorCodeOf,
  liveVoiceErrorMessageOf,
  liveVoiceErrorStatus,
  verifyLiveVoiceSession,
} from "@/lib/live/voice/session-token";
import { runLiveVoiceTurn } from "@/lib/live/voice/turn-pipeline";
import type { LiveVoiceTurnEvent } from "@/lib/live/voice/protocol";

/**
 * POST /api/live/voice/turn — un tour de parole Live Voix (Task 110-a).
 *
 * multipart/form-data : `audio` (File ≤ 15 Mo, wav|mpeg|webm) + `token`
 * (jeton de session HMAC) [+ `durationSec` optionnel : durée de l'énoncé en
 * secondes, sinon déduite de l'entête WAV si possible, sinon 0 = facturation
 * STT skippée]. La réponse est un flux NDJSON d'événements du protocole
 * (Content-Type application/x-ndjson, sans buffer proxy, sans cache) :
 * transcript → (sentence, audio)* → usage → done, ou un `error` final.
 */

const PC_ONLY_MESSAGE =
  "La session Live Voix est réservée aux ordinateurs (Windows/Linux/macOS) : elle utilise le micro et la lecture audio du navigateur.";

/** Plafond d'un énoncé uploadé (octets) — ~25 s de WAV 16 kHz mono reste ≪. */
const AUDIO_MAX_BYTES = 15 * 1024 * 1024;

/** Formats audio acceptés (mime normalisé, paramètres `;codecs=` retirés). */
const ALLOWED_AUDIO_MIME = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/webm"]);

/** Borne haute de la durée d'un énoncé (secondes) — anti-facturation folle. */
const MAX_AUDIO_SECONDS = 600;

function pcOnlyGuard(request: Request): NextResponse | null {
  const device = detectDeviceFromHeaders(request.headers);
  if (!device.isLiveCapable) {
    return NextResponse.json(
      { error: PC_ONLY_MESSAGE, code: "LIVE_PC_ONLY", device: device.type, os: device.os },
      { status: 403 },
    );
  }
  return null;
}

function readAscii(buffer: Buffer, offset: number, length: number): string {
  return buffer.subarray(offset, offset + length).toString("latin1");
}

/**
 * Durée d'un WAV lu depuis l'entête RIFF (fmt byteRate + taille du chunk
 * data). 0 si l'entête est illisible — la facturation STT est alors skippée.
 */
function parseWavDurationSec(buffer: Buffer): number {
  try {
    if (buffer.length < 44 || readAscii(buffer, 0, 4) !== "RIFF" || readAscii(buffer, 8, 4) !== "WAVE") {
      return 0;
    }
    let offset = 12;
    let byteRate = 0;
    while (offset + 8 <= buffer.length) {
      const chunkId = readAscii(buffer, offset, 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      if (chunkId === "fmt " && offset + 24 <= buffer.length) {
        // fmt : audioFormat(2) numChannels(2) sampleRate(4) byteRate(4)…
        byteRate = buffer.readUInt32LE(offset + 16);
      }
      if (chunkId === "data") {
        const dataSize = Math.min(chunkSize, buffer.length - (offset + 8));
        if (byteRate > 0 && dataSize > 0) return dataSize / byteRate;
        return 0;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    return 0;
  } catch {
    return 0;
  }
}

/** durationSec du formulaire (optionnel) : nombre borné [0, 600]. */
function durationSecFromForm(form: FormData): number | null {
  const raw = form.get("durationSec");
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(parsed, MAX_AUDIO_SECONDS);
}

export async function POST(request: Request) {
  try {
    const pcOnly = pcOnlyGuard(request);
    if (pcOnly) return pcOnly;
    const auth = await verifyFirebaseAuth(request);
    const liveLimit = await enforceRateLimit(`live-voice-turn:${auth.uid}`, { limit: 60, windowMs: 5 * 60 * 1000 });
    if (!liveLimit.allowed) {
      return NextResponse.json(
        { error: "Trop de tours de parole rapprochés. Marquez une courte pause.", code: "LIVE_RATE_LIMITED" },
        { status: 429 },
      );
    }

    const form = await request.formData();
    const tokenValue = form.get("token");
    if (typeof tokenValue !== "string" || !tokenValue.trim()) {
      return NextResponse.json(
        { error: "Jeton de session Live Voix manquant.", code: "LIVE_SESSION_INVALID" },
        { status: 403 },
      );
    }
    const audio = form.get("audio");
    if (!(audio instanceof File) || audio.size === 0) {
      return NextResponse.json({ error: "Échantillon audio manquant." }, { status: 400 });
    }
    if (audio.size > AUDIO_MAX_BYTES) {
      return NextResponse.json(
        { error: "Échantillon audio trop volumineux (15 Mo maximum)." },
        { status: 413 },
      );
    }
    const mimeType = (audio.type || "").split(";")[0]!.trim().toLowerCase();
    if (!ALLOWED_AUDIO_MIME.has(mimeType)) {
      return NextResponse.json(
        { error: "Format audio non pris en charge (wav, mp3 ou webm attendu)." },
        { status: 400 },
      );
    }

    // Vérification avec grâce 60 s (tours en vol à l'expiration) puis garde
    // d'identité : le jeton doit appartenir à l'utilisateur authentifié.
    const session = verifyLiveVoiceSession(tokenValue);
    if (session.uid !== auth.uid) {
      throw new LiveVoiceSessionError(
        "LIVE_SESSION_INVALID",
        "Jeton de session Live Voix émis pour un autre utilisateur.",
      );
    }

    const audioBuffer = Buffer.from(await audio.arrayBuffer());
    const audioDurationSec = durationSecFromForm(form) ?? parseWavDurationSec(audioBuffer);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: LiveVoiceTurnEvent) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        try {
          for await (const event of runLiveVoiceTurn({
            userId: auth.uid,
            conversationId: session.conversationId,
            session,
            audioBuffer,
            audioMimeType: mimeType,
            audioDurationSec,
          })) {
            send(event);
          }
        } catch (error) {
          // Filet global : le pipeline émet déjà ses erreurs — un rejet ici
          // reste une anomalie à tracer et à signaler proprement au client.
          captureServerException(error, { route: "live.voice.turn.stream" });
          send({
            type: "error",
            code: liveVoiceErrorCodeOf(error),
            message: liveVoiceErrorMessageOf(error),
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof LiveVoiceSessionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: liveVoiceErrorStatus(error.code) });
    }
    captureServerException(error, { route: "live.voice.turn" });
    return NextResponse.json(errorBody(error), { status: errorStatus(error, 400) });
  }
}
