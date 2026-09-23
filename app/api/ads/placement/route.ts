import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { choosePlatformAd, recordPlatformAdEvent } from "@/lib/ads/platform-placement";
import { errorStatus } from "@/lib/security/http-errors";

const Query = z.object({
  placement: z.string().trim().min(1).max(80).default("settings"),
});

const EventSchema = z.object({
  action: z.enum(["impression", "click"]),
  adId: z.string().trim().min(1).max(160),
  placement: z.string().trim().min(1).max(80).default("settings"),
});

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = Query.safeParse({
      placement: new URL(request.url).searchParams.get("placement") ?? "settings",
    });
    if (!parsed.success) return NextResponse.json({ error: "Placement invalide." }, { status: 400 });

    const ad = await choosePlatformAd(parsed.data.placement);
    void recordPlatformAdEvent({
      adId: ad.id,
      placement: parsed.data.placement,
      type: "impression",
      userId: user.uid,
    }).catch(() => undefined);

    return NextResponse.json(
      { ad },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Publicité indisponible." },
      { status: 401 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const parsed = EventSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Événement publicitaire invalide." }, { status: 400 });

    await recordPlatformAdEvent({
      adId: parsed.data.adId,
      placement: parsed.data.placement,
      type: parsed.data.action,
      userId: user.uid,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Enregistrement impossible." },
      { status: errorStatus(error, 400) },
    );
  }
}
