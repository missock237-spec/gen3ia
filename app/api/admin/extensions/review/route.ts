import { NextResponse } from "next/server";

import { requireAdminAccess } from "@/lib/access/platform";
import { extensionApiError } from "@/lib/extensions/api";
import { listPendingVersions, reviewVersion, suspendExtension } from "@/lib/extensions/repository";

/**
 * Marketplace moderation (admin only).
 * GET  /api/admin/extensions/review          — pending submissions queue.
 * POST /api/admin/extensions/review          — approve/reject a version.
 * POST /api/admin/extensions/review?suspend=1 — suspend an extension.
 */
export async function GET(request: Request) {
  try {
    await requireAdminAccess(request);
    const pending = await listPendingVersions();
    return NextResponse.json({
      pending: pending.map((version) => ({
        extensionId: version.extensionId,
        version: version.version,
        changelog: version.changelog,
        permissions: version.manifest.permissions,
        tools: (version.manifest.tools ?? []).map((tool) => tool.id),
        pricing: version.manifest.pricing,
        author: version.manifest.author,
        submittedAt: version.submittedAt ?? null,
      })),
    });
  } catch (error) {
    return extensionApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdminAccess(request);
    const suspend = new URL(request.url).searchParams.get("suspend") === "1";
    const body = (await request.json().catch(() => ({}))) as {
      extensionId?: unknown;
      version?: unknown;
      decision?: unknown;
      note?: unknown;
    };

    const extensionId = typeof body.extensionId === "string" ? body.extensionId : "";
    if (!extensionId) {
      return NextResponse.json({ error: "extensionId est requis." }, { status: 400 });
    }

    if (suspend) {
      await suspendExtension(
        extensionId,
        typeof body.note === "string" ? body.note : undefined,
      );
      return NextResponse.json({ ok: true, status: "suspended" });
    }

    const version = typeof body.version === "string" ? body.version : "";
    const decision =
      body.decision === "approved" || body.decision === "rejected"
        ? body.decision
        : null;

    if (!version || !decision) {
      return NextResponse.json(
        { error: "version et decision (approved|rejected) sont requis." },
        { status: 400 },
      );
    }

    await reviewVersion({
      extensionId,
      version,
      decision,
      note: typeof body.note === "string" ? body.note : undefined,
    });

    return NextResponse.json({ ok: true, extensionId, version, decision });
  } catch (error) {
    return extensionApiError(error);
  }
}
