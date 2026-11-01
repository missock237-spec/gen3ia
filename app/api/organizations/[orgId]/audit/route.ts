import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { requestTraceId } from "@/lib/observability/logger";
import { requireOrgContext } from "@/lib/tenants/organizations";
import { adminDb } from "@/lib/firebase/admin";
import { Timestamp } from "@/lib/r2fs";

/**
 * GET /api/organizations/[orgId]/audit — JOURNAL D'AUDIT DE L'ORGANISATION
 * (axe 3, audit 2 nov. 2026 : « journal d'audit visible — qui a fait quoi,
 * quand »).
 *
 * Lecture seule, réservée aux OWNER et ADMIN de l'organisation (un member
 * reçoit 403 — les mutations sont déjà gardées par assertCanManage côté
 * lib/tenants/organizations.ts ; la lecture suit la même règle car les
 * entrées contiennent des emails de membres).
 *
 * Source : collection `auditEvents`, entrées targetType="organization" ET
 * targetId={orgId} (écrites par journaliserMutationOrg). Deux égalités
 * simples = fusion d'index Firestore (aucun index composite requis) ; le
 * tri descendant est fait en mémoire sur les 200 dernières écrites.
 */

export const runtime = "nodejs";

const LIMITE_BRUTE = 200;
const LIMITE_RETOUR = 100;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  let user;
  try {
    user = await requireUser(request);
  } catch {
    return NextResponse.json(
      { error: "Authentification requise." },
      { status: 401, headers: { "x-gen3ia-trace-id": requestTraceId(request) } },
    );
  }

  const { orgId } = await params;
  try {
    const context = await requireOrgContext(user.uid, orgId);
    if (context.role !== "owner" && context.role !== "admin") {
      return NextResponse.json(
        { error: "Le journal d'audit est réservé aux owners et admins de l'organisation." },
        { status: 403, headers: { "x-gen3ia-trace-id": requestTraceId(request) } },
      );
    }

    const snap = await adminDb
      .collection("auditEvents")
      .where("targetType", "==", "organization")
      .where("targetId", "==", orgId)
      .limit(LIMITE_BRUTE)
      .get();

    const entrees = snap.docs
      .map((doc) => {
        const d = doc.data() as Record<string, unknown>;
        const created = d.createdAt;
        return {
          id: String(d.id ?? doc.id),
          action: String(d.action ?? "?"),
          outcome: String(d.outcome ?? "?"),
          actorId: d.actorId ? String(d.actorId) : null,
          actorEmail: d.actorEmail ? String(d.actorEmail) : null,
          metadata: d.metadata ? String(d.metadata) : null,
          createdAt: created instanceof Timestamp ? created.toDate().toISOString() : null,
        };
      })
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, LIMITE_RETOUR);

    return NextResponse.json(
      { entries: entrees, total: entrees.length },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Journal indisponible." },
      { status: 404 },
    );
  }
}
