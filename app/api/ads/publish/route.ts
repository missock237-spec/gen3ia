import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { getWallet, assertWalletActive, reserveFunds, settleReservation, releaseReservation } from "@/lib/billing/wallet";
import { estimateUsageCharge } from "@/lib/billing/media-meter";
import { claimActionExecution, completeAction, failAction } from "@/lib/agents/action-approvals";
import { publishAd } from "@/lib/ads/ad-publisher";

const Schema = z.object({ approvalId: z.string().min(1).max(256) });
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const guard = await protectRoute(request); if (!guard.ok) return guard.response;
  let approvalId = "";
  try {
    ({ approvalId } = Schema.parse(await request.json()));
    const wallet = await getWallet(guard.context.userId); assertWalletActive(wallet);
    const approval = await claimActionExecution(guard.context.userId, approvalId);
    if (approval.toolSlug !== "ads.publish") throw new Error("Approval is not an Ads publishing action.");
    const args = approval.arguments as Record<string, unknown>;
    const provider = args.provider;
    if (provider !== "google_ads" && provider !== "meta_ads" && provider !== "tiktok_ads") throw new Error("Unsupported Ads provider.");
    const estimate = estimateUsageCharge({ kind: "ads_publish", quantity: 1 });
    const reserveMinor = Math.max(1, estimate.reserveMinor);
    const reservationReference = `ads_${approval.executionId}_${approval.id}`;
    await reserveFunds({ userId: guard.context.userId, amountMinor: reserveMinor, reference: reservationReference, metadata: { provider, approvalId } });
    try {
      const result = await publishAd({ userId: guard.context.userId, provider, name: String(args.name), accountId: String(args.accountId), destinationUrl: String(args.destinationUrl), primaryText: String(args.primaryText), headline: String(args.headline), imageUrl: typeof args.imageUrl === "string" ? args.imageUrl : undefined, campaignId: typeof args.campaignId === "string" ? args.campaignId : undefined, adGroupId: typeof args.adGroupId === "string" ? args.adGroupId : undefined, creativeId: typeof args.creativeId === "string" ? args.creativeId : undefined, dailyBudgetMinor: typeof args.dailyBudgetMinor === "number" ? args.dailyBudgetMinor : undefined });
      await settleReservation({ userId: guard.context.userId, reference: reservationReference, reservedMinor: reserveMinor, actualChargeMinor: estimate.chargeMinor, metadata: { provider, approvalId } });
      await completeAction(guard.context.userId, approvalId, { result, chargeMinor: estimate.chargeMinor });
      return NextResponse.json({ ok: true, result, billing: { chargeMinor: estimate.chargeMinor } });
    } catch (error) {
      await releaseReservation({ userId: guard.context.userId, reference: reservationReference, reservedMinor: reserveMinor }).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ads publishing failed";
    if (approvalId) await failAction(guard.context.userId, approvalId, error).catch(() => undefined);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
