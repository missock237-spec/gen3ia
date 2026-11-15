import { NextRequest, NextResponse } from "next/server";

import { adminDb } from "@/lib/firebase/admin";
import { FieldValue, FsTimestamp } from "@/lib/r2fs";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { requireService } from "@/lib/security/service-identity";
import { timingSafeStringEqual } from "@/lib/security/timing-safe";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * MIGRATION R2 TOTALE (Task 111-b) — remplace la Cloud Function
 * `cleanupExpiredInvitations` (functions/, supprimée) : marque « expired »
 * les invitations d'organisations en attente dont la date d'expiration est
 * dépassée. Déclenchée par le cron Vercel quotidien (vercel.json).
 *
 * Auth : CRON_SECRET (Bearer), même contrat que /api/cron/agent-schedules,
 * OU signature d'identité de service (GEN3IA_SERVICE_TOKENS, service
 * « cron ») — rétrocompatible : bearer seul tant que la variable est absente.
 */
function isAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const authorization = request.headers.get("authorization") ?? "";
  return timingSafeStringEqual(authorization, `Bearer ${secret}`);
}

/**
 * AUTHENTIFICATION DU SERVICE APPELANT (Pilier 3 — Zero Trust) : la
 * signature d'identité de service (lib/security/service-identity.ts) est
 * acceptée EN PLUS du bearer CRON_SECRET historique — jamais à sa place.
 * GEN3IA_SERVICE_TOKENS absente → bearer seul, comportement inchangé
 * (rétrocompatibilité stricte, warning loggé par le module).
 */
function estAutorisee(request: NextRequest): boolean {
  return requireService(request, "cron").ok || isAuthorized(request);
}

export async function POST(request: NextRequest) {
  if (!estAutorisee(request)) {
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

    return NextResponse.json({ ok: true, scanned: snapshot.size, expired: expirees, at: maintenant.toMillis() });
  } catch (error) {
    // Pattern canonique : réponse JSON + statut classifié (un `return
    // errorStatus(error)` seul retourne un NOMBRE → 500 vide de Next).
    return NextResponse.json(errorBody(error, "Nettoyage des invitations indisponible."), { status: errorStatus(error) });
  }
}
