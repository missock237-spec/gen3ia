import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { adminDb } from "@/lib/firebase/admin";
import { runWorkflowGraph } from "@/lib/workflows/executor";
import type { Workflow } from "@/lib/workflows/types";
import {
  CHAMP_TOKEN_HASH,
  hacherToken,
  tokenBienForme,
  verifierSignatureCorps,
} from "@/lib/workflows/triggers";
import { clientIp, enforceRateLimit } from "@/lib/security/rate-limit";
import { errorStatus } from "@/lib/security/http-errors";

/**
 * WEBHOOK ENTRANT DE WORKFLOW (P2) — POST /api/workflows/triggers/webhook/<token>
 *
 * Déclenche l'exécution d'un workflow SANS session : seul le token d'URL
 * (gwtr_<32 hex>, haché en Firestore) autorise le lancement. Défense en
 * profondeur :
 *   1. forme du token vérifiée AVANT toute requête Firestore ;
 *   2. recherche par ÉGALITÉ de hachage SHA-256 (le token lui-même n'est
 *      jamais persisté) ;
 *   3. rate limit par IP (borne l'énumération de tokens) ;
 *   4. si WEBHOOK_TRIGGER_SECRET est configuré, signature HMAC-SHA256 du
 *      corps brut exigée (`x-gen3ia-trigger-signature: sha256=<hex>`).
 *
 * FACTURATION : l'exécution est facturée au PROPRIÉTAIRE du workflow
 * (userId du document) — même règle que l'exécution depuis l'UI. Les nœuds
 * `approval` mettent le run en `awaiting_approval` : la reprise humaine
 * reste dans l'UI (jamais déclenchable par webhook).
 */

export const runtime = "nodejs";
export const maxDuration = 300;

type RouteContext = { params: Promise<{ token: string }> };

const CORPS_SCHEMA = z.object({
  input: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: Request, context: RouteContext) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const limite = await enforceRateLimit(`wf-trigger:${clientIp(request)}`, {
      limit: 30,
      windowMs: 10 * 60 * 1000,
    });
    if (!limite.allowed) {
      return NextResponse.json(
        { error: "Trop de tentatives. Réessayez plus tard.", requestId },
        { status: 429, headers: { "retry-after": String(Math.ceil(limite.retryAfterMs / 1000)) } },
      );
    }

    const { token } = await context.params;
    if (!tokenBienForme(token)) {
      return NextResponse.json({ error: "Token de déclencheur invalide.", requestId }, { status: 401 });
    }

    const corpsBrut = await request.text();
    const secret = process.env.WEBHOOK_TRIGGER_SECRET?.trim();
    if (secret && !verifierSignatureCorps(corpsBrut, secret, request.headers.get("x-gen3ia-trigger-signature"))) {
      return NextResponse.json({ error: "Signature de webhook invalide.", requestId }, { status: 401 });
    }

    const snapshot = await adminDb
      .collection("workflows")
      .where(CHAMP_TOKEN_HASH, "==", hacherToken(token))
      .limit(1)
      .get();
    const doc = snapshot.docs[0];
    if (!doc) {
      // Réponse identique token inexistant / désactivé : pas d'oracle.
      return NextResponse.json({ error: "Token de déclencheur invalide.", requestId }, { status: 401 });
    }

    const workflow = doc.data() as unknown as Workflow & {
      userId?: string;
      orgId?: string;
      [CHAMP_TOKEN_HASH]?: string | null;
    };
    const proprietaire = String(workflow.userId ?? "");
    if (!proprietaire) {
      return NextResponse.json({ error: "Workflow non déclenchable.", requestId }, { status: 409 });
    }

    const corps = CORPS_SCHEMA.parse(corpsBrut ? JSON.parse(corpsBrut) : {});
    const state = await runWorkflowGraph({
      userId: proprietaire,
      workflow,
      ...(corps.input ? { input: corps.input } : {}),
    });

    return NextResponse.json(
      { runId: state.runId, status: state.status, requestId },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Corps de requête invalide (input objet attendu).", requestId },
        { status: 422 },
      );
    }
    const message = error instanceof Error ? error.message : "Exécution impossible.";
    const status = /insufficient/i.test(message) ? 402 : errorStatus(error, 500);
    return NextResponse.json({ error: message, requestId }, { status });
  }
}
