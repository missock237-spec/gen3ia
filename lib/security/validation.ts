import { z } from "zod";
import { NextResponse } from "next/server";

/**
 * SCHÉMAS DE VALIDATION D'ENTRÉE (intentions du commit d489ee4, adaptées à
 * l'App Router de Next.js — le middleware Express-style `validateInput`
 * d'origine ne compilait pas : NextFunction/Response inexistants ici).
 *
 * Usage App Router :
 *   const parsed = await parseValidatedBody(createAgentSchema, request);
 *   if (!parsed.ok) return parsed.response;      // 400 JSON prêt
 *   const body = parsed.data;                    // typé par le schéma
 */

/** Schéma de validation pour création d'agent. */
export const createAgentSchema = z.object({
  name: z
    .string()
    .min(2, "Le nom doit avoir au moins 2 caractères")
    .max(100, "Le nom ne peut pas dépasser 100 caractères")
    .regex(/^[a-zA-Z0-9\s\-_]+$/, "Caractères spéciaux non autorisés"),
  description: z.string().max(1000).optional(),
  type: z.enum(["assistant", "analyst", "custom"]),
  memoryEnabled: z.boolean().default(true),
  maxTokens: z.number().int().min(100).max(10000).default(2000),
  skills: z.array(z.string().uuid()).max(20).default([]),
});

export type CreateAgentInput = z.infer<typeof createAgentSchema>;

export type ValidatedBody<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

/**
 * Valide le corps JSON d'une requête App Router contre un schéma zod.
 * Retourne soit les données typées, soit une réponse 400 prête à renvoyer
 * (détails d'issues + traceId propagé depuis l'en-tête x-trace-id).
 */
export async function parseValidatedBody<T>(
  schema: z.ZodType<T>,
  request: Request,
): Promise<ValidatedBody<T>> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Corps JSON invalide." }, { status: 400 }),
    };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Validation failed",
          details: result.error.issues,
          traceId: request.headers.get("x-trace-id") ?? undefined,
        },
        { status: 400 },
      ),
    };
  }
  return { ok: true, data: result.data };
}
