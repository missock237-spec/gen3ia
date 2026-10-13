import { NextRequest, NextResponse } from "next/server";

import { logger } from "@/lib/observability/logger";
import {
  isBlandWebhookSecretConfigured,
  verifyBlandWebhookSignature,
} from "@/lib/integrations/bland/client";
import { applyBlandCallDetails, normalizeWebhookPayload } from "@/lib/voice/bland-calls";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * WEBHOOK POST-APPEL BLAND (POST /api/voice/webhook/bland).
 *
 * Bland POST le payload complet de l'appel (statut final, transcripts,
 * résumé, enregistrement, prix) à l'URL fournie au moment de l'envoi
 * (paramètre `webhook` de POST /v1/calls). Ce point d'entrée :
 *
 *  1. vérifie la signature X-Webhook-Signature (HMAC-SHA256 hex du corps
 *     brut) SI un secret est configuré — sinon journalise l'absence et
 *     poursuit (mode bootstrap) ;
 *  2. normalise le payload ;
 *  3. met à jour l'enregistrement « voiceCalls » correspondant (clé =
 *     call_id) — les appels inconnus sont ignorés sans erreur (200) pour
 *     éviter les rejeux infinis côté Bland ;
 *  4. déclenche la facturation miroir (une seule fois, par garde interne).
 *
 * Pas de requireUser ici : l'authentification repose sur la connaissance
 * du call_id + la signature HMAC (même pattern que les webhooks
 * téléphoniques entrants historiques).
 */
export async function POST(request: NextRequest) {
  const raw = await request.text();
  try {
    if (isBlandWebhookSecretConfigured()) {
      const signature = request.headers.get("x-webhook-signature");
      if (!verifyBlandWebhookSignature(raw, signature)) {
        logger.warn({ signaturePresent: Boolean(signature) }, "bland_webhook_rejected_signature");
        return NextResponse.json({ error: "Signature webhook invalide." }, { status: 401 });
      }
    } else {
      logger.warn(
        { hint: "Configurez BLAND_WEBHOOK_SECRET (dashboard Bland > Settings > Keys) pour rejeter les webhooks falsifiés." },
        "bland_webhook_unverified",
      );
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Corps JSON invalide." }, { status: 400 });
    }

    const details = normalizeWebhookPayload(payload);
    if (!details.callId) {
      logger.warn("bland_webhook_missing_call_id");
      return NextResponse.json({ error: "Identifiant d'appel manquant." }, { status: 400 });
    }

    const updated = await applyBlandCallDetails(details.callId, details, { bill: true });
    if (!updated) {
      // Appel inconnu (jamais lancé par ce déploiement) : accusé de
      // réception silencieux — ne pas provoquer de rejeux Bland.
      logger.info({ callId: details.callId }, "bland_webhook_ignored_unknown_call");
      return NextResponse.json({ ok: true, ignored: true });
    }

    logger.info(
      {
        callId: details.callId,
        status: updated.status,
        lengthMinutes: updated.lengthMinutes ?? 0,
      },
      "bland_webhook_applied",
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error({ err: error }, "bland_webhook_failed");
    return NextResponse.json({ error: "Traitement webhook impossible." }, { status: 500 });
  }
}
