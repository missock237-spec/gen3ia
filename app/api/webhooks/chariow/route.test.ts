import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Adaptateur HTTP du webhook Chariow (Task 104-b) — contrat conservé :
 * 401 signature invalide, 400 delivery id / JSON invalides, réponses JSON
 * identiques, 500 sur échec de traitement, 202 pour un traitement in-flight
 * (évolution demandée par 104-b : l'ancien code répondait « duplicate »).
 * La logique de livraison est mockée ici : couverte par
 * lib/billing/chariow-delivery.test.ts.
 */

const claimChariowDeliveryMock = vi.fn();
const processChariowSaleMock = vi.fn();
const buildSnapshotMock = vi.fn((payload: unknown) => payload);

vi.mock("@/lib/billing/chariow-delivery", () => ({
  claimChariowDelivery: (...args: unknown[]) => claimChariowDeliveryMock(...args),
  processChariowSale: (...args: unknown[]) => processChariowSaleMock(...args),
  buildChariowPayloadSnapshot: (...args: unknown[]) => buildSnapshotMock(...args),
}));

import { POST } from "./route";

const SECRET = "pulse-secret-test";
const RAW = JSON.stringify({ event: "successful.sale", customer: { email: "c@x.io" }, sale: { id: "sale-1" } });
const WALLET = { userId: "user-1", currency: "XAF", balanceMinor: 303_000 };

function signedRequest(raw: string, headers: Record<string, string> = {}): Request {
  const signature = `sha256=${crypto.createHmac("sha256", SECRET).update(raw, "utf8").digest("hex")}`;
  return new Request("https://gen3ia.local/api/webhooks/chariow", {
    method: "POST",
    headers: { "x-chariow-signature": signature, ...headers },
    body: raw,
  });
}

function deliveredRequest(raw = RAW, headers: Record<string, string> = {}): Request {
  return signedRequest(raw, {
    "x-pulse-delivery-id": "delivery-1",
    "x-pulse-event": "successful.sale",
    ...headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CHARIOW_PULSE_SECRET = SECRET;
  claimChariowDeliveryMock.mockResolvedValue({ action: "process" });
});

afterEach(() => {
  delete process.env.CHARIOW_PULSE_SECRET;
});

describe("POST /api/webhooks/chariow — garde HTTP", () => {
  it("401 sans signature, signature invalide ou secret absent", async () => {
    const unsigned = new Request("https://gen3ia.local/api/webhooks/chariow", {
      method: "POST",
      headers: { "x-pulse-delivery-id": "delivery-1" },
      body: RAW,
    });
    expect((await POST(unsigned)).status).toBe(401);

    const forged = signedRequest(RAW, { "x-chariow-signature": "sha256=" + "0".repeat(64) });
    expect((await POST(forged)).status).toBe(401);

    delete process.env.CHARIOW_PULSE_SECRET;
    expect((await POST(deliveredRequest())).status).toBe(401);
    expect(claimChariowDeliveryMock).not.toHaveBeenCalled();
  });

  it("400 si le delivery id manque (après signature valide)", async () => {
    const response = await POST(signedRequest(RAW));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Missing delivery id");
    expect(claimChariowDeliveryMock).not.toHaveBeenCalled();
  });

  it("400 si le corps n'est pas du JSON valide", async () => {
    const response = await POST(deliveredRequest("not-json"));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid JSON");
    expect(claimChariowDeliveryMock).not.toHaveBeenCalled();
  });

  it("événement non successful.sale (entête ET charge utile) → ignoré sans claim ni traitement", async () => {
    const raw = JSON.stringify({ event: "sale.refunded", sale: { id: "sale-x" } });
    const response = await POST(deliveredRequest(raw, { "x-pulse-event": "sale.refunded" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, ignored: true });
    expect(claimChariowDeliveryMock).not.toHaveBeenCalled();
    expect(processChariowSaleMock).not.toHaveBeenCalled();
  });

  it("le claim reçoit le snapshot sérialisable de la charge utile", async () => {
    await POST(deliveredRequest());
    expect(claimChariowDeliveryMock).toHaveBeenCalledWith(
      "delivery-1",
      expect.objectContaining({ sale: { id: "sale-1" } }),
    );
  });
});

describe("POST /api/webhooks/chariow — mapping du claim", () => {
  it("duplicate-processed → 200 { received, duplicate }", async () => {
    claimChariowDeliveryMock.mockResolvedValue({ action: "duplicate-processed" });
    const response = await POST(deliveredRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, duplicate: true });
    expect(processChariowSaleMock).not.toHaveBeenCalled();
  });

  it("in-flight → 202 { received, inFlight } (aucun retraitement)", async () => {
    claimChariowDeliveryMock.mockResolvedValue({ action: "in-flight" });
    const response = await POST(deliveredRequest());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ received: true, inFlight: true });
    expect(processChariowSaleMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/chariow — mapping du résultat de traitement", () => {
  it.each([
    [
      "credited",
      { kind: "credited", wallet: WALLET },
      200,
      { received: true, credited: true, wallet: WALLET },
    ],
    [
      "duplicate_sale",
      { kind: "duplicate_sale" },
      200,
      { received: true, duplicate: true },
    ],
    [
      "user_not_found",
      { kind: "user_not_found" },
      200,
      { received: true, credited: false, reason: "user_not_found" },
    ],
    [
      "extension_purchase",
      { kind: "extension_purchase", granted: true },
      200,
      { received: true, kind: "extension_purchase", granted: true },
    ],
    [
      "ignored",
      { kind: "ignored" },
      200,
      { received: true, ignored: true },
    ],
  ] as const)("résultat %s → réponse dédiée", async (_kind, result, status, body) => {
    processChariowSaleMock.mockResolvedValue(result);
    const response = await POST(deliveredRequest());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  });

  it("résultat failed → 500 « Webhook processing failed » (re-delivrance Chariow)", async () => {
    processChariowSaleMock.mockResolvedValue({ kind: "failed", error: "boom" });
    const response = await POST(deliveredRequest());
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Webhook processing failed");
  });

  it("panne d'infrastructure (claim) → 500 retentable", async () => {
    claimChariowDeliveryMock.mockRejectedValue(new Error("firestore indisponible"));
    const response = await POST(deliveredRequest());
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Webhook processing failed");
  });
});
