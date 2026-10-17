import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";

import { HUB_PROVIDERS, hubErrorStatus, hubIntegrationStatus, inspectHubDataset } from "@/lib/training/hub";

/**
 * GET /api/training/hub/inspect?provider=…&ref=proprietaire/jeu
 * Inspection RÉELLE : fichiers, splits déclarés, licence et échantillon de
 * lignes remontés par l'API du hub. Rien n'est inventé — ce que le hub
 * n'expose pas est null et expliqué dans `notes`.
 */
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const limit = await rateLimitDistributed(`training:hub-inspect:${user.uid}`, {
      limit: 30,
      windowMs: 60_000,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Trop d'inspections : patientez un instant.", requestId },
        { status: 429, headers: { "x-request-id": requestId } },
      );
    }

    const query = new URL(request.url).searchParams;
    const parsed = z
      .object({
        provider: z.enum(HUB_PROVIDERS),
        ref: z.string().min(3).max(260),
      })
      .safeParse({
        provider: query.get("provider") ?? "",
        ref: query.get("ref") ?? "",
      });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Paramètres d'inspection invalides (provider, ref).", requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }

    const detail = await inspectHubDataset(parsed.data.provider, parsed.data.ref);
    return NextResponse.json(
      { dataset: detail, integrations: hubIntegrationStatus(), requestId },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Inspection du jeu de données indisponible."), requestId },
      { status: errorStatus(error, hubErrorStatus(error)), headers: { "x-request-id": requestId } },
    );
  }
}
