import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { requestTraceId } from "@/lib/observability/logger";
import { requireOrgContext, quotasForPlan, listMembers, listOrgInvitations } from "@/lib/tenants/organizations";

export const runtime = "nodejs";

const unauthorized = (request: NextRequest) => NextResponse.json(
  { success: false, error: "Authentification requise." },
  { status: 401, headers: { "x-gen3ia-trace-id": requestTraceId(request) } },
);

/** Détail d'une organisation : membres, invitations, quotas du plan. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  let user;
  try {
    user = await requireUser(request);
  } catch {
    return unauthorized(request);
  }
  const { orgId } = await params;
  try {
    const context = await requireOrgContext(user.uid, orgId);
    const [members, invitations] = await Promise.all([
      listMembers(context),
      context.role === "owner" || context.role === "admin" ? listOrgInvitations(context) : Promise.resolve([]),
    ]);
    return NextResponse.json(
      { organization: context, quotas: quotasForPlan(context.plan), members, invitations },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Organisation indisponible." },
      { status: 404 },
    );
  }
}
