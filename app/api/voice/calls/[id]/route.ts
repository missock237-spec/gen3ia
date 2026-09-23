import { NextRequest, NextResponse } from "next/server";
import { assertPhoneCallOwner } from "@/lib/integrations/twilio/calls";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorStatus } from "@/lib/security/http-errors";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const session = await assertPhoneCallOwner(user.uid, id);
    return NextResponse.json({
      id: session.id,
      executionId: session.executionId,
      status: session.status,
      to: session.to,
      from: session.from,
      objective: session.objective,
      callSid: session.callSid ?? null,
      history: session.history,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      lastError: session.lastError ?? null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Phone call not found." },
      { status: errorStatus(error, 404) },
    );
  }
}
