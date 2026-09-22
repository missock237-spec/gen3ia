import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { rateLimit } from "@/lib/security/rate-limit";
import {
  deleteCommercialConfig,
  getCommercialConfig,
  listClientChats,
  rotateClientSlug,
  updateCommercialConfig,
} from "@/lib/agents/commercial";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

const FaqSchema = z.object({ question: z.string().trim().min(1).max(500), answer: z.string().trim().min(1).max(2_000) });

const PatchSchema = z.object({
  companyName: z.string().trim().min(2).max(160).optional(),
  sector: z.string().trim().max(200).optional(),
  products: z.array(z.string().trim().min(1).max(400)).max(60).optional(),
  pricing: z.array(z.string().trim().min(1).max(400)).max(60).optional(),
  faq: z.array(FaqSchema).max(40).optional(),
  tone: z.string().trim().max(300).optional(),
  language: z.string().trim().max(20).optional(),
  contactInfo: z.object({
    phone: z.string().trim().max(60).optional(),
    email: z.string().trim().max(160).optional(),
    website: z.string().trim().max(300).optional(),
    address: z.string().trim().max(300).optional(),
  }).optional(),
  openingHours: z.string().trim().max(400).optional(),
  welcomeMessage: z.string().trim().max(800).optional(),
  escalationContact: z.string().trim().max(200).optional(),
  active: z.boolean().optional(),
  rotateSlug: z.literal(true).optional(),
});

export async function GET(request: NextRequest, context: Context) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const limit = rateLimit(`commercial-get:${user.uid}`, { limit: 60, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes." }, { status: 429 });
    const config = await getCommercialConfig(user.uid, id);
    const chats = await listClientChats(user.uid, id, 20);
    return NextResponse.json({ config, chats });
  } catch (error) {
    if (error instanceof Error && /introuvable/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json(errorBody(error, "Chargement impossible."), { status: errorStatus(error) });
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const limit = rateLimit(`commercial-patch:${user.uid}`, { limit: 40, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de mises à jour rapprochées." }, { status: 429 });

    const parsed = PatchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Mise à jour invalide.", issues: parsed.error.flatten() }, { status: 400 });
    }

    const { rotateSlug, ...updates } = parsed.data;
    let config;
    if (rotateSlug) {
      config = await rotateClientSlug(user.uid, id);
    } else {
      config = await updateCommercialConfig(user.uid, id, updates);
    }
    return NextResponse.json({ config });
  } catch (error) {
    if (error instanceof Error && /introuvable/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json(errorBody(error, "Mise à jour impossible."), { status: errorStatus(error) });
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const limit = rateLimit(`commercial-delete:${user.uid}`, { limit: 20, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes." }, { status: 429 });
    const deleted = await deleteCommercialConfig(user.uid, id);
    if (!deleted) return NextResponse.json({ error: "Configuration introuvable." }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Suppression impossible."), { status: errorStatus(error) });
  }
}
