import { createHmac, randomUUID } from "node:crypto";
import { billUsage } from "@/lib/billing/media-meter";
import { listActiveEndpointsForEvent, type OutgoingWebhookEvent } from "./store";

/**
 * Émission d'événements Gen3ia vers les endpoints de webhooks sortants.
 *
 * Chaque livraison est :
 *  - signée : en-tête `X-Gen3ia-Signature: sha256=<hmac(body, secret)>` ;
 *  - météorée via COST_WEBHOOK_EUR (rejet silencieux si wallet insuffisant,
 *    un webhook ne doit jamais bloquer un flux métier) ;
 *  - isolée : l'échec d'un endpoint n'affecte pas les autres ni l'appelant.
 */

const DELIVERY_TIMEOUT_MS = 8_000;

export interface DeliveryResult {
  endpointId: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export function signWebhookPayload(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export async function emitOutgoingEvent(params: {
  userId: string;
  event: OutgoingWebhookEvent;
  payload: Record<string, unknown>;
}): Promise<DeliveryResult[]> {
  if (!params.userId?.trim()) throw new Error("userId is required.");
  const endpoints = await listActiveEndpointsForEvent(params.userId, params.event);
  if (endpoints.length === 0) return [];

  const deliveryId = randomUUID();
  const body = JSON.stringify({
    event: params.event,
    deliveryId,
    occurredAt: new Date().toISOString(),
    data: params.payload,
  });

  return Promise.all(
    endpoints.map(async (endpoint): Promise<DeliveryResult> => {
      try {
        await billUsage({
          userId: params.userId,
          executionId: `whk_${deliveryId}`,
          kind: "webhook",
          quantity: 1,
          metadata: { event: params.event, endpointId: endpoint.id },
        }).catch(() => {
          /* wallet insuffisant : la livraison continue (usage dérisoire) */
        });

        const response = await fetch(endpoint.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "Gen3ia-Webhooks/1.0",
            "x-gen3ia-event": params.event,
            "x-gen3ia-delivery": deliveryId,
            "x-gen3ia-signature": signWebhookPayload(endpoint.secret, body),
          },
          body,
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });
        return { endpointId: endpoint.id, ok: response.ok, status: response.status };
      } catch (error) {
        return {
          endpointId: endpoint.id,
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 200) : "delivery failed",
        };
      }
    }),
  );
}

/** Variante fire-and-forget pour les hooks de cycle de vie (jamais bloquante). */
export function emitOutgoingEventSafe(params: { userId: string; event: OutgoingWebhookEvent; payload: Record<string, unknown> }): void {
  emitOutgoingEvent(params).catch(() => undefined);
}
