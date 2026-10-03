import { NextResponse } from "next/server";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { getEntitlement, getExtension, listSubscriptionEntitlements, setEntitlementAutoRenew } from "@/lib/extensions/repository";
import { errorStatus } from "@/lib/security/http-errors";

export const dynamic = "force-dynamic";

/**
 * Abonnements de l'utilisateur connecté.
 * GET  /api/extensions/entitlements — mes abonnements (terme, autoRenew, état de renouvellement).
 * PATCH /api/extensions/entitlements — basculer autoRenew d'un abonnement (annulation / réactivation).
 */
export async function GET(request: Request) {
  try {
    const token = await verifyFirebaseAuth(request);
    // La collection est lue par source (index simple natif) puis filtrée par
    // userId en mémoire — aucun index composite nouveau requis (leçon Task 68 :
    // déployer un index nécessite datastore.indexAdmin, indisponible au SA).
    const all = await listSubscriptionEntitlements(400);
    const mine = all.filter((entitlement) => entitlement.userId === token.uid);
    const enriched = await Promise.all(
      mine.map(async (entitlement) => {
        const extension = await getExtension(entitlement.extensionId);
        return {
          extensionId: entitlement.extensionId,
          extensionName: extension?.name ?? entitlement.extensionId,
          status: entitlement.status,
          expiresAt: entitlement.expiresAt ?? null,
          autoRenew: entitlement.autoRenew !== false,
          renewalState: entitlement.renewalState ?? null,
          renewalNotice: entitlement.renewalNotice ?? null,
          updatedAt: entitlement.updatedAt,
        };
      }),
    );
    return NextResponse.json({ entitlements: enriched });
  } catch {
    return NextResponse.json({ error: "Authentification requise." }, { status: 401 });
  }
}

export async function PATCH(request: Request) {
  try {
    const token = await verifyFirebaseAuth(request);
    const body = (await request.json().catch(() => ({}))) as { extensionId?: unknown; autoRenew?: unknown };
    const extensionId = typeof body.extensionId === "string" ? body.extensionId.trim() : "";
    if (!extensionId) {
      return NextResponse.json({ error: "extensionId est requis." }, { status: 400 });
    }
    if (typeof body.autoRenew !== "boolean") {
      return NextResponse.json({ error: "autoRenew doit être un booléen." }, { status: 400 });
    }

    const entitlement = await getEntitlement(extensionId, token.uid);
    if (!entitlement || entitlement.userId !== token.uid) {
      // 404 (et non 403) : pas d'existence révélée pour un tiers.
      return NextResponse.json({ error: "Abonnement introuvable." }, { status: 404 });
    }

    const updated = await setEntitlementAutoRenew(extensionId, token.uid, body.autoRenew);
    return NextResponse.json({
      entitlement: {
        extensionId: updated.extensionId,
        autoRenew: updated.autoRenew !== false,
        status: updated.status,
        expiresAt: updated.expiresAt ?? null,
      },
      message: body.autoRenew
        ? "Renouvellement automatique activé."
        : "Renouvellement automatique désactivé — votre abonnement restera actif jusqu'à son terme.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inattendue.";
    return NextResponse.json({ error: message }, { status: errorStatus(error, 400) });
  }
}
