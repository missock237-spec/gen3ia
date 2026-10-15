import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { protectRoute } from "@/lib/security/route-guard";
import { changeStoragePlan, describeStorageOffer, getStorageProfile } from "@/lib/storage/plans";
import { getUserStorageUsage } from "@/lib/storage/permanent-user-storage";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ChangePlanSchema = z.object({ planId: z.enum(["free", "storage-pro5", "storage-pro10"]) });

/**
 * Profil de stockage de l'utilisateur : plan courant, quota, usage et offres
 * disponibles (Task 150). Le renouvellement mensuel est résolu « lazy » ici —
 * une échéance passée avec solde suffisant est renouvelée, sans solde elle
 * retombe sur le plan free (fichiers conservés).
 */
export async function GET(request: NextRequest) {
  const guard = await protectRoute(request, { key: "storage-plan", rateLimit: { limit: 60, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const [profile, usage, offer] = await Promise.all([
      getStorageProfile(guard.context.userId),
      getUserStorageUsage(guard.context.userId),
      describeStorageOffer(guard.context.userId),
    ]);
    return NextResponse.json(
      { profile, usage, plans: offer.plans, wallet: offer.wallet },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(errorBody(error, "Could not load storage plan"), { status: errorStatus(error, 400) });
  }
}

/** Changement de plan : upgrade facturé immédiatement, downgrade gratuit. */
export async function POST(request: NextRequest) {
  const guard = await protectRoute(request, { key: "storage-plan-change", rateLimit: { limit: 12, windowMs: 5 * 60 * 1000 } });
  if (!guard.ok) return guard.response;
  try {
    const input = ChangePlanSchema.parse(await request.json());
    const profile = await changeStoragePlan(guard.context.userId, input.planId);
    const usage = await getUserStorageUsage(guard.context.userId);
    return NextResponse.json({ profile, usage });
  } catch (error) {
    return NextResponse.json(errorBody(error, "Could not change storage plan"), { status: errorStatus(error, 400) });
  }
}
