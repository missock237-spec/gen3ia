import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { AGENT_TYPES, AGENT_TONES, AGENT_VERBOSITY_LEVELS } from "@/lib/agents/schema";
import { generate } from "@/lib/ai/router";
import { extractJsonObject } from "@/lib/agents/planner/normalize";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/agents/generate — création d'agent par langage naturel.
 *
 * L'utilisateur décrit son besoin en une phrase (« Je veux un agent qui
 * analyse mes emails et crée des tickets Jira ») ; le LLM propose une
 * configuration d'agent STRUCTURÉE (champs du vrai AgentRecord) que
 * l'utilisateur peut accepter ou modifier dans le Builder avant création.
 */

const ProposalSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().min(10).max(500),
  type: z.enum(AGENT_TYPES),
  typeLabel: z.string().trim().min(1).max(80).optional(),
  skills: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
  systemPrompt: z.string().trim().min(30).max(8000),
  persona: z
    .object({
      tone: z.enum(AGENT_TONES).default("professionnel"),
      verbosity: z.enum(AGENT_VERBOSITY_LEVELS).default("equilibre"),
      language: z.string().trim().min(2).max(30).default("Français"),
    })
    .default({ tone: "professionnel", verbosity: "equilibre", language: "Français" }),
  modelStrategy: z.enum(["automatic", "fixed"]).default("automatic"),
  preferredProvider: z.string().trim().max(60).optional(),
  preferredModel: z.string().trim().max(160).optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  tools: z.array(z.string().trim().max(160)).max(20).default([]),
  webResearchEnabled: z.boolean().default(true),
  codeExecutionEnabled: z.boolean().default(false),
  documentGenerationEnabled: z.boolean().default(true),
  authorizationMode: z.enum(["always_ask", "ask_if_needed", "auto_allow"]).default("always_ask"),
  reasoning: z.string().trim().max(1200).default(""),
});

const BODY_SCHEMA = z.object({
  description: z.string().trim().min(15).max(2000),
});

const SYSTEM_PROMPT = `Tu es l'architecte d'agents IA de Gen3ia. À partir d'une description en langage naturel, tu proposes la configuration d'un agent IA réel. Réponds UNIQUEMENT avec un objet JSON valide respectant le schéma demandé. Le champ systemPrompt doit être une charte professionnelle complète en français : identité, mission, conduite (structure des réponses), périmètre (ce que l'agent fait/ne fait pas), et rappel des règles de sécurité Gen3ia (jamais de secrets, actions sensibles soumis à validation humaine).`;

function buildUserPrompt(description: string): string {
  return `Description de l'agent souhaité par l'utilisateur :
"""${description}"""

Génère la configuration JSON de cet agent avec EXACTEMENT ces clés :
{
  "name": string (2-80 car., mémorable, en français),
  "description": string (10-500 car., une phrase claire),
  "type": "universal" | "code" | "content" | "research" | "automation",
  "typeLabel": string (libellé métier court, optionnel),
  "skills": string[] (3-8 compétences opérationnelles courtes),
  "systemPrompt": string (charte professionnelle complète en français, 30-8000 car.),
  "persona": { "tone": "professionnel"|"convivial"|"direct"|"inspirant"|"pedagogue", "verbosity": "concis"|"equilibre"|"detaille", "language": string },
  "modelStrategy": "automatic" | "fixed",
  "preferredProvider": string (optionnel, seulement si le besoin le justifie),
  "preferredModel": string (optionnel),
  "temperature": number (0-2, 0.3 pour analytique, 0.7 équilibré, 1.0+ créatif),
  "tools": string[] (outils Gen3ia pertinents parmi : web.search, artifact.create, file.read, file.create, knowledge.search, memory.read, memory.write, code.execute, composio.execute, mcp.call),
  "webResearchEnabled": boolean,
  "codeExecutionEnabled": boolean,
  "documentGenerationEnabled": boolean,
  "authorizationMode": "always_ask" | "ask_if_needed" | "auto_allow",
  "reasoning": string (1-3 phrases expliquant tes choix, en français)
}

Règles : type "code" uniquement si l'agent doit exécuter du code ; "research" pour la veille/analyse documentaire ; "automation" pour les tâches récurrentes outillées ; "content" pour la rédaction ; sinon "universal". Tools restreint au strict nécessaire. Auto-évalue authorizationMode : "always_ask" par défaut, "ask_if_needed" si l'agent est principalement analytique.`;
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`agent-generate:${user.uid}`, { limit: 20, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Limite de générations atteinte, réessayez plus tard.", requestId }, { status: 429 });

    const body = BODY_SCHEMA.parse(await request.json());

    const response = await generate({
      task: "reasoning",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(body.description) },
      ],
      requiresStructuredOutput: true,
      maxTokens: 3500,
      metadata: { userId: user.uid },
    });

    const raw = extractJsonObject(response.text);
    const parsed = ProposalSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "La configuration proposée est incomplète. Reformulez votre demande ou réessayez.", requestId },
        { status: 502 },
      );
    }

    return NextResponse.json({ proposal: parsed.data, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Décrivez l'agent souhaité en 15 à 2000 caractères.", requestId }, { status: 422 });
    }
    return NextResponse.json({ ...errorBody(error, "Génération de la configuration impossible"), requestId }, { status: errorStatus(error) });
  }
}
