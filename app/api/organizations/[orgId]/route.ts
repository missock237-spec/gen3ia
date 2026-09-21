import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";
import { requireOrgContext, quotasForPlan, listMembers, listOrgInvitations } from "@/lib/tenants/organizations";

export const runtime = "nodejs";

/** Détail d'une organisation : membres, invitations, quotas du plan. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const user = await requireUser(request);
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
