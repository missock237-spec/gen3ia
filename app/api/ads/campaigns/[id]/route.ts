import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/security/admin-access";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { campaignMetrics, deleteCampaign, getCampaign, updateCampaign } from "@/lib/ads/campaigns";

/**
 * SYSTÈME PUBLICITAIRE PRO — campagne individuelle (admin uniquement).
 * GET    : détail + métriques réelles (impressions, clics, CTR, dépense).
 * PATCH  : mise à jour (statut, budgets, ciblage, créas…).
 * DELETE : suppression définitive.
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
  objective: z.enum(["traffic", "conversions", "awareness", "engagement"]).optional(),
  status: z.enum(["draft", "active", "paused", "completed"]).optional(),
  dailyBudgetMinor: z.number().finite().min(0).optional(),
  totalBudgetMinor: z.number().finite().min(0).optional(),
  currency: z.string().trim().max(8).optional(),
  bidStrategy: z.enum(["maximize_reach", "maximize_ctr", "balanced"]).optional(),
  frequencyCapPerDay: z.number().int().min(1).max(100).optional(),
  targeting: z.object({
    placements: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
    languages: z.array(z.string().trim().min(1).max(12)).max(12).optional(),
    keywords: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
    devices: z.array(z.enum(["mobile", "desktop", "tablet"])).max(3).optional(),
  }).optional(),
  creatives: z.array(CreativeSchema).min(1).max(10).optional(),
  startsAtMs: z.number().finite().optional(),
  endsAtMs: z.number().finite().optional(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin(request);
    const { id } = await params;
    const campaign = await getCampaign(admin.uid, id);
    const metrics = await campaignMetrics(id).catch(() => null);
    return NextResponse.json({ campaign, metrics });
  } catch (error) {
    return NextResponse.json({ ...errorBody(error, "Campagne introuvable") }, { status: errorStatus(error) });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin(request);
    const { id } = await params;
    const parsed = Patch.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Mise à jour invalide", issues: parsed.error.flatten() }, { status: 400 });
    }
    const campaign = await updateCampaign(admin.uid, id, parsed.data);
    return NextResponse.json({ campaign });
  } catch (error) {
    return NextResponse.json({ ...errorBody(error, "Mise à jour impossible") }, { status: errorStatus(error) });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin(request);
    const { id } = await params;
    await deleteCampaign(admin.uid, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ...errorBody(error, "Suppression impossible") }, { status: errorStatus(error) });
  }
}
