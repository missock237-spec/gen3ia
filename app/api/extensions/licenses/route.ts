import { NextResponse } from "next/server";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { adminDb } from "@/lib/firebase/admin";
import { getExtension } from "@/lib/extensions/repository";

export async function GET(request: Request) {
  try {
    const token = await verifyFirebaseAuth(request);
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 100) : 50;

    const snapshot = await adminDb
      .collection("extensionLicenses")
      .where("userId", "==", token.uid)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const licenses = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const data = doc.data();
        const extensionId = String(data.extensionId ?? "");
        const extension = extensionId ? await getExtension(extensionId) : null;
        return {
          id: doc.id,
          licenseKey: String(data.licenseKey ?? doc.id),
          extensionId,
          purchaseId: data.purchaseId ?? null,
          status: String(data.status ?? "active"),
          expiresAt: data.expiresAt ?? null,
          createdAt: Number(data.createdAt ?? 0),
          extension: extension
            ? { id: extension.id, name: extension.name, developerName: extension.developerName, latestVersion: extension.latestVersion }
            : null,
        };
      }),
    );

    return NextResponse.json({ licenses });
  } catch {
    return NextResponse.json({ error: "Authentification requise." }, { status: 401 });
  }
}
