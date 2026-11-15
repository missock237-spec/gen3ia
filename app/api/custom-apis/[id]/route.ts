import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import {
  deleteCustomApi,
  getCustomApi,
  updateCustomApi,
  type CustomApiRecord,
} from "@/lib/integrations/custom-apis/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function publicView(record: CustomApiRecord) {
  const { authValue: _secret, ...rest } = record;
  return { ...rest, hasSecret: Boolean(record.authValue) };
}

const PatchSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  baseUrl: z.string().trim().min(8).max(500).optional(),
  description: z.string().trim().max(600).optional(),
  authType: z.enum(["none", "bearer", "header", "query"]).optional(),
  authHeader: z.string().trim().max(80).optional(),
  authValue: z.string().trim().max(2000).optional(),
  queryKey: z.string().trim().max(80).optional(),
  enabled: z.boolean().optional(),
});

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`custom-apis:${user.uid}:${clientIp(request)}`, { limit: 60, windowMs: 60_000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes." }, { status: 429 });
    const { id } = await params;
    const record = await getCustomApi(user.uid, id);
    if (!record) return NextResponse.json({ error: "API introuvable." }, { status: 404 });
    return NextResponse.json({ api: publicView(record) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Erreur" }, { status: errorStatus(error, 400) });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`custom-apis-patch:${user.uid}:${clientIp(request)}`, { limit: 40, windowMs: 60_000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes." }, { status: 429 });
    const { id } = await params;
    const patch = PatchSchema.parse(await request.json());
    const updated = await updateCustomApi(user.uid, id, patch);
    if (!updated) return NextResponse.json({ error: "API introuvable." }, { status: 404 });
    return NextResponse.json({ api: publicView(updated) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Mise à jour impossible" }, { status: errorStatus(error, 400) });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`custom-apis-delete:${user.uid}:${clientIp(request)}`, { limit: 20, windowMs: 60_000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes." }, { status: 429 });
    const { id } = await params;
    const deleted = await deleteCustomApi(user.uid, id);
    if (!deleted) return NextResponse.json({ error: "API introuvable." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Suppression impossible" }, { status: errorStatus(error, 400) });
  }
}
