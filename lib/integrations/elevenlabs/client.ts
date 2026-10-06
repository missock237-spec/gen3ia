/**
 * Client ElevenLabs — autorisations analysées pour le token fourni :
 * - tier "free" : 10 000 caracteres/mois, 3 voix personnalisees max
 * - Modeles TTS disponibles : eleven_v3, eleven_multilingual_v2 (FR),
 *   eleven_flash_v2_5, eleven_turbo_v2_5, eleven_turbo_v2, eleven_flash_v2
 * - Modeles speech-to-speech listes mais non exploites ici (usage free restreint)
 * Fonctionnalites actives pour le projet : synthese vocale (TTS) multilingue
 * + listing des voix disponibles + clonage vocal (Instant Voice Cloning,
 *   POST /v1/voices/add) branché pour la bibliothèque de voix vidéo : le
 *   clonage n'est déclenché QUE pour un échantillon dont l'utilisateur a
 *   attesté détenir les droits (coût TTS/clonage alors assumé).
 */

const API_BASE = "https://api.elevenlabs.io/v1";

export const ELEVENLABS_MODELS = [
  "eleven_multilingual_v2",
  "eleven_v3",
  "eleven_flash_v2_5",
  "eleven_turbo_v2_5",
] as const;

export type ElevenLabsModel =
  (typeof ELEVENLABS_MODELS)[number];

/** Voix par defaut : George - Warm (multilingue, stable, bibliotheque partagee). */
const DEFAULT_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";

const DEFAULT_MODEL: ElevenLabsModel =
  "eleven_multilingual_v2";

export function getElevenLabsApiKey(): string {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ELEVENLABS_API_KEY is not configured.",
    );
  }
  return apiKey;
}

export interface ElevenLabsVoice {
  voiceId: string;
  name: string;
  category: string;
  labels: Record<string, string>;
  previewUrl?: string;
}

export interface AddElevenLabsVoiceResult {
  voiceId: string;
}

/**
 * Clone une voix (Instant Voice Cloning) à partir d'un échantillon audio
 * encodé en data URI. POST {API_BASE}/v1/voices/add en multipart/form-data
 * (même construction d'URL que les autres fonctions de ce client : API_BASE
 * + chemin, auth entête "xi-api-key"). Champ "files" obligatoire côté API ;
 * "name" porte le nom de la voix, "description" est optionnel.
 */
export async function addElevenLabsVoice(
  params: {
    name: string;
    audioDataUri: string;
    description?: string;
  },
): Promise<AddElevenLabsVoiceResult> {
  const apiKey = getElevenLabsApiKey();

  // Data URI -> Buffer : même découpage que la persistance audio du chat
  // (entête "data:<mime>;base64," puis charge utile base64).
  const [header, base64 = ""] = params.audioDataUri.split(",");
  const mimeType = header.slice(5).replace(/;base64$/, "") || "audio/mpeg";
  const audio = Buffer.from(base64, "base64");
  if (audio.byteLength === 0) {
    throw new Error(
      "Le clonage de voix exige un échantillon audio non vide.",
    );
  }

  const extension = mimeType.includes("wav")
    ? "wav"
    : mimeType.includes("ogg")
      ? "ogg"
      : mimeType.includes("flac")
        ? "flac"
        : mimeType.includes("mpeg")
          ? "mp3"
          : mimeType.includes("mp4")
            ? "m4a"
            : "webm"; // webm/opus (MediaRecorder navigateur) — accepté par IVC

  const form = new FormData();
  form.append("name", params.name);
  if (params.description && params.description.trim().length > 0) {
    form.append("description", params.description.trim());
  }
  form.append(
    "files",
    new Blob([new Uint8Array(audio)], { type: mimeType }),
    `sample.${extension}`,
  );

  // Upload d'échantillon potentiellement lourd : timeout généreux (2 min),
  // gestion d'erreur calquée sur le reste du client (statut + extrait API).
  const response = await fetch(`${API_BASE}/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Le clonage de la voix a échoué (ElevenLabs ${response.status}) : ${detail.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as { voice_id?: string };
  if (!data.voice_id) {
    throw new Error(
      "ElevenLabs n'a pas retourné d'identifiant pour la voix clonée.",
    );
  }

  return { voiceId: data.voice_id };
}

export async function listElevenLabsVoices(): Promise<
  ElevenLabsVoice[]
> {
  // Appel léger (métadonnées) : timeout borné — une connexion pendante ne
  // doit jamais bloquer l'exécution de l'outil (audit 103-f).
  const response = await fetch(`${API_BASE}/voices`, {
    headers: { "xi-api-key": getElevenLabsApiKey() },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(
      `ElevenLabs voices returned ${response.status}.`,
    );
  }

  const data = (await response.json()) as {
    voices?: Array<{
      voice_id: string;
      name: string;
      category?: string;
      labels?: Record<string, string>;
      preview_url?: string;
    }>;
  };

  return (data.voices ?? []).map((voice) => ({
    voiceId: voice.voice_id,
    name: voice.name,
    category: voice.category ?? "library",
    labels: voice.labels ?? {},
    previewUrl: voice.preview_url,
  }));
}

async function resolveVoiceId(
  voiceId?: string,
): Promise<string> {
  if (voiceId && voiceId.trim().length > 0) {
    return voiceId.trim();
  }

  const configured =
    process.env.ELEVENLABS_VOICE_ID;
  if (configured) return configured;

  // Sans configuration explicite, tente une voix de la bibliotheque.
  try {
    const voices = await listElevenLabsVoices();
    const preferred = voices.find((voice) =>
      voice.voiceId === DEFAULT_VOICE_ID,
    );
    return (
      preferred?.voiceId ?? voices[0]?.voiceId ?? DEFAULT_VOICE_ID
    );
  } catch {
    return DEFAULT_VOICE_ID;
  }
}

export interface TextToSpeechResult {
  audioBase64: string;
  mimeType: string;
  voiceId: string;
  modelId: string;
  charactersUsed: number;
}

export async function elevenLabsTextToSpeech(
  options: {
    text: string;
    voiceId?: string;
    modelId?: string;
  },
): Promise<TextToSpeechResult> {
  const voiceId = await resolveVoiceId(
    options.voiceId,
  );

  const modelId =
    options.modelId &&
    (ELEVENLABS_MODELS as readonly string[]).includes(
      options.modelId,
    )
      ? options.modelId
      : DEFAULT_MODEL;

  const response = await fetch(
    `${API_BASE}/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": getElevenLabsApiKey(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: options.text,
        model_id: modelId,
      }),
      // Synthèse ≤ 2 500 caractères : quelques secondes en nominal —
      // timeout borné (60 s) pour ne jamais pendre (audit 103-f).
      signal: AbortSignal.timeout(60_000),
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `ElevenLabs TTS returned ${response.status}: ${detail.slice(0, 200)}`,
    );
  }

  const audio = Buffer.from(
    await response.arrayBuffer(),
  );

  if (audio.byteLength === 0) {
    throw new Error(
      "ElevenLabs TTS returned empty audio.",
    );
  }

  return {
    audioBase64: audio.toString("base64"),
    mimeType: "audio/mpeg",
    voiceId,
    modelId,
    charactersUsed: options.text.length,
  };
}
