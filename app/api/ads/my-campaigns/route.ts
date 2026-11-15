import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import {
  AD_PLACEMENTS,
  MAX_USER_CREATIVES,
  MAX_USER_PLACEMENTS,
  createUserCampaign,
  listUserCampaigns,
} from "@/lib/ads/user-campaigns";

/**
 * GEN ADS — campagnes publicitaires de l'UTILISATEUR (self-service).
 *
 * Demande utilisateur : « dans paramètres gen ads les utilisateurs doivent
 * pouvoir mettre en avant leur pub dans le projet ».
 *
 * GET  : liste des campagnes de l'utilisateur (+ métriques réelles) et
 *        catalogue des emplacements où elles peuvent être mises en avant.
 * POST : création d'une campagne — si elle est ACTIVE, elle est publiée
 *        immédiatement dans l'inventaire de diffusion du projet.
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
  advertiserName: z.string().trim().min(2).max(120).optional(),
  objective: z.enum(["traffic", "conversions", "awareness", "engagement"]),
  status: z.enum(["draft", "active", "paused", "completed"]).default("draft"),
  dailyBudgetMinor: z.number().finite().min(0),
  totalBudgetMinor: z.number().finite().min(0).optional(),
  currency: z.string().trim().max(8).default("XAF"),
  bidStrategy: z.enum(["maximize_reach", "maximize_ctr", "balanced"]).default("balanced"),
  frequencyCapPerDay: z.number().int().min(1).max(100).optional(),
  targeting: z.object({
    placements: z.array(z.string().trim().min(1).max(80)).min(1).max(MAX_USER_PLACEMENTS),
    languages: z.array(z.string().trim().min(1).max(12)).max(12).optional(),
    keywords: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
    devices: z.array(z.enum(["mobile", "desktop", "tablet"])).max(3).optional(),
  }),
  creatives: z.array(CreativeSchema).min(1).max(MAX_USER_CREATIVES),
  startsAtMs: z.number().finite().optional(),
  endsAtMs: z.number().finite().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const campaigns = await listUserCampaigns(user.uid);
    return NextResponse.json(
      { campaigns, placements: AD_PLACEMENTS },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json({ ...errorBody(error, "Campagnes indisponibles") }, { status: errorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    // Anti-abus : création de campagne bornée par utilisateur.
    const limit = await enforceRateLimit(`ads-my-campaigns:${user.uid}`, { limit: 10, windowMs: 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Trop de requêtes. Réessayez dans un instant." }, { status: 429 });
    }
    const parsed = CampaignInput.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Campagne invalide", issues: parsed.error.flatten() }, { status: 400 });
    }
    const { campaign, publishedAds } = await createUserCampaign(user.uid, parsed.data);
    return NextResponse.json({ campaign, publishedAds }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ ...errorBody(error, "Création de campagne impossible") }, { status: errorStatus(error) });
  }
}
