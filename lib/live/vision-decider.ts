import OpenAI from "openai";
import { z } from "zod";
import { LiveActionSchema, type LiveAction, type LiveSession } from "./types";

const DecisionSchema = z.object({
  done: z.boolean(),
  message: z.string().max(2000).default(""),
  action: LiveActionSchema.nullable().default(null),
});

const MAX_FRAME_BYTES = 1_500_000;
const MAX_CONTEXT_ERROR = 2000;

interface VisionProvider {
  name: string;
  client: OpenAI;
  model: string;
}

/** Garde de latence (Task 45) : une décision vision ne traîne jamais. */
const VISION_TIMEOUT_MS = 12_000;

/**
 * Fournisseurs de vision, par priorité, avec CACHE (Task 45) : les clients
 * OpenAI ne sont plus recréés à chaque frame (chaque construction re-créait
 * le pool de connexions — latence et mémoire gaspillées). Le cache est
 * invalidé si la signature des variables d'environnement change.
 */
let providerCache: { signature: string; providers: VisionProvider[] } | null = null;

function visionEnvSignature(): string {
  return [process.env.OPENAI_API_KEY, process.env.GROQ_API_KEY, process.env.AGNES_API_KEY, process.env.LIVE_AGENT_VISION_MODEL].join("|");
}

function getVisionProviders(): VisionProvider[] {
  const signature = visionEnvSignature();
  if (providerCache && providerCache.signature === signature) return providerCache.providers;

  const providers: VisionProvider[] = [];
  const modelOverride = process.env.LIVE_AGENT_VISION_MODEL;

  if (process.env.OPENAI_API_KEY) {
    providers.push({
      name: "openai",
      client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: VISION_TIMEOUT_MS, maxRetries: 1 }),
      model: modelOverride || "gpt-4.1-mini",
    });
  }
  if (process.env.GROQ_API_KEY) {
    providers.push({
      name: "groq",
      client: new OpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: "https://api.groq.com/openai/v1",
        timeout: VISION_TIMEOUT_MS,
        maxRetries: 1,
      }),
      model: modelOverride || "meta-llama/llama-4-scout-17b-16e-instruct",
    });
  }
  if (process.env.AGNES_API_KEY) {
    providers.push({
      name: "agnes",
      client: new OpenAI({
        apiKey: process.env.AGNES_API_KEY,
        baseURL: "https://apihub.agnes-ai.com/v1",
        timeout: VISION_TIMEOUT_MS,
        maxRetries: 1,
      }),
      model: modelOverride || "agnes-3.0-flash",
    });
  }

  if (providers.length === 0) {
    throw new Error("Aucun fournisseur de vision configuré (OPENAI_API_KEY, GROQ_API_KEY ou AGNES_API_KEY requis)");
  }
  providerCache = { signature, providers };
  return providers;
}

/**
 * Extraction JSON tolérante (Task 45) : certains modèles enferment leur
 * décision dans une fence markdown ou la bordent de texte — on tente le
 * JSON brut, la fence, puis le premier objet trouvé.
 */
function parseDecisionJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    // candidats suivants
  }
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // candidat suivant
    }
  }
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(content.slice(start, end + 1));
    } catch {
      // échec final
    }
  }
  throw new Error("Live vision model returned an unparseable decision");
}

export interface LiveActionFeedback {
  ok: boolean;
  error?: string;
  at: number;
}

const BROWSER_MODE_RULES = [
  "The client is the user's own web browser using native screen sharing: it CANNOT move the mouse, type, or touch files.",
  "In this mode you may only return `wait` actions (to let the screen evolve) — never mouse.*, keyboard.* or file.*.",
  "Describe precisely what you observe, explain in `message` the exact next step that should be performed on the computer, and mark done=true once the objective is visually achieved or impossible from observation alone.",
].join(" ");

export async function decideLiveAction(
  session: LiveSession,
  jpeg: Buffer,
  width: number,
  height: number,
  feedback?: LiveActionFeedback,
): Promise<z.infer<typeof DecisionSchema>> {
  if (!session.permissions.includes("screen.read")) throw new Error("Live session has no screen.read permission");
  if (jpeg.length === 0 || jpeg.length > MAX_FRAME_BYTES) throw new Error("Live frame exceeds the allowed size");

  const browserMode = session.mode === "browser";
  const systemText = [
    "You are the visual execution planner for a user-owned Gen3ia Live Agent.",
    "The user explicitly authorized this session. Inspect the current screen and advance the stated objective one safe step at a time.",
    "Use the previous action result when available. Never invent UI state and never repeat a failed action without verifying the current screen.",
    "Prefer one minimal action per decision.",
    "Do not autonomously perform destructive, financial, account-security, credential, or irreversible actions.",
    "Do not ask for or expose passwords, API keys, recovery codes, cookies, tokens, or private secrets.",
    "File writes are sensitive and must be presented for explicit confirmation by the user.",
    "If the screen is ambiguous or a human decision is required, return action=null and explain what is needed.",
    "Coordinates are pixels in the supplied frame.",
    ...(browserMode ? [BROWSER_MODE_RULES] : []),
    "Return strict JSON: {done:boolean,message:string,action:null|{type,...}}.",
  ].join(" ");

  let lastError: unknown = null;
  for (const provider of getVisionProviders()) {
    try {
      return await runVisionDecision(provider, session, jpeg, width, height, feedback, systemText, browserMode);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Live vision providers all failed");
}

async function runVisionDecision(
  provider: VisionProvider,
  session: LiveSession,
  jpeg: Buffer,
  width: number,
  height: number,
  feedback: LiveActionFeedback | undefined,
  systemText: string,
  browserMode: boolean,
): Promise<z.infer<typeof DecisionSchema>> {
  const response = await provider.client.chat.completions.create({
    model: provider.model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemText },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              objective: session.objective,
              viewport: { width, height },
              previousActionResult: feedback ? { ok: feedback.ok, error: feedback.error?.slice(0, MAX_CONTEXT_ERROR) } : null,
            }),
          },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
        ],
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Live vision model returned no decision");
  const parsed = DecisionSchema.parse(parseDecisionJson(content));
  if (parsed.action) LiveActionSchema.parse(parsed.action);
  // Garde dure : en mode navigateur, aucune action hors `wait` ne peut être
  // renvoyée au client (le navigateur ne contrôle ni le clavier, ni la souris,
  // ni les fichiers). L'intention reste visible dans `message`.
  if (browserMode && parsed.action && parsed.action.type !== "wait") {
    parsed.message = `${parsed.message} (Action « ${parsed.action.type} » non exécutable en mode navigateur — à réaliser sur l'ordinateur.)`.slice(0, 2000);
    parsed.action = null;
  }
  return parsed;
}

export function actionRequiresConfirmation(action: LiveAction): boolean {
  if (action.type === "file.write") return true;
  if (action.type === "keyboard.type") {
    return /password|secret|api[_ -]?key|token|recovery|private key/i.test(action.text);
  }
  return false;
}
