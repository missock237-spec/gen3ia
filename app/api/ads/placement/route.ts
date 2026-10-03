import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { choosePlatformAd, listEligiblePlatformAds, recordPlatformAdEvent } from "@/lib/ads/platform-placement";
import { errorStatus } from "@/lib/security/http-errors";

const Query = z.object({
  placement: z.string().trim().min(1).max(80).default("settings"),
  /** mode=all : renvoie TOUTES les annonces éligibles (galerie de l'espace publicitaire). */
  mode: z.enum(["single", "all"]).default("single"),
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
    const url = new URL(request.url);
    const parsed = Query.safeParse({
      placement: url.searchParams.get("placement") ?? "settings",
      mode: url.searchParams.get("mode") ?? "single",
    });
    if (!parsed.success) return NextResponse.json({ error: "Placement invalide." }, { status: 400 });
    const { placement, mode } = parsed.data;
    // Mots-clés du contexte de diffusion (ciblage sémantique des campagnes) :
    // fournis par la surface d'affichage via ?context=mot1,mot2 (10 max).
    const keywords = (url.searchParams.get("context") ?? "")
      .split(",")
      .map((keyword) => keyword.trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 10);

    if (mode === "all") {
      const ads = await listEligiblePlatformAds(placement);
      const list = ads.length > 0 ? ads : [await choosePlatformAd(placement, { userId: user.uid, keywords })];
      await Promise.all(
        list.map((ad) =>
          recordPlatformAdEvent({ adId: ad.id, placement, type: "impression", userId: user.uid }).catch(() => undefined),
        ),
      );
      return NextResponse.json({ ads: list }, { headers: { "cache-control": "no-store" } });
    }

    const ad = await choosePlatformAd(placement, { userId: user.uid, keywords });
    void recordPlatformAdEvent({
      adId: ad.id,
      placement,
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
      { status: errorStatus(error, 401) },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    // ANTI-FRAUDE : débit borné par utilisateur (les doublons exacts sont de
    // toute façon écrasés par le doc-id déterministe côté enregistrement).
    const limit = await enforceRateLimit(`ads-event:${user.uid}`, { limit: 60, windowMs: 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Trop d'événements publicitaires." }, { status: 429 });
    }
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
