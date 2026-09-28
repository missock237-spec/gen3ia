import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus, errorCode } from "@/lib/security/http-errors";
import {
  countUnreadNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationsCacheKey,
} from "@/lib/notifications/repository";
import { cacheWrap } from "@/lib/cache/redis";

/**
 * Centre de notifications in-app.
 *
 * GET  /api/notifications?limit=30&unread=1 → { notifications, unread }
 * POST /api/notifications                   → { id? } marque une notification
 *                                             lue ; { all: true } marque tout.
 *
 * Les DÉCISIONS d'approbation passent par les routes métier existantes
 * (/api/agent/chat/approve et /api/workspace/approvals/:id) : elles vérifient
 * la session et la propriété, appliquent la politique HITL et relancent
 * l'exécution — le centre de notifications ne fait que les déclencher.
 */

export const runtime = "nodejs";

const ReadBody = z.object({
  id: z.string().trim().min(1).max(256).optional(),
  all: z.boolean().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const params = request.nextUrl.searchParams;
    const limit = Math.min(Math.max(Number(params.get("limit") ?? 30) || 30, 1), 50);
    const unreadOnly = params.get("unread") === "1";

    // Micro-cache sur la SEULE forme canonique du produit (polling sonnette
    // limit=30, sans filtre) : invalidé par événement à chaque mutation
    // (voir repository.ts) — latence réelle inchangée, charge Firestore
    // réduite d'un ordre de grandeur. Toute autre forme bypass le cache.
    const chargeur = async () => {
      const [notifications, unread] = await Promise.all([
        listNotifications(user.uid, limit, unreadOnly),
        countUnreadNotifications(user.uid),
      ]);
      return { notifications, unread };
    };
    const { notifications, unread } =
      limit === 30 && !unreadOnly
        ? (await cacheWrap(notificationsCacheKey(user.uid, 30, false), 20, chargeur)).value
        : await chargeur();
    return NextResponse.json({ notifications, unread });
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: errorStatus(error), headers: { "x-gen3ia-error-code": errorCode(error) } });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const body = ReadBody.parse(await request.json().catch(() => ({})));
    if (body.all) {
      await markAllNotificationsRead(user.uid);
    } else if (body.id) {
      await markNotificationRead(user.uid, body.id);
    }
    const unread = await countUnreadNotifications(user.uid);
    return NextResponse.json({ ok: true, unread });
  } catch (error) {
    return NextResponse.json(errorBody(error), { status: errorStatus(error), headers: { "x-gen3ia-error-code": errorCode(error) } });
  }
}
