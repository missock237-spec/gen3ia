import { NextResponse } from "next/server";

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { extensionApiError } from "@/lib/extensions/api";
import { createReport } from "@/lib/extensions/repository";
import { enforceRateLimit } from "@/lib/security/rate-limit";

type Params = { params: Promise<{ id: string }> };

const REASONS = new Set([
  "malicious_behavior",
  "data_exfiltration",
  "broken_functionality",
  "misleading_description",
  "spam",
  "other",
]);

/**
 * POST /api/extensions/:id/reports — report (signaler) an extension.
 * Body: { reason, details? } — rate limited per user to prevent abuse.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const token = await verifyFirebaseAuth(request);
    const { id } = await params;
    const limit = await enforceRateLimit(`ext-report:${token.uid}`, { limit: 5, windowMs: 60 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Trop de signalements. Réessayez plus tard." }, { status: 429 });
    }
    const body = (await request.json().catch(() => ({}))) as { reason?: unknown; details?: unknown };
    const reason = typeof body.reason === "string" && REASONS.has(body.reason) ? body.reason : null;
    if (!reason) {
      return NextResponse.json(
        { error: `Motif invalide. Valeurs acceptées : ${[...REASONS].join(", ")}.` },
        { status: 400 },
      );
    }
    await createReport({
      extensionId: id,
      userId: token.uid,
      reason,
      details: typeof body.details === "string" ? body.details : undefined,
    });
    return NextResponse.json({ ok: true, status: "reported" });
  } catch (error) {
    return extensionApiError(error);
  }
}
