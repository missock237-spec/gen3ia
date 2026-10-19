import { NextResponse } from "next/server";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { extensionApiError } from "@/lib/extensions/api";
import { getExtension, getInstallation, getLatestApprovedVersion, getEntitlement, listReviews } from "@/lib/extensions/repository";
import { canUseExtension } from "@/lib/extensions/pricing";

type Params = { params: Promise<{ id: string }> };

/** Account-only extension detail. Installation, entitlement and review state are user-scoped. */
export async function GET(request: Request, { params }: Params) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id } = await params;
    const extension = await getExtension(id);
    if (!extension) return NextResponse.json({ error: "Extension introuvable." }, { status: 404 });
    const url = new URL(request.url);
    const reviews = url.searchParams.get("reviews") !== "0" ? await listReviews(id) : [];
    const latest = await getLatestApprovedVersion(id);
    const manifest = latest?.manifest ?? null;
    const installation = await getInstallation(id, token.uid);
    const entitlement = await getEntitlement(id, token.uid);
    const decision = canUseExtension(manifest?.pricing ?? (extension.pricing as never), entitlement);
    return NextResponse.json({
      extension: {
        id: extension.id, name: extension.name, description: extension.description, category: extension.category,
        tags: extension.tags, developerId: extension.developerId, developerName: extension.developerName, status: extension.status,
        latestVersion: extension.latestVersion, approvedVersion: extension.approvedVersion, pricing: extension.pricing, permissions: extension.permissions,
        stats: { installs: extension.stats.installs, ratingCount: extension.stats.ratingCount, rating: extension.stats.ratingCount > 0 ? Number((extension.stats.ratingSum / extension.stats.ratingCount).toFixed(2)) : null },
      },
      version: latest ? {
        version: latest.version, changelog: latest.changelog,
        tools: (manifest?.tools ?? []).map(tool => ({ id: tool.id, name: tool.name, description: tool.description })),
        skills: (manifest?.skills ?? []).map(skill => ({ id: skill.id, name: skill.name, description: skill.description })),
        workflows: (manifest?.workflows ?? []).map(workflow => ({ id: workflow.id, name: workflow.name, description: workflow.description })),
        settings: manifest?.settings ?? [],
      } : null,
      reviews: reviews.map(review => ({ userId: "Utilisateur vérifié", rating: review.rating, title: review.title, body: review.body, createdAt: review.createdAt })),
      userState: { installed: installation?.status === "active", version: installation?.version, status: installation?.status, entitled: decision.allowed },
    });
  } catch (error) { return extensionApiError(error); }
}
