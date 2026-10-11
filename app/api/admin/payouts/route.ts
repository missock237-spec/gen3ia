import { NextResponse } from "next/server";

import { requireAdminAccess } from "@/lib/access/platform";
import { extensionApiError } from "@/lib/extensions/api";
import { decideDeveloperPayout, listAdminPayoutQueue } from "@/lib/extensions/payouts";
import { recordAuditEvent } from "@/lib/security/audit-events";

export const dynamic = "force-dynamic";

/**
 * File des retraits développeurs (admin uniquement).
 * GET  /api/admin/payouts — mandats à traiter (requested + approved).
 * POST /api/admin/payouts — décision sur un mandat.
 *      { payoutId, decision: "approve"|"reject"|"mark_paid", adminNote?, providerRef? }
 *      mark_paid exige providerRef (référence traçable Mobile Money / virement).
 */
export async function GET(request: Request) {
  try {
    await requireAdminAccess(request);
    const payouts = await listAdminPayoutQueue();
    return NextResponse.json({ payouts });
  } catch (error) {
    return extensionApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdminAccess(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const payoutId = typeof body.payoutId === "string" ? body.payoutId.trim() : "";
    const decision = body.decision;
    if (!payoutId) {
      return NextResponse.json({ error: "payoutId est requis." }, { status: 400 });
    }
    if (decision !== "approve" && decision !== "reject" && decision !== "mark_paid") {
      return NextResponse.json({ error: "decision doit valoir approve, reject ou mark_paid." }, { status: 400 });
    }

    // Journal d'audit (Task 126) : décision financière admin — trace AVANT
    // l'effet (qui, quel mandat, quelle décision). Best-effort borné.
    await recordAuditEvent({
      actorId: admin.uid,
      actorEmail: admin.email ?? null,
      action: "admin.payout_decision",
      outcome: "granted",
      targetType: "payout",
      targetId: payoutId,
      metadata: { decision },
    }).catch(() => undefined);

    const payout = await decideDeveloperPayout({
      payoutId,
      decision,
      adminNote: body.adminNote,
      providerRef: body.providerRef,
    });
    return NextResponse.json({ payout });
  } catch (error) {
    return extensionApiError(error);
  }
}
