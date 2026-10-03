import { NextResponse } from "next/server";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { extensionApiError } from "@/lib/extensions/api";
import {
  getExtension,
  getInstallation,
  getLatestApprovedVersion,
  installExtension,
  uninstallExtension,
} from "@/lib/extensions/repository";
import { startChariowPurchase, purchaseWithWallet } from "@/lib/extensions/entitlements";

const WALLET_CURRENCIES = new Set(["xaf", "xfcfa", "xfpfc"]); // devise unique du wallet Gen3ia

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/extensions/:id/install.
 * Free extensions install immediately. Paid extensions: body.paymentMethod
 * = "wallet" (débit immédiat du wallet Gen3ia, XAF uniquement) ou défaut
 * "chariow" (checkout 202). Payment is never trusted from the browser:
 * entitlement is created server-side only (wallet settlement or verified
 * Chariow Pulse webhook).
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id } = await params;
    const extension = await getExtension(id);
    if (!extension) return NextResponse.json({ error: "Extension introuvable." }, { status: 404 });
    if (extension.status !== "approved") {
      return NextResponse.json({ error: "Cette extension n'est pas disponible à l'installation." }, { status: 400 });
    }

    const version = await getLatestApprovedVersion(id);
    if (!version) return NextResponse.json({ error: "Aucune version approuvée." }, { status: 400 });

    const body = (await request.json().catch(() => ({}))) as { email?: string; redirectUrl?: string; paymentMethod?: string };
    const pricing = version.manifest.pricing;
    let walletPurchased = false;

    if (pricing.model !== "free") {
      const existing = await getInstallation(id, token.uid);
      const entitled = await hasActiveEntitlement(id, token.uid);
      if ((!existing || existing.status !== "active") && !entitled) {
        if (body.paymentMethod === "wallet") {
          const currency = String(pricing.currency ?? "XAF").toUpperCase();
          if (!WALLET_CURRENCIES.has(currency)) {
            return NextResponse.json({ error: `Cette extension est facturée en ${currency} : le wallet Gen3ia (XAF) ne peut pas la payer. Utilisez le paiement Chariow.` }, { status: 400 });
          }
          const reference = `ext-install:${id}:${token.uid}`;
          await purchaseWithWallet({ userId: token.uid, extension, reference });
          walletPurchased = true;
        } else {
          const email = body.email?.trim() || token.email?.trim();
          if (!email) return NextResponse.json({ error: "Une adresse e-mail est requise pour démarrer le paiement Chariow." }, { status: 400 });
          const checkout = await startChariowPurchase({
            userId: token.uid,
            extension,
            email,
            redirectUrl: body.redirectUrl ?? "https://gen3ia.online/marketplace",
          });
          return NextResponse.json({ status: "checkout_required", provider: "chariow", checkoutUrl: checkout.checkoutUrl, purchaseId: checkout.purchaseId }, { status: 202 });
        }
      }
    }

    const installation = await installExtension({
      userId: token.uid,
      extension,
      version: version.version,
      permissionsGranted: version.manifest.permissions,
      settings: Object.fromEntries((version.manifest.settings ?? []).map((setting) => [setting.key, setting.default])),
    });

    return NextResponse.json({
      installation: { extensionId: installation.extensionId, version: installation.version, status: installation.status },
      permissionsGranted: installation.permissionsGranted,
      ...(walletPurchased ? { payment: { provider: "wallet", status: "paid" } } : {}),
    });
  } catch (error) {
    return extensionApiError(error);
  }
}

/** DELETE /api/extensions/:id/install — uninstall (soft delete). */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id } = await params;
    await uninstallExtension(id, token.uid);
    return NextResponse.json({ ok: true, status: "uninstalled" });
  } catch (error) {
    return extensionApiError(error);
  }
}

async function hasActiveEntitlement(extensionId: string, userId: string): Promise<boolean> {
  try {
    const { getEntitlement } = await import("@/lib/extensions/repository");
    const entitlement = await getEntitlement(extensionId, userId);
    return Boolean(entitlement && entitlement.status === "active");
  } catch {
    return false;
  }
}
