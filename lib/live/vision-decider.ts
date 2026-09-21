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

function getClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is required for live vision");
  return new OpenAI({ apiKey: key });
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

  const client = getClient();
  const model = process.env.LIVE_AGENT_VISION_MODEL || "gpt-4.1-mini";
  const browserMode = session.mode === "browser";
  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
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
        ].join(" "),
      },
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
  const parsed = DecisionSchema.parse(JSON.parse(content));
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
