import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { requestTraceId } from "@/lib/observability/logger";
import { errorBody } from "@/lib/security/http-errors";
import {
  acceptInvitation,
  createOrganization,
  listPendingInvitationsForEmail,
  listUserOrganizations,
} from "@/lib/tenants/organizations";

export const runtime = "nodejs";

const unauthorized = (request: NextRequest) => NextResponse.json(
  { success: false, error: "Authentification requise.", code: "AUTH_REQUIRED" },
  { status: 401, headers: { "x-gen3ia-trace-id": requestTraceId(request) } },
);

const CreateBody = z.object({
  action: z.literal("create"),
  name: z.string().trim().min(2).max(120),
});

const AcceptBody = z.object({
  action: z.literal("accept"),
  orgId: z.string().trim().min(1).max(128),
  invitationId: z.string().trim().min(1).max(128),
});

const Body = z.discriminatedUnion("action", [CreateBody, AcceptBody]);

/** GET : organisations de l'utilisateur + invitations en attente pour son email. */
export async function GET(request: NextRequest) {
  let user;
  try {
    user = await requireUser(request);
  } catch {
    return unauthorized(request);
  }
  if (!user.email) return NextResponse.json({ error: "Adresse email requise." }, { status: 400 });
  try {
    const [organizations, invitations] = await Promise.all([
      listUserOrganizations(user.uid),
      listPendingInvitationsForEmail(user.email),
    ]);
    return NextResponse.json({ organizations, invitations }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      errorBody(error, "Organisations indisponibles."),
      { status: 400 },
    );
  }
}

/** POST : création d'organisation ou acceptation d'invitation. */
export async function POST(request: NextRequest) {
  let user;
  try {
    user = await requireUser(request);
  } catch {
    return unauthorized(request);
  }
  const limit = await enforceRateLimit(`orgs:${user.uid}`, { limit: 20, windowMs: 10 * 60 * 1000 });
  if (!limit.allowed) {
    return NextResponse.json({ error: "Trop de requêtes. Réessayez dans quelques instants." }, { status: 429 });
  }
  if (!user.email) return NextResponse.json({ error: "Adresse email requise." }, { status: 400 });

  try {
    const body = Body.parse(await request.json());
    if (body.action === "create") {
      const organization = await createOrganization(user.uid, body.name, user.email);
      return NextResponse.json({ organization });
    }
    const organization = await acceptInvitation(user.uid, user.email, body.orgId, body.invitationId);
    return NextResponse.json({ organization });
  } catch (error) {
    return NextResponse.json(
      errorBody(error, "Opération impossible."),
      { status: 400 },
    );
  }
}
