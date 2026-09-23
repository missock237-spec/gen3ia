import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { getAgentForOwner } from "@/lib/agents/repository";
import { createCommercialConfig, listCommercialConfigs } from "@/lib/agents/commercial";

export const runtime = "nodejs";

const FaqSchema = z.object({ question: z.string().trim().min(1).max(500), answer: z.string().trim().min(1).max(2_000) });

const CreateSchema = z.object({
  agentId: z.string().trim().min(1).max(128),
  companyName: z.string().trim().min(2).max(160),
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
});

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`commercial-list:${user.uid}`, { limit: 60, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de requêtes." }, { status: 429 });
    const configs = await listCommercialConfigs(user.uid);
    return NextResponse.json({ configs });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Chargement impossible."), { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limit = await enforceRateLimit(`commercial-create:${user.uid}`, { limit: 20, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Trop de créations rapprochées." }, { status: 429 });

    const parsed = CreateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Données de configuration invalides.", issues: parsed.error.flatten() }, { status: 400 });
    }

    // L'agent doit appartenir à l'utilisateur : impossible d'exposer un
    // agent tiers via un lien client.
    const agent = await getAgentForOwner(user.uid, parsed.data.agentId);
    if (!agent) return NextResponse.json({ error: "Agent introuvable ou non autorisé." }, { status: 403 });

    const config = await createCommercialConfig(user.uid, parsed.data);
    return NextResponse.json({ config });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Création impossible."), { status: errorStatus(error) });
  }
}
