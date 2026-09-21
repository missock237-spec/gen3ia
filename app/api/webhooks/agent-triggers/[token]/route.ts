import { NextRequest, NextResponse } from "next/server";

import { rateLimit } from "@/lib/security/rate-limit";
import { triggerScheduleByWebhookToken } from "@/lib/agents/scheduler";

/**
 * Webhook ENTRANT « agent toujours actif » : un POST signé par le token
 * secret de la planification déclenche la mission de l'agent — depuis n8n,
 * Make, Zapier, GitHub, Stripe ou tout système capable d'appeler une URL.
 * Aucune session requise : le token (32 hex, généré côté serveur) fait
 * office d'identifiant. La réponse est immédiate (202) : l'agent travaille
 * en tâche de fond et notifie l'utilisateur à la fin.
 */

interface RouteContext { params: Promise<{ token: string }> }

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: RouteContext) {
  const { token } = await context.params;
  if (!/^[a-f0-9]{16,120}$/.test(token)) {
    return NextResponse.json({ error: "Token invalide." }, { status: 400 });
  }

  // Limiteur par token : un webhook ne doit pas pouvoir marteler l'agent.
  const limit = rateLimit(`agent-webhook:${token}`, { limit: 20, windowMs: 60 * 60 * 1000 });
  if (!limit.allowed) {
    return NextResponse.json({ error: "Trop de déclenchements pour ce webhook." }, { status: 429 });
  }

  let payload: unknown = undefined;
  const rawBody = await request.text().catch(() => "");
  if (rawBody.trim()) {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      // Payload non JSON : transmis comme texte brut tronqué.
      payload = { raw: rawBody.slice(0, 4_000) };
    }
  }

  try {
    const result = await triggerScheduleByWebhookToken(token, payload);
    if (!result.accepted) {
      return NextResponse.json(
        { error: "L'agent a déjà une exécution en cours — déclenchement ignoré.", scheduleId: result.scheduleId },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, executionId: result.executionId, status: "accepted" }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook trigger failed";
    const status = message.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(_request: NextRequest, context: RouteContext) {
  // Sonde de santé pratique pour vérifier l'URL depuis n8n/Make.
  const { token } = await context.params;
  if (!/^[a-f0-9]{16,120}$/.test(token)) {
    return NextResponse.json({ error: "Token invalide." }, { status: 400 });
  }
  return NextResponse.json({ ok: true, usage: "POST pour déclencher la mission de l'agent." });
}
