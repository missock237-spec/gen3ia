import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/security/admin-access";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { createCampaign, listCampaigns, campaignMetrics } from "@/lib/ads/campaigns";

/**
 * SYSTÈME PUBLICITAIRE PRO — campagnes (admin uniquement).
 * GET  : liste des campagnes (+ métriques réelles agrégées).
 * POST : création d'une campagne (objectif, budgets, ciblage, créas…).
 */

export const runtime = "nodejs";

const CreativeSchema = z.object({
  headline: z.string().trim().min(3).max(160),
  description: z.string().trim().max(500).optional(),
  targetUrl: z.string().url().max(2000),
  imageUrl: z.string().url().max(2000).optional(),
  ctaLabel: z.string().trim().max(60).optional(),
});

const CampaignInput = z.object({
  name: z.string().trim().min(3).max(120),
  objective: z.enum(["traffic", "conversions", "awareness", "engagement"]),
  status: z.enum(["draft", "active", "paused", "completed"]).default("draft"),
  dailyBudgetMinor: z.number().finite().min(0),
  totalBudgetMinor: z.number().finite().min(0).optional(),
  currency: z.string().trim().max(8).default("XAF"),
  bidStrategy: z.enum(["maximize_reach", "maximize_ctr", "balanced"]).default("balanced"),
  frequencyCapPerDay: z.number().int().min(1).max(100).optional(),
  targeting: z.object({
    placements: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
    languages: z.array(z.string().trim().min(1).max(12)).max(12).optional(),
    keywords: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
    devices: z.array(z.enum(["mobile", "desktop", "tablet"])).max(3).optional(),
  }),
  creatives: z.array(CreativeSchema).min(1).max(10),
  startsAtMs: z.number().finite().optional(),
  endsAtMs: z.number().finite().optional(),
});

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
    const campaigns = await listCampaigns();
    const withMetrics = await Promise.all(
      campaigns.map(async (campaign) => ({
        ...campaign,
        metrics: await campaignMetrics(campaign.id).catch(() => null),
      })),
    );
    return NextResponse.json({ campaigns: withMetrics });
  } catch (error) {
    return NextResponse.json({ ...errorBody(error, "Campagnes indisponibles") }, { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const admin = await requireAdmin(request);
    const parsed = CampaignInput.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Campagne invalide", issues: parsed.error.flatten() }, { status: 400 });
    }
    const campaign = await createCampaign({ ...parsed.data, ownerId: admin.uid });
    return NextResponse.json({ campaign }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ ...errorBody(error, "Création de campagne impossible") }, { status: errorStatus(error) });
  }
}
