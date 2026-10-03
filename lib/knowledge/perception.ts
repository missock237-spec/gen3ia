import { generate } from "@/lib/ai/router";

/**
 * COUCHE DE PERCEPTION (concept post-SaaS #9 « Reality-to-Digital Engine ») :
 * transformer le RÉEL — photos, scans, enregistrements vocaux — en TEXTE
 * indexable par la base de connaissances Gen3ia.
 *
 *  - OCR : transcription des images par un modèle VISION du routeur IA
 *    (pièces jointes `images` déjà validées par la couche content-filter) ;
 *  - ASR : transcription audio par ElevenLabs Scribe (clé déjà utilisée pour
 *    la synthèse vocale — aucune nouvelle dépendance).
 *
 * Les deux fonctions échouent HONNÊTEMENT : sans fournisseur configuré,
 * l'erreur NOMME la variable d'environnement manquante — jamais de texte
 * vide ni de transcription inventée.
 */

const OCR_SYSTEM =
  "Tu es un moteur d'OCR professionnel. Transcris TOUT le texte visible de l'image, " +
  "exactement, dans l'ordre de lecture (colonnes et tableaux rendus ligne à ligne, " +
  "langues d'origine conservées). N'ajoute AUCUN commentaire, résumé ou interprétation — " +
  "uniquement la transcription. Si l'image ne contient aucun texte lisible, réponds exactement : [aucun texte détecté]";

const OCR_MAX_IMAGE_BYTES = 8_000_000;
const ASR_TIMEOUT_MS = 120_000;
export const PERCEPTION_MAX_AUDIO_BYTES = 20_000_000;

export const OCR_SUPPORTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** OCR réel d'une image par un modèle vision du routeur (échec = erreur explicite). */
export async function ocrImageToText(input: { buffer: Buffer; mimeType: string; filename?: string }): Promise<{ text: string; providerLabel: string }> {
  const mimeType = input.mimeType.toLowerCase();
  if (!OCR_SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error(`OCR : format image non pris en charge (${mimeType}). Formats acceptés : PNG, JPEG, WEBP, GIF.`);
  }
  if (input.buffer.length > OCR_MAX_IMAGE_BYTES) {
    throw new Error(`Image trop volumineuse pour l'OCR (max ${Math.round(OCR_MAX_IMAGE_BYTES / 1_000_000)} Mo).`);
  }
  try {
    const response = await generate({
      task: "reasoning",
      requiresVision: true,
      messages: [
        { role: "system", content: OCR_SYSTEM },
        {
          role: "user",
          content: `Transcris l'intégralité du texte de ce document image${input.filename ? ` (« ${input.filename.slice(0, 120)} »)` : ""}.`,
          images: [{ mediaType: mimeType as "image/png", source: { type: "base64", data: input.buffer.toString("base64") } }],
        },
      ],
    });
    const text = response.text.trim();
    if (!text || text === "[aucun texte détecté]") {
      return { text: "", providerLabel: "vision-ocr" };
    }
    return { text, providerLabel: "vision-ocr" };
  } catch (error) {
    // Honnêteté opérationnelle : l'erreur NOMME la configuration manquante
    // au lieu d'un message de routeur technique (« no provider »).
    const raw = error instanceof Error ? error.message : String(error);
    if (raw.includes("No configured provider")) {
      throw new Error("OCR indisponible : aucun modèle vision configuré sur la plateforme (un fournisseur avec capacité vision est requis, ex. OPENAI_API_KEY).");
    }
    throw error instanceof Error ? error : new Error(raw);
  }
}

/**
 * ASR réel d'un fichier audio via ElevenLabs Scribe (multipart/form-data).
 * Modèle multilingue : la langue d'origine est restituée telle quelle.
 */
export async function transcribeAudioToText(input: { buffer: Buffer; filename: string; mimeType?: string }): Promise<{ text: string; providerLabel: string }> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("Transcription audio indisponible : ELEVENLABS_API_KEY n'est pas configurée.");
  }
  if (input.buffer.length > PERCEPTION_MAX_AUDIO_BYTES) {
    throw new Error(`Audio trop volumineux pour la transcription (max ${Math.round(PERCEPTION_MAX_AUDIO_BYTES / 1_000_000)} Mo).`);
  }
  const form = new FormData();
  const mimeType = input.mimeType || "audio/mpeg";
  form.append("file", new Blob([new Uint8Array(input.buffer)], { type: mimeType }), input.filename.slice(0, 200) || "audio");
  form.append("model_id", "scribe_v1");
  form.append("diarize", "false");

  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
    signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Transcription audio impossible (HTTP ${response.status})${detail ? ` : ${detail.slice(0, 200)}` : ""}.`);
  }
  const payload = (await response.json()) as { text?: unknown; language_code?: unknown };
  if (typeof payload.text !== "string") {
    throw new Error("Transcription audio : réponse du fournisseur sans texte.");
  }
  return { text: payload.text.trim(), providerLabel: typeof payload.language_code === "string" ? `scribe_v1:${payload.language_code}` : "scribe_v1" };
}

/** Renvoie la sortie perception (OCR ou ASR) selon le type MIME, ou null si le type n'est pas perceptuel. */
export async function perceiveIfSupported(input: { buffer: Buffer; mimeType: string; filename: string }): Promise<{ text: string; providerLabel: string } | null> {
  const mimeType = input.mimeType.toLowerCase();
  if (mimeType.startsWith("image/")) {
    return ocrImageToText({ buffer: input.buffer, mimeType, filename: input.filename });
  }
  if (mimeType.startsWith("audio/")) {
    return transcribeAudioToText({ buffer: input.buffer, filename: input.filename, mimeType });
  }
  return null;
}

/** Décision PURE d'acheminement d'un upload vers la couche perception. */
export function perceptionRouteFor(mimeType: string, filename: string): "ocr" | "asr" | null {
  const lower = mimeType.toLowerCase();
  if (lower.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(filename)) return "ocr";
  if (lower.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|flac|webm)$/i.test(filename)) return "asr";
  return null;
}
