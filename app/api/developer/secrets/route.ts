import { NextResponse } from "next/server";

import { requireDeveloperAccess } from "@/lib/access/platform";
import { extensionApiError } from "@/lib/extensions/api";
import {
  deleteExtensionSecret,
  getExtension,
  listExtensionSecretRefs,
  listVersions,
  setExtensionSecret,
} from "@/lib/extensions/repository";
import { MAX_SECRETS } from "@/lib/extensions/manifest";

/**
 * Extension secrets — stored SERVER-SIDE only (never delivered to clients,
 * never returned by the API, injected into outgoing requests by the runtime).
 *
 * GET    — declared refs present in the manifest + which ones are configured.
 * PUT    — set a secret value. Body: { extensionId, ref, value }
 * DELETE — remove a secret. Body: { extensionId, ref }
 */
export async function GET(request: Request) {
  try {
    const token = await requireDeveloperAccess(request);
    const extensionId = new URL(request.url).searchParams.get("extensionId") ?? "";
    const extension = await getExtension(extensionId);

    if (!extension) {
      return NextResponse.json(
        { error: "Extension introuvable." },
        { status: 404 },
      );
    }

    if (extension.developerId !== token.uid) {
      return NextResponse.json(
        { error: "Seul le développeur peut consulter les secrets." },
        { status: 403 },
      );
    }

    const versions = await listVersions(extensionId);
    const declaredFromManifest =
      versions.find((version) => version.version === extension.latestVersion)?.manifest.secrets ??
      versions[0]?.manifest.secrets ??
      {};
    const configured = await listExtensionSecretRefs(extensionId);

    return NextResponse.json({
      secrets: Object.entries(declaredFromManifest).map(([ref, meta]) => ({
        ref,
        description: meta.description,
        configured: configured.includes(ref),
      })),
    });
  } catch (error) {
    return extensionApiError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const token = await requireDeveloperAccess(request);
    const body = (await request.json().catch(() => ({}))) as {
      extensionId?: unknown;
      ref?: unknown;
      value?: unknown;
    };

    const extensionId = typeof body.extensionId === "string" ? body.extensionId : "";
    const ref = typeof body.ref === "string" ? body.ref.trim() : "";
    const value = typeof body.value === "string" ? body.value : "";

    if (!extensionId || !ref || !value) {
      return NextResponse.json(
        { error: "extensionId, ref et value sont requis." },
        { status: 400 },
      );
    }

    const extension = await getExtension(extensionId);
    if (!extension) {
      return NextResponse.json(
        { error: "Extension introuvable." },
        { status: 404 },
      );
    }

    if (extension.developerId !== token.uid) {
      return NextResponse.json(
        { error: "Seul le développeur peut définir les secrets." },
        { status: 403 },
      );
    }

    const declared = await listExtensionSecretRefs(extensionId);
    if (!declared.includes(ref) && declared.length >= MAX_SECRETS) {
      return NextResponse.json(
        { error: "Nombre maximum de secrets atteint." },
        { status: 400 },
      );
    }

    await setExtensionSecret(extensionId, ref, value);
    return NextResponse.json({ ok: true, ref });
  } catch (error) {
    return extensionApiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const token = await requireDeveloperAccess(request);
    const body = (await request.json().catch(() => ({}))) as {
      extensionId?: unknown;
      ref?: unknown;
    };

    const extensionId = typeof body.extensionId === "string" ? body.extensionId : "";
    const ref = typeof body.ref === "string" ? body.ref.trim() : "";

    if (!extensionId || !ref) {
      return NextResponse.json(
        { error: "extensionId et ref sont requis." },
        { status: 400 },
      );
    }

    const extension = await getExtension(extensionId);
    if (!extension) {
      return NextResponse.json(
        { error: "Extension introuvable." },
        { status: 404 },
      );
    }

    if (extension.developerId !== token.uid) {
      return NextResponse.json(
        { error: "Seul le développeur peut supprimer les secrets." },
        { status: 403 },
      );
    }

    await deleteExtensionSecret(extensionId, ref);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return extensionApiError(error);
  }
}
