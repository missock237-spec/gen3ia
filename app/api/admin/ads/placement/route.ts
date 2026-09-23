import { NextRequest, NextResponse } from "next/server";
import { errorStatus } from "@/lib/security/http-errors";
import { z } from "zod";

import { requireAdmin } from "@/lib/security/admin-access";
import {  createPlatformAd,
  deletePlatformAd,
  listPlatformAds,
  updatePlatformAd,
  type PlatformAdInput,
} from "@/lib/ads/platform-placement";

const Input = z.object({
  placement: z.string().trim().min(1).max(80),
  format: z.enum(["image", "video", "link"]),
  title: z.string().trim().min(1).max(160),
  advertiser: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  text: z.string().trim().max(2000).optional(),
  imageUrl: z.string().url().max(2000).optional(),
  videoUrl: z.string().url().max(2000).optional(),
  targetUrl: z.string().url().max(2000),
  ctaLabel: z.string().trim().max(60).optional(),
  enabled: z.boolean().default(true),
  startsAtMs: z.number().finite().optional(),
  endsAtMs: z.number().finite().optional(),
  priority: z.number().finite().min(-1000).max(1000).default(0),
});

const Patch = Input.partial();

async function guardAdmin(request: NextRequest) {
  try {
    return { user: await requireAdmin(request) };
  } catch (error) {
    return {
      error: NextResponse.json(
        { error: error instanceof Error ? error.message : "Accès administrateur requis." },
        { status: errorStatus(error, 403) },
      ),
    };
  }
}

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const guard = await guardAdmin(request);
  if ("error" in guard) return guard.error;
  try {
    const placement = new URL(request.url).searchParams.get("placement")?.trim() || undefined;
    return NextResponse.json({ ads: await listPlatformAds(placement) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Impossible de charger les publicités." }, { status: errorStatus(error, 500) });
  }
}

export async function POST(request: NextRequest) {
  const guard = await guardAdmin(request);
  if ("error" in guard) return guard.error;
  const parsed = Input.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Données publicitaires invalides." }, { status: 400 });
  try {
    const ad = await createPlatformAd(parsed.data as PlatformAdInput);
    return NextResponse.json({ ad }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Création impossible." }, { status: errorStatus(error, 400) });
  }
}

export async function PATCH(request: NextRequest) {
  const guard = await guardAdmin(request);
  if ("error" in guard) return guard.error;
  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "Paramètre id requis." }, { status: 400 });
  const parsed = Patch.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Modification publicitaire invalide." }, { status: 400 });
  try {
    const ad = await updatePlatformAd(id, parsed.data as Partial<PlatformAdInput>);
    return NextResponse.json({ ad });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Modification impossible." }, { status: errorStatus(error, 400) });
  }
}

export async function DELETE(request: NextRequest) {
  const guard = await guardAdmin(request);
  if ("error" in guard) return guard.error;
  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "Paramètre id requis." }, { status: 400 });
  try {
    await deletePlatformAd(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Suppression impossible." }, { status: errorStatus(error, 400) });
  }
}
