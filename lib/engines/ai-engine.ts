import { z } from "zod";
import { generate } from "@/lib/ai/router";
import type { TaskType } from "@/lib/ai/models";
import type { EngineFeature } from "./types";

/**
 * Moteur 1 — AI Engine.
 *
 * Point d'entrée unique des modules métier pour toute intervention LLM :
 * génération de contenu, analyse, recommandations. S'appuie sur le routeur
 * multi-providers existant (groq, openrouter, anthropic…) avec replis, et
 * ajoute deux primitives consommables :
 *  - `runAI`         : texte libre, prompt système + utilisateur ;
 *  - `runAIJSON`     : sortie structurée garantie par un schéma zod, avec
 *    extraction robuste du JSON (fences markdown, texte parasite) et une
 *    relance corrective si le premier rendu n'est pas parsable.
 */

export interface RunAIInput {
  /** Propriétaire de l'appel — sert au suivi d'usage et au quota. */
  userId: string;
  /** Étiquette de traçabilité (module métier appelant). */
  feature: EngineFeature;
  system: string;
  prompt: string;
  task?: TaskType;
  temperature?: number;
  maxTokens?: number;
}

export interface RunAIResult {
  text: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export async function runAI(input: RunAIInput): Promise<RunAIResult> {
  const response = await generate({
    task: input.task ?? "reasoning",
    preferFree: true,
    temperature: input.temperature ?? 0.4,
    maxTokens: input.maxTokens ?? 1_600,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.prompt },
    ],
    metadata: { feature: input.feature, userId: input.userId },
  });

  return {
    text: response.text,
    provider: response.provider,
    model: response.model,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    latencyMs: response.latencyMs,
  };
}

/**
 * Extrait un objet JSON d'un rendu LLM : tolère les fences ```json, le texte
 * autour, et tronque après la dernière accolade fermante.
 */
export function extractJsonObject(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  if (start === -1) throw new Error("Aucun objet JSON trouvé dans la réponse du modèle.");
  // On part du plus long préfixe plausiblement JSON : de la première `{` à la
  // dernière `}` — puis on laisse JSON.parse arbitrer.
  const end = cleaned.lastIndexOf("}");
  if (end <= start) throw new Error("Réponse JSON tronquée du modèle.");
  const candidate = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    // Dernier recours : fermeture progressive des tableaux/objets ouverts.
    let patched = candidate;
    const opens = (patched.match(/{/g) ?? []).length;
    const closes = (patched.match(/}/g) ?? []).length;
    if (opens > closes) patched = patched + "}".repeat(opens - closes);
    return JSON.parse(patched);
  }
}

export interface RunAIJSONInput<TSchema extends z.ZodTypeAny> extends Omit<RunAIInput, "prompt"> {
  prompt: string;
  schema: TSchema;
  /** Nom du champ attendu dans les messages d'erreur, ex. "contenu de landing". */
  label?: string;
}

export type RunAIJSONResult<TSchema extends z.ZodTypeAny> = RunAIResult & {
  data: z.infer<TSchema>;
};

/**
 * Appelle le modèle et garantit une sortie validée par `schema`. En cas
 * d'échec de parsing/validation, une relance corrective est tentée en
 * montrant l'erreur au modèle — deux essais au total, ensuite on échoue
 * franchement (le module affiche l'erreur, jamais un résultat inventé).
 */
export async function runAIJSON<TSchema extends z.ZodTypeAny>(
  input: RunAIJSONInput<TSchema>,
): Promise<RunAIJSONResult<TSchema>> {
  const repairNote = (message: string) =>
    `${input.prompt}\n\nIMPORTANT : ta réponse précédente était invalide (${message}). ` +
    `Réponds UNIQUEMENT avec un objet JSON valide conforme au schéma demandé, sans texte autour, sans bloc de code.`;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runAI({
      ...input,
      prompt: attempt === 0 ? input.prompt : repairNote(lastError?.message ?? "JSON invalide"),
      task: input.task ?? "reasoning",
      temperature: attempt === 0 ? (input.temperature ?? 0.4) : 0.1,
    });
    try {
      const parsed = input.schema.parse(extractJsonObject(result.text));
      return { ...result, data: parsed };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw new Error(
    `L'IA n'a pas produit un JSON exploitable${input.label ? ` (${input.label})` : ""} : ${lastError?.message ?? "raison inconnue"}`,
  );
}
