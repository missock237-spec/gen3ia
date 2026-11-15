import { createHmac } from "crypto";

import { NextRequest, NextResponse } from "next/server";

import { enforceRateLimit } from "@/lib/security/rate-limit";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { timingSafeStringEqual } from "@/lib/security/timing-safe";
import { triggerScheduleByWebhookToken } from "@/lib/agents/scheduler";

/**
 * Webhook ENTRANT « agent toujours actif » : un POST signé par le token
 * secret de la planification déclenche la mission de l'agent — depuis n8n,
 * Make, Zapier, GitHub, Stripe ou tout système capable d'appeler une URL.
 * Aucune session requise : le token (32 hex, généré côté serveur) fait
 * office d'identifiant. La réponse est immédiate (202) : l'agent travaille
 * en tâche de fond et notifie l'utilisateur à la fin.
 *
 * SIGNATURE HMAC-SHA256 (défense en profondeur sur le token d'URL) :
 *
 *   En-tête attendu : X-Gen3ia-Signature: sha256=<hex>
 *   où <hex> = HMAC-SHA256(clé = AGENT_TRIGGER_WEBHOOK_SECRET,
 *                          message = corps BRUT du POST, exactement tel
 *                          qu'émis — sans reformatage JSON)
 *   en hexadécimal minuscule. Vérification à temps constant
 *   (crypto.timingSafeEqual via lib/security/timing-safe.ts).
 *
 *   - AGENT_TRIGGER_WEBHOOK_SECRET CONFIGURÉ : la signature est
 *     OBLIGATOIRE — toute requête sans en-tête ou avec une signature
 *     invalide est rejetée 401 AVANT le compteur de débit. Le token
 *     d'URL reste requis en complément.
 *   - AGENT_TRIGGER_WEBHOOK_SECRET ABSENT : comportement historique
 *     conservé (token d'URL seul) ; un warning « signature HMAC non
 *     configurée » est loggé (une fois par instance) pour rappeler
 *     d'activer la signature.
 *
 * Exemple côté émetteur (n8n / shell) :
 *   SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | cut -d' ' -f2)
 *   curl -X POST "https://gen3ia.online/api/webhooks/agent-triggers/<token>" \
 *        -H "content-type: application/json" \
 *        -H "X-Gen3ia-Signature: sha256=$SIG" -d "$BODY"
 */

interface RouteContext { params: Promise<{ token: string }> }

export const runtime = "nodejs";

/** Warning « secret absent » loggé une seule fois par instance (pas de spam). */
let warningSignatureLogge = false;

/**
 * Vérifie la signature HMAC du corps brut. Retourne :
 *  - exigee : true si le secret est configuré (signature OBLIGATOIRE) ;
 *  - valide : la signature fournie correspond au corps brut.
 */
function verifierSignatureHmac(
  rawBody: string,
  enTete: string | null,
): { exigee: boolean; valide: boolean } {
  const secret = process.env.AGENT_TRIGGER_WEBHOOK_SECRET?.trim();
  if (!secret) {
    if (!warningSignatureLogge) {
      warningSignatureLogge = true;
      console.warn(
        "[agent-triggers] signature HMAC non configurée (AGENT_TRIGGER_WEBHOOK_SECRET absente) — repli sur le token d'URL seul.",
      );
    }
    return { exigee: false, valide: false };
  }

  const recue = enTete?.trim().toLowerCase() ?? "";
  if (!recue.startsWith("sha256=")) return { exigee: true, valide: false };

  const attendue = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  // Comparaison à temps constant : n'émet aucune information de timing
  // sur la position du premier octet divergent.
  return { exigee: true, valide: timingSafeStringEqual(recue, attendue) };
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { token } = await context.params;
  if (!/^[a-f0-9]{16,120}$/.test(token)) {
    return NextResponse.json({ error: "Token invalide." }, { status: 400 });
  }

  // Corps BRUT lu une seule fois : signé tel quel par l'émetteur (la
  // vérification HMAC porte sur ces octets exacts), puis parsé ensuite.
  const rawBody = await request.text().catch(() => "");

  // Signature AVANT le compteur de débit : une requête non signée ne
  // consomme pas le quota du webhook légitime (20 déclenchements/heure).
  const hmac = verifierSignatureHmac(rawBody, request.headers.get("x-gen3ia-signature"));
  if (hmac.exigee && !hmac.valide) {
    return NextResponse.json(
      {
        error:
          "Signature HMAC requise : en-tête X-Gen3ia-Signature: sha256=<hex>, HMAC-SHA256 du corps brut avec AGENT_TRIGGER_WEBHOOK_SECRET.",
      },
      { status: 401 },
    );
  }

  // Limiteur par token : un webhook ne doit pas pouvoir marteler l'agent.
  const limit = await enforceRateLimit(`agent-webhook:${token}`, { limit: 20, windowMs: 60 * 60 * 1000 });
  if (!limit.allowed) {
    return NextResponse.json({ error: "Trop de déclenchements pour ce webhook." }, { status: 429 });
  }

  let payload: unknown = undefined;
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
    // Classification canonique : 404 planning introuvable, repli 500.
    return NextResponse.json(errorBody(error, "Webhook trigger failed"), { status: errorStatus(error, 500) });
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
