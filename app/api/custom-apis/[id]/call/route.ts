import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { executeCustomApiCall, CustomApiError } from "@/lib/integrations/custom-apis/client";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

const CallSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  path: z.string().trim().max(500).default(""),
  query: z
    .record(z.string().min(1).max(200), z.string().max(2000))
    .refine((value) => Object.keys(value).length <= 20, "20 paramètres maximum")
    .optional(),
  headers: z
    .record(z.string().min(1).max(200), z.string().max(2000))
    .refine((value) => Object.keys(value).length <= 10, "10 en-têtes maximum")
    .optional(),
  body: z.union([z.string().max(100_000), z.record(z.string(), z.unknown())]).optional(),
});

/**
 * Appel RÉEL d'une API personnelle (test depuis l'UI ou usage direct).
 * La requête HTTP part du serveur avec l'authentification enregistrée et la
 * réponse brute de l'API est restituée — statut et corps réels, jamais masqués.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`custom-apis-call:${user.uid}:${clientIp(request)}`, {
      limit: 30,
      windowMs: 60_000,
    });
    if (!limit.allowed) return NextResponse.json({ error: "Trop d'appels. Réessayez dans un instant." }, { status: 429 });

    const { id } = await params;
    const body = CallSchema.parse(await request.json().catch(() => ({})));
    const result = await executeCustomApiCall(user.uid, { ...body, apiId: id });
    return NextResponse.json({ result });
  } catch (error) {
    if (error instanceof CustomApiError) {
      return NextResponse.json(
        { error: error.message, ...(error.detail?.status ? { status: error.detail.status } : {}) },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Appel impossible" }, { status: errorStatus(error, 400) });
  }
}
