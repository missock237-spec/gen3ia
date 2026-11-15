import { NextResponse } from "next/server";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { getExtension, listPurchasesByUser } from "@/lib/extensions/repository";

export async function GET(request: Request) {
  try {
    const token = await verifyFirebaseAuth(request);
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 100) : 50;
    const purchases = await listPurchasesByUser(token.uid, limit);
    const enriched = await Promise.all(
      purchases.map(async (purchase) => {
        const extension = await getExtension(purchase.extensionId);
        return {
          ...purchase,
          extension: extension
            ? {
                id: extension.id,
                name: extension.name,
                developerName: extension.developerName,
                latestVersion: extension.latestVersion,
                approvedVersion: extension.approvedVersion,
                pricing: extension.pricing,
              }
            : null,
        };
      }),
    );
    return NextResponse.json({ purchases: enriched });
  } catch {
    return NextResponse.json({ error: "Authentification requise." }, { status: 401 });
  }
}
