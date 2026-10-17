import OpenAI from "openai";

/**
 * Agent copilote visuel temps réel (agentHandler).
 *
 * Ingère le flux de captures d'écran (JPEG base64 → Buffer) envoyé par le
 * navigateur via la gateway WebSocket, combiné à la question de
 * l'utilisateur, et RÉPOND EN STREAMING (chaque fragment est transmis au
 * client au fil de l'arrivée — latence de premier token minimale).
 *
 * Fournisseurs vision, par priorité (repli automatique) :
 *  1. OpenRouter (OPENROUTER_API_KEY) — modèles vision GPT-4o / Gemini 2.5
 *     Flash selon LIVE_COPILOT_MODEL (défaut : google/gemini-2.5-flash) ;
 *  2. OpenAI direct (OPENAI_API_KEY) ;
 *  3. Groq (GROQ_API_KEY) — Llama 4 Scout vision.
 *
 * Optimisation du payload :
 *  - une SEULE frame par question (la plus récente — l'écran actuel) ;
 *  - la frame est déjà réduite côté client (≤ 1280 px, JPEG qualité ~0.55) ;
 *  - historique conversationnel borné (8 derniers tours) ;
 *  - timeout dur par question, abandon via AbortController (bouton Stop).
 */

const COPILOT_TIMEOUT_MS = 25_000;
const MAX_HISTORY_TURNS = 8;
const MAX_ASK_CHARS = 4_000;

/** System prompt du copilote visuel (spécification produit). */
export const COPILOT_SYSTEM_PROMPT = [
  "Tu es un copilote visuel temps réel. Tu reçois des captures d'écran régulières de ce que fait l'utilisateur.",
  "Analyse l'interface utilisateur (boutons, formulaires, erreurs, code, pages web) et réponds avec précision, concision et pragmatisme pour guider l'utilisateur dans son action.",
  "Règles : réponds dans la langue de l'utilisateur (français par défaut). Réfère-toi UNIQUEMENT à ce qui est visible à l'écran — n'invente jamais d'éléments d'interface.",
  "Cite les libellés exacts des boutons, champs, menus ou erreurs que tu décris pour que l'utilisateur les retrouve immédiatement.",
  "Reste concis : l'utilisateur lit ta réponse PENDANT qu'il agit — va droit au but, étape par étape si besoin.",
  "Ne demande ni mot de passe, ni clé API, ni code de récupération, ni token. Ne lis jamais à voix haute des secrets visibles à l'écran.",
].join("\n");

interface CopilotVisionProvider {
  name: string;
  client: OpenAI;
  model: string;
}

let providerCache: { signature: string; providers: CopilotVisionProvider[] } | null = null;

function providerEnvSignature(): string {
  return [process.env.OPENROUTER_API_KEY, process.env.OPENAI_API_KEY, process.env.GROQ_API_KEY, process.env.LIVE_COPILOT_MODEL].join("|");
}

function getCopilotProviders(): CopilotVisionProvider[] {
  const signature = providerEnvSignature();
  if (providerCache && providerCache.signature === signature) return providerCache.providers;

  const modelOverride = process.env.LIVE_COPILOT_MODEL?.trim();
  const providers: CopilotVisionProvider[] = [];

  if (process.env.OPENROUTER_API_KEY?.trim()) {
    providers.push({
      name: "openrouter",
      client: new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY.trim(),
        baseURL: "https://openrouter.ai/api/v1",
        timeout: COPILOT_TIMEOUT_MS,
        maxRetries: 1,
      }),
      model: modelOverride || "google/gemini-2.5-flash",
    });
  }
  if (process.env.OPENAI_API_KEY?.trim()) {
    providers.push({
      name: "openai",
      client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim(), timeout: COPILOT_TIMEOUT_MS, maxRetries: 1 }),
      model: modelOverride?.includes("/") ? modelOverride.slice(modelOverride.indexOf("/") + 1) : modelOverride || "gpt-4o-mini",
    });
  }
  if (process.env.GROQ_API_KEY?.trim()) {
    providers.push({
      name: "groq",
      client: new OpenAI({
        apiKey: process.env.GROQ_API_KEY.trim(),
        baseURL: "https://api.groq.com/openai/v1",
        timeout: COPILOT_TIMEOUT_MS,
        maxRetries: 1,
      }),
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
    });
  }

  if (providers.length === 0) {
    throw new Error("Aucun fournisseur vision configuré pour le copilote (OPENROUTER_API_KEY, OPENAI_API_KEY ou GROQ_API_KEY requis)");
  }
  providerCache = { signature, providers };
  return providers;
}

export interface CopilotAskParams {
  question: string;
  frame?: { jpeg: Buffer; width: number; height: number };
  history: { role: "user" | "assistant"; content: string }[];
  signal?: AbortSignal;
}

export interface CopilotAskStream {
  onDelta: (text: string) => void;
}

/** Vérifie la demande avant tout appel modèle (garde d'entrée). */
export function assertCopilotAsk(question: string): string {
  const text = question.trim();
  if (text.length === 0) throw new Error("Question vide.");
  if (text.length > MAX_ASK_CHARS) throw new Error("Question trop longue.");
  return text;
}

/**
 * Répond à une question sur l'écran courant, en streaming.
 * Essaie chaque fournisseur vision par priorité ; la streaming commence
 * dès le premier fragment (premier token).
 */
export async function answerCopilotAsk(
  params: CopilotAskParams,
  stream: CopilotAskStream,
): Promise<string> {
  const { frame, history, signal } = params;
  let lastError: unknown = null;

  for (const provider of getCopilotProviders()) {
    try {
      const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
        {
          type: "text",
          text: frame
            ? `Question de l'utilisateur sur son écran actuel (${frame.width}x${frame.height}) :`
            : "Question de l'utilisateur (aucune capture d'écran disponible pour l'instant — réponds que tu attends le partage d'écran) :",
        },
      ];
      if (frame) {
        content.push({
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${frame.jpeg.toString("base64")}` },
        });
      }
      content.push({ type: "text", text: params.question });

      const response = await provider.client.chat.completions.create(
        {
          model: provider.model,
          temperature: 0.2,
          stream: true,
          messages: [
            { role: "system", content: COPILOT_SYSTEM_PROMPT },
            ...history.slice(-MAX_HISTORY_TURNS * 2),
            { role: "user", content },
          ],
        },
        { signal, timeout: COPILOT_TIMEOUT_MS },
      );

      let full = "";
      for await (const chunk of response) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) {
          full += delta;
          stream.onDelta(delta);
        }
      }
      if (full.trim().length === 0) throw new Error("Copilote vision : réponse vide");
      return full;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Copilote vision : tous les fournisseurs ont échoué");
}
