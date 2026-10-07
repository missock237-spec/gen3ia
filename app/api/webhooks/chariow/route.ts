import crypto from "node:crypto";
import {
  buildChariowPayloadSnapshot,
  claimChariowDelivery,
  processChariowSale,
  type ChariowWebhookPayload,
} from "@/lib/billing/chariow-delivery";

/**
 * Adaptateur HTTP fin du webhook Chariow Pulse (Task 104-b) : vérification de
 * signature → claim transactionnel → traitement. Toute la logique de
 * livraison (bail, reprise des échecs, dédoublonnement par saleId, snapshot
 * de charge utile) vit dans lib/billing/chariow-delivery.ts, partagé avec le
 * rapprochement admin /api/admin/billing/reconcile.
 */

function verifySignature(raw: string, received: string | null): boolean {
  const secret = process.env.CHARIOW_PULSE_SECRET?.trim();
  if (!secret || !received?.startsWith("sha256=")) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get("x-chariow-signature"))) {
    return new Response("Invalid signature", { status: 401 });
  }

  const deliveryId = request.headers.get("x-pulse-delivery-id");
  const event = request.headers.get("x-pulse-event");
  if (!deliveryId) return new Response("Missing delivery id", { status: 400 });

  let payload: ChariowWebhookPayload;
  try {
    payload = JSON.parse(raw) as ChariowWebhookPayload;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (event && event !== "successful.sale" && payload.event !== "successful.sale") {
    return Response.json({ received: true, ignored: true });
  }

  try {
    // Claim transactionnel : premier passage, reprise d'un échec, reprise
    // d'un bail expiré ou refus d'un traitement déjà en cours/terminé.
    const claim = await claimChariowDelivery(deliveryId, buildChariowPayloadSnapshot(payload));
    if (claim.action === "duplicate-processed") return Response.json({ received: true, duplicate: true });
    if (claim.action === "in-flight") {
      // Un autre worker traite déjà cette livraison : 202 (pas un échec —
      // Chariow n'a pas besoin de re-delivrer tout de suite).
      return Response.json({ received: true, inFlight: true }, { status: 202 });
    }

    const result = await processChariowSale(payload, deliveryId);
    switch (result.kind) {
      case "extension_purchase":
        return Response.json({ received: true, kind: "extension_purchase", granted: result.granted });
      case "ignored":
        return Response.json({ received: true, ignored: true });
      case "duplicate_sale":
        // La vente a déjà été créditée via une autre livraison (même saleId).
        return Response.json({ received: true, duplicate: true });
      case "user_not_found":
        return Response.json({ received: true, credited: false, reason: "user_not_found" });
      case "credited":
        return Response.json({ received: true, credited: true, wallet: result.wallet });
      case "failed":
        return new Response("Webhook processing failed", { status: 500 });
    }
  } catch {
    // Panne d'infrastructure (claim ou écriture d'échec impossibles) : 500
    // retentable — Chariow re-delivrera et le claim reprendra le document.
    return new Response("Webhook processing failed", { status: 500 });
  }
}
