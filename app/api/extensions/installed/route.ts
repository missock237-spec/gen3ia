import { NextResponse } from "next/server";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { getExtension, listInstalledExtensions } from "@/lib/extensions/repository";

export async function GET(request: Request) {
  try {
    const token = await verifyFirebaseAuth(request);
    const installations = await listInstalledExtensions(token.uid);
    const extensions = await Promise.all(
      installations.map(async (installation) => {
        const extension = await getExtension(installation.extensionId);
        return {
          ...installation,
          extension: extension
            ? {
                id: extension.id,
                name: extension.name,
                description: extension.description,
                category: extension.category,
                tags: extension.tags,
                developerName: extension.developerName,
                latestVersion: extension.latestVersion,
                approvedVersion: extension.approvedVersion,
                pricing: extension.pricing,
                stats: {
                  installs: extension.stats.installs,
                  ratingCount: extension.stats.ratingCount,
                  rating: extension.stats.ratingCount > 0 ? extension.stats.ratingSum / extension.stats.ratingCount : null,
                },
              }
            : null,
        };
      }),
    );
    return NextResponse.json({ installations: extensions });
  } catch {
    return NextResponse.json({ error: "Authentification requise." }, { status: 401 });
  }
}
