import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { rateLimit } from "@/lib/security/rate-limit";
import { requestTraceId } from "@/lib/observability/logger";
import {
  inviteMember,
  removeMember,
  requireOrgContext,
  revokeInvitation,
  updateMemberRole,
  type OrgRole,
} from "@/lib/tenants/organizations";

export const runtime = "nodejs";

const unauthorized = (request: NextRequest) => NextResponse.json(
  { success: false, error: "Authentification requise." },
  { status: 401, headers: { "x-gen3ia-trace-id": requestTraceId(request) } },
);

const InviteBody = z.object({
  action: z.literal("invite"),
  email: z.string().trim().email().max(200),
  role: z.enum(["admin", "member"]).default("member"),
});

const RoleBody = z.object({
  action: z.literal("role"),
  memberId: z.string().trim().min(1).max(128),
  role: z.enum(["admin", "member"]),
});

const RemoveBody = z.object({
  action: z.literal("remove"),
  memberId: z.string().trim().min(1).max(128),
});

const RevokeBody = z.object({
  action: z.literal("revoke"),
  invitationId: z.string().trim().min(1).max(128),
});

const Body = z.discriminatedUnion("action", [InviteBody, RoleBody, RemoveBody, RevokeBody]);

/** Gestion des membres d'une organisation : invitation, rôle, retrait, révocation. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  let user;
  try {
    user = await requireUser(request);
  } catch {
    return unauthorized(request);
  }
  const limit = rateLimit(`org-members:${user.uid}`, { limit: 30, windowMs: 10 * 60 * 1000 });
  if (!limit.allowed) {
    return NextResponse.json({ error: "Trop de requêtes. Réessayez dans quelques instants." }, { status: 429 });
  }
  const { orgId } = await params;
  try {
    const context = await requireOrgContext(user.uid, orgId);
    const body = Body.parse(await request.json());
    switch (body.action) {
      case "invite":
        return NextResponse.json({ invitation: await inviteMember(context, body.email, body.role as OrgRole) });
      case "role":
        await updateMemberRole(context, body.memberId, body.role as OrgRole);
        return NextResponse.json({ ok: true });
      case "remove":
        await removeMember(context, body.memberId);
        return NextResponse.json({ ok: true });
      case "revoke":
        await revokeInvitation(context, body.invitationId);
        return NextResponse.json({ ok: true });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Opération impossible." },
      { status: 400 },
    );
  }
}
