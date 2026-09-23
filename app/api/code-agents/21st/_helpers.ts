import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { requireCodeAgentOwner } from "@/lib/agents/code-agent-guard";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { TwentyFirstError } from "@/lib/integrations/twentyfirst/client";

/** Utilitaires communs aux routes 21st.dev (fichier prive, non-route). */

export interface RouteGuard {
  userId: string;
}

/** Gate code-agent + limite de debit + parsing JSON. Retourne soit les donnees soit une reponse prete. */
export async function guard21st(
  request: NextRequest,
  bucket: string,
  limitPerMinute: number,
): Promise<{ ok: RouteGuard } | { response: NextResponse }> {
  const guard = await requireCodeAgentOwner(request);
  if ("forbidden" in guard) return { response: guard.forbidden };

  const limit = await enforceRateLimit(`21st-${bucket}:${guard.user.uid}`, { limit: limitPerMinute, windowMs: 60 * 1000 });
  if (!limit.allowed) {
    return {
      response: NextResponse.json(
        { error: "Trop d'appels rapproches, patientez un instant.", code: "RATE_LIMITED" },
        { status: 429 },
      ),
    };
  }
  return { ok: { userId: guard.user.uid } };
}

export const SearchSchema = z.object({
  query: z.string().trim().min(2).max(200),
  limit: z.number().int().min(1).max(16).default(8),
});

export const IdSchema = z.object({
  id: z.string().trim().regex(/^\d{1,10}$/, "Identifiant invalide"),
});

export function twentyFirstErrorResponse(error: unknown): NextResponse {
  if (error instanceof TwentyFirstError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Service 21st.dev indisponible" },
    { status: 500 },
  );
}

export { NextResponse, NextRequest, randomUUID, z };
