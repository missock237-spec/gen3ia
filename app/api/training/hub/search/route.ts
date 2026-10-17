import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimitDistributed } from "@/lib/cache/redis";

import { HUB_PROVIDERS, hubErrorStatus, hubIntegrationStatus, searchHubDatasets } from "@/lib/training/hub";

/**
 * GET /api/training/hub/search?provider=huggingface|kaggle&q=…&limit=…
 * Recherche RÉELLE sur le hub demandé (API publique Hugging Face / Kaggle).
 * Aucun résultat n'est fabriqué : une panne du hub remonte en erreur lisible.
 */
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const limit = await rateLimitDistributed(`training:hub-search:${user.uid}`, {
      limit: 30,
      windowMs: 60_000,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Trop de recherches : patientez un instant.", requestId },
        { status: 429, headers: { "x-request-id": requestId } },
      );
    }

    const query = new URL(request.url).searchParams;
    const parsed = z
      .object({
        provider: z.enum(HUB_PROVIDERS),
        q: z.string().min(1).max(120),
        limit: z.coerce.number().int().min(1).max(20).default(12),
      })
      .safeParse({
        provider: query.get("provider") ?? "",
        q: query.get("q") ?? "",
        limit: query.get("limit") ?? undefined,
      });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Paramètres de recherche invalides (provider, q, limit).", requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }

    const datasets = await searchHubDatasets(parsed.data.provider, parsed.data.q, parsed.data.limit);
    return NextResponse.json(
      { datasets, integrations: hubIntegrationStatus(), requestId },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Recherche sur le hub indisponible."), requestId },
      { status: errorStatus(error, hubErrorStatus(error)), headers: { "x-request-id": requestId } },
    );
  }
}
