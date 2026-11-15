import { NextResponse, NextRequest } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { adminDb } from "@/lib/firebase/admin";
import { assertResourceRead } from "@/lib/tenants/resource-access";
import {
  CHAMP_DERNIER,
  CHAMP_INTERVALE,
  CHAMP_TOKEN_HASH,
  genererTokenDeclencheur,
  hacherToken,
  parserIntervale,
} from "@/lib/workflows/triggers";

/**
 * TOKEN DE DÉCLENCHEUR WEBHOOK/CRON D'UN WORKFLOW (P2).
 *
 * POST  /api/workflows/[id]/trigger-token  — génère (ou régénère) le token
 *         d'URL webhook + définit l'intervalle cron optionnel.
 *         Corps : { intervalMinutes?: number } (5..1440, absent = pas de cron).
 * DELETE /api/workflows/[id]/trigger-token  — désactive tout déclenchement
 *         externe (hash + intervalle supprimés).
 *
 * Le token ORIGINAL n'est renvoyé QU'UNE SEULE FOIS : seule son empreinte
 * SHA-256 est persistée (triggerTokenHash). Une fuite de Firestore ne
 * permet aucun déclenchement ; une régénération invalide l'ancien token.
 */

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const ref = adminDb.collection("workflows").doc(id);
    const doc = await ref.get();
    if (!doc.exists) {
      return NextResponse.json({ error: "Workflow introuvable.", requestId }, { status: 404 });
    }
    const data = doc.data() as { userId?: string; orgId?: string };
    try {
      await assertResourceRead(user.uid, {
        ownerId: String(data.userId ?? ""),
        orgId: typeof data.orgId === "string" ? data.orgId : null,
      });
    } catch {
      return NextResponse.json({ error: "Workflow introuvable.", requestId }, { status: 404 });
    }

    const corps = (await request.json().catch(() => ({}))) as {
      intervalMinutes?: unknown;
    };
    const intervalle = parserIntervale(corps.intervalMinutes);

    const token = genererTokenDeclencheur();
    await ref.update({
      [CHAMP_TOKEN_HASH]: hacherToken(token),
      // Intervalle défini → cron actif ; absent → champ null (sentinelle
      // ignore). Dernier déclenchement réinitialisé : la première échéance
      // est due au prochain passage de la sentinelle.
      [CHAMP_INTERVALE]: intervalle,
      [CHAMP_DERNIER]: 0,
    });

    return NextResponse.json(
      {
        token,
        webhookUrl: `/api/workflows/triggers/webhook/${token}`,
        intervalMinutes: intervalle,
        requestId,
      },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Génération impossible.";
    const status = /auth/i.test(message) ? 401 : 500;
    return NextResponse.json({ error: message, requestId }, { status });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await context.params;
    const ref = adminDb.collection("workflows").doc(id);
    const doc = await ref.get();
    if (!doc.exists) {
      return NextResponse.json({ error: "Workflow introuvable.", requestId }, { status: 404 });
    }
    const data = doc.data() as { userId?: string; orgId?: string };
    try {
      await assertResourceRead(user.uid, {
        ownerId: String(data.userId ?? ""),
        orgId: typeof data.orgId === "string" ? data.orgId : null,
      });
    } catch {
      return NextResponse.json({ error: "Workflow introuvable.", requestId }, { status: 404 });
    }

    await ref.update({
      [CHAMP_TOKEN_HASH]: null,
      [CHAMP_INTERVALE]: null,
      [CHAMP_DERNIER]: null,
    });
    return NextResponse.json(
      { desactive: true, requestId },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Désactivation impossible.";
    const status = /auth/i.test(message) ? 401 : 500;
    return NextResponse.json({ error: message, requestId }, { status });
  }
}
