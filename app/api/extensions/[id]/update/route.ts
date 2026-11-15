import { NextResponse } from "next/server";
import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { adminDb } from "@/lib/firebase/admin";
import { extensionApiError } from "@/lib/extensions/api";
import { getExtension, getInstallation, getLatestApprovedVersion } from "@/lib/extensions/repository";
import { assertExtensionUsable } from "@/lib/extensions/entitlements";
import { compareSemver } from "@/lib/extensions/manifest";

type Params = { params: Promise<{ id: string }> };

/**
 * Upgrade an installed extension only when its current entitlement is valid.
 *
 * SECURITY: an extension update may introduce new permissions, but an update
 * must never silently grant them. Existing grants are preserved only when the
 * permission is still declared by the new approved manifest. Newly requested
 * permissions remain ungranted until the user explicitly accepts them through
 * PATCH /api/extensions/:id/permissions.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id } = await params;
    const installation = await getInstallation(id, token.uid);
    if (!installation || installation.status !== "active") {
      return NextResponse.json({ error: "Cette extension n'est pas installée." }, { status: 400 });
    }

    const extension = await getExtension(id);
    if (!extension || extension.status !== "approved") {
      return NextResponse.json({ error: "Cette extension n'est plus disponible." }, { status: 400 });
    }
    await assertExtensionUsable(token.uid, extension);

    const latest = await getLatestApprovedVersion(id);
    if (!latest) return NextResponse.json({ error: "Aucune version approuvée." }, { status: 400 });
    if (compareSemver(installation.version, latest.version) >= 0) {
      return NextResponse.json({ status: "up_to_date", version: installation.version, permissionsGranted: installation.permissionsGranted });
    }

    const installationRef = adminDb.collection("extensionInstallations").doc(`${id}__${token.uid}`);
    let permissionsGranted: string[] = [];

    await adminDb.runTransaction(async (tx) => {
      const currentSnap = await tx.get(installationRef);
      if (!currentSnap.exists) throw new Error("Cette extension n'est pas installée.");

      const current = currentSnap.data() as {
        userId?: string;
        status?: string;
        version?: string;
        permissionsGranted?: unknown;
      };
      if (current.userId !== token.uid || current.status !== "active") {
        throw new Error("Cette installation n'est plus active.");
      }

      const currentVersion = String(current.version ?? "");
      if (compareSemver(currentVersion, latest.version) >= 0) {
        permissionsGranted = Array.isArray(current.permissionsGranted)
          ? current.permissionsGranted.filter((value): value is string => typeof value === "string")
          : [];
        return;
      }

      const approvedPermissions = new Set(latest.manifest.permissions);
      const currentPermissions = Array.isArray(current.permissionsGranted)
        ? current.permissionsGranted.filter((value): value is string => typeof value === "string")
        : [];

      // Preserve only permissions that still exist in the approved manifest.
      // Do NOT add latest.manifest.permissions wholesale: that would grant a
      // newly introduced capability without user consent.
      permissionsGranted = currentPermissions.filter((permission) => approvedPermissions.has(permission));

      tx.update(installationRef, {
        version: latest.version,
        permissionsGranted,
        updatedAt: Date.now(),
      });
    });

    const newlyRequestedPermissions = latest.manifest.permissions.filter(
      (permission) => !permissionsGranted.includes(permission),
    );

    return NextResponse.json({
      status: "updated",
      version: latest.version,
      permissionsGranted,
      requiresPermissionConsent: newlyRequestedPermissions.length > 0,
      newlyRequestedPermissions,
    });
  } catch (error) {
    return extensionApiError(error);
  }
}
