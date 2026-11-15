import { NextResponse } from "next/server";

import { authenticateDeveloper } from "@/lib/extensions/developer-keys";
import { extensionApiError } from "@/lib/extensions/api";
import { getDeveloperRevenueSummary } from "@/lib/extensions/repository";

/**
 * GET /api/developer/revenue — Developer Studio revenue panel:
 * gross, platform fee and net earnings aggregated over recent entries.
 */
export async function GET(request: Request) {
  try {
    const developer = await authenticateDeveloper(request);
    const summary = await getDeveloperRevenueSummary(developer.userId);
    return NextResponse.json({
      developer: { userId: developer.userId },
      revenue: {
        ...summary,
        platformFeeBps: Number(process.env.EXTENSION_PLATFORM_FEE_BPS ?? 2_000),
        note: "Les revenus nets sont cumulés après commission de plateforme. Les paiements Chariow sont vérifiés par webhook signé — le frontend n'est jamais une preuve de paiement.",
      },
    });
  } catch (error) {
    return extensionApiError(error);
  }
}
