import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus, errorCode } from "@/lib/security/http-errors";
import { deletePushSubscription, upsertPushSubscription } from "@/lib/push/repository";

/**
 * Abonnements Web Push (Task 100) — enregistrement du navigateur pour le
 * push serveur (Web Push / VAPID).
 *
 * POST   /api/push/subscribe → { ok: true }  upsert idempotent (le MÊME
 *                                            endpoint remplace l'entrée —
 *                                            clés fraîches, createdAtMs conservé)
 * DELETE /api/push/subscribe → { ok: true }  suppression idempotente
 *                                            (200 même si l'abonnement est absent)
 *
 * Le corps POST reprend la forme `JSON.stringify(pushSubscription)` du
 * navigateur : { endpoint, keys: { p256dh, auth }, expirationTime? }.
 * L'utilisateur-agent sert uniquement au débogage (tronqué côté stockage).
 */

export const runtime = "nodejs";

const SubscribeBody = z.object({
  subscription: z.object({
    endpoint: z.string().trim().min(1).max(2048),
    keys: z.object({
      p256dh: z.string().trim().min(1).max(512),
      auth: z.string().trim().min(1).max(512),
    }),
    expirationTime: z.number().int().positive().nullable().optional(),
  }),
});

const UnsubscribeBody = z.object({
  endpoint: z.string().trim().min(1).max(2048),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const body = SubscribeBody.parse(await request.json().catch(() => ({})));
    await upsertPushSubscription(user.uid, {
      endpoint: body.subscription.endpoint,
      keys: body.subscription.keys,
      expirationTime: body.subscription.expirationTime ?? null,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: errorStatus(error), headers: { "x-gen3ia-error-code": errorCode(error) } });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const body = UnsubscribeBody.parse(await request.json().catch(() => ({})));
    await deletePushSubscription(user.uid, body.endpoint);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: errorStatus(error), headers: { "x-gen3ia-error-code": errorCode(error) } });
  }
}
