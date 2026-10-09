import { NextRequest, NextResponse } from "next/server";
import type { Timestamp } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";
import { FieldValue, FsTimestamp } from "@/lib/r2fs";
import { errorStatus } from "@/lib/security/http-errors";
import { timingSafeStringEqual } from "@/lib/security/timing-safe";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * MIGRATION R2 TOTALE (Task 111-b) — remplace la Cloud Function
 * `cleanupExpiredInvitations` (functions/, supprimée) : marque « expired »
 * les invitations d'organisations en attente dont la date d'expiration est
 * dépassée. Déclenchée par le cron Vercel quotidien (vercel.json).
 *
 * Auth : CRON_SECRET (Bearer), même contrat que /api/cron/agent-schedules.
 */
function isAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const authorization = request.headers.get("authorization") ?? "";
  return timingSafeStringEqual(authorization, `Bearer ${secret}`);
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  try {
    const maintenant = FsTimestamp.now();
    const snapshot = await adminDb
      .collectionGroup("invitations")
      .where("status", "==", "pending")
      .get();

    let expirees = 0;
    const batch = adminDb.batch();
    for (const doc of snapshot.docs) {
      const expiration = doc.get("expiresAt");
      const expireAtMs = expiration instanceof FsTimestamp ? expiration.toMillis() : 0;
      if (expireAtMs > 0 && expireAtMs < maintenant.toMillis()) {
        batch.update(doc.ref, { status: "expired", expiredAt: FieldValue.serverTimestamp() });
        expirees += 1;
      }
    }
    if (expirees > 0) await batch.commit();

    return NextResponse.json({ ok: true, scanned: snapshot.size, expired: expirees, at: (maintenant as Timestamp).toMillis() });
  } catch (error) {
    return errorStatus(error);
  }
}
