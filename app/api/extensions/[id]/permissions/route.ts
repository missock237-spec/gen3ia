import { NextResponse } from "next/server";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { adminDb } from "@/lib/firebase/admin";
import { extensionApiError } from "@/lib/extensions/api";
import { getInstallation, getLatestApprovedVersion } from "@/lib/extensions/repository";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/extensions/:id/permissions
 * Users may revoke permissions previously granted to an installed extension.
 * A client can never grant a permission that is absent from the approved manifest.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id } = await params;
    const installation = await getInstallation(id, token.uid);
    if (!installation || installation.status !== "active") {
      return NextResponse.json({ error: "Cette extension n'est pas installée." }, { status: 403 });
    }

    const version = await getLatestApprovedVersion(id);
    if (!version) return NextResponse.json({ error: "Aucune version approuvée." }, { status: 404 });

    const body = (await request.json().catch(() => null)) as { permissions?: unknown } | null;
    if (!body || !Array.isArray(body.permissions)) {
      return NextResponse.json({ error: "permissions doit être un tableau." }, { status: 400 });
    }

    const requested = [...new Set(body.permissions.filter((value): value is string => typeof value === "string" && value.length <= 200))];
    if (requested.length !== body.permissions.length) {
      return NextResponse.json({ error: "Liste de permissions invalide." }, { status: 400 });
    }

    const approved = new Set(version.manifest.permissions);
    const unauthorized = requested.filter((permission) => !approved.has(permission));
    if (unauthorized.length) {
      return NextResponse.json({ error: "Une ou plusieurs permissions ne sont pas autorisées par le manifeste approuvé.", unauthorized }, { status: 400 });
    }

    const installationRef = adminDb.collection("extensionInstallations").doc(installation.id);
    await installationRef.update({ permissionsGranted: requested, updatedAt: Date.now() });

    return NextResponse.json({ extensionId: id, version: installation.version, permissionsGranted: requested });
  } catch (error) {
    return extensionApiError(error);
  }
}
