import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import {
  createCustomApi,
  listCustomApis,
  type CustomApiRecord,
} from "@/lib/integrations/custom-apis/repository";
import { assertPublicHttpUrl } from "@/lib/security/url-safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * API personnelles de l'utilisateur — CRUD réel (Firestore).
 * Le secret (authValue) ne quitte JAMAIS le serveur : la liste publique
 * n'expose que son type d'authentification.
 */

function publicView(record: CustomApiRecord) {
  const { authValue: _secret, ...rest } = record;
  return { ...rest, hasSecret: Boolean(record.authValue) };
}

const CreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  baseUrl: z.string().trim().min(8).max(500),
  description: z.string().trim().max(600).optional(),
  authType: z.enum(["none", "bearer", "header", "query"]).default("none"),
  authHeader: z.string().trim().max(80).optional(),
  authValue: z.string().trim().max(2000).optional(),
  queryKey: z.string().trim().max(80).optional(),
  enabled: z.boolean().default(true),
});

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`custom-apis:${user.uid}:${clientIp(request)}`, { limit: 60, windowMs: 60_000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes." }, { status: 429 });
    const apis = await listCustomApis(user.uid);
    return NextResponse.json({ apis: apis.map(publicView) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erreur" }, { status: errorStatus(error, 400) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`custom-apis-create:${user.uid}:${clientIp(request)}`, { limit: 20, windowMs: 60_000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes." }, { status: 429 });

    const body = CreateSchema.parse(await request.json());
    await assertPublicHttpUrl(body.baseUrl);

    const record = await createCustomApi({ userId: user.uid, ...body, source: "form" });
    return NextResponse.json({ api: publicView(record) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Création impossible" }, { status: errorStatus(error, 400) });
  }
}
