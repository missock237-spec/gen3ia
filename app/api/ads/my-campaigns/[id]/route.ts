import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { deleteUserCampaign, updateUserCampaign, MAX_USER_CREATIVES, MAX_USER_PLACEMENTS } from "@/lib/ads/user-campaigns";

/**
 * GEN ADS — campagne utilisateur individuelle (self-service).
 *
 * PATCH  : mise à jour (statut activer/pause, budgets, ciblage, créas…).
 *         La diffusion est resynchronisée : une campagne mise en pause cesse
 *         immédiatement d'apparaître dans le projet.
 * DELETE : suppression définitive de la campagne ET de son inventaire.
 */

export const runtime = "nodejs";

const CreativeSchema = z.object({
  headline: z.string().trim().min(3).max(160),
  description: z.string().trim().max(500).optional(),
  targetUrl: z.string().url().max(2000),
  imageUrl: z.string().url().max(2000).optional(),
  ctaLabel: z.string().trim().max(60).optional(),
});

const Patch = z.object({
  name: z.string().trim().min(3).max(120).optional(),
  advertiserName: z.string().trim().min(2).max(120).optional(),
  objective: z.enum(["traffic", "conversions", "awareness", "engagement"]).optional(),
  status: z.enum(["draft", "active", "paused", "completed"]).optional(),
  dailyBudgetMinor: z.number().finite().min(0).optional(),
  totalBudgetMinor: z.number().finite().min(0).optional(),
  currency: z.string().trim().max(8).optional(),
  bidStrategy: z.enum(["maximize_reach", "maximize_ctr", "balanced"]).optional(),
  frequencyCapPerDay: z.number().int().min(1).max(100).optional(),
  targeting: z.object({
    placements: z.array(z.string().trim().min(1).max(80)).min(1).max(MAX_USER_PLACEMENTS),
    languages: z.array(z.string().trim().min(1).max(12)).max(12).optional(),
    keywords: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
    devices: z.array(z.enum(["mobile", "desktop", "tablet"])).max(3).optional(),
  }).optional(),
  creatives: z.array(CreativeSchema).min(1).max(MAX_USER_CREATIVES).optional(),
  startsAtMs: z.number().finite().optional(),
  endsAtMs: z.number().finite().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const limit = await enforceRateLimit(`ads-my-campaign:${user.uid}`, { limit: 20, windowMs: 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Trop de requêtes. Réessayez dans un instant." }, { status: 429 });
    }
    const parsed = Patch.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Mise à jour invalide", issues: parsed.error.flatten() }, { status: 400 });
    }
    const { campaign, publishedAds } = await updateUserCampaign(user.uid, id, parsed.data);
    return NextResponse.json({ campaign, publishedAds });
  } catch (error) {
    return NextResponse.json({ ...errorBody(error, "Mise à jour impossible") }, { status: errorStatus(error) });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const limit = await enforceRateLimit(`ads-my-campaign:${user.uid}`, { limit: 20, windowMs: 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Trop de requêtes. Réessayez dans un instant." }, { status: 429 });
    }
    await deleteUserCampaign(user.uid, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ...errorBody(error, "Suppression impossible") }, { status: errorStatus(error) });
  }
}
