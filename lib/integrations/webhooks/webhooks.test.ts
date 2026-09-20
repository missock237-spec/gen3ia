import { describe, expect, it } from "vitest";
import { OUTGOING_WEBHOOK_EVENTS, WebhookEventsSchema, generateWebhookSecret } from "./store";
import { signWebhookPayload } from "./emit";
import { createHmac } from "node:crypto";

describe("webhooks sortants", () => {
  it("définit le contrat d'événements attendu", () => {
    expect(OUTGOING_WEBHOOK_EVENTS).toContain("approval.requested");
    expect(OUTGOING_WEBHOOK_EVENTS).toContain("test.ping");
    expect(OUTGOING_WEBHOOK_EVENTS.length).toBeGreaterThanOrEqual(6);
  });

  it("valide les listes d'événements", () => {
    expect(() => WebhookEventsSchema.parse(["approval.requested"])).not.toThrow();
    expect(() => WebhookEventsSchema.parse(["invented.event"])).toThrow();
    expect(() => WebhookEventsSchema.parse([])).toThrow();
  });

  it("génère des secrets suffisamment longs et uniques", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).toHaveLength(64);
    expect(a).not.toBe(b);
  });

  it("signe la charge utile avec HMAC-SHA256 vérifiable", () => {
    const secret = "secret-test";
    const body = JSON.stringify({ event: "test.ping" });
    const signature = signWebhookPayload(secret, body);
    expect(signature.startsWith("sha256=")).toBe(true);
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(signature).toBe(expected);
  });

  it("produit une signature différente pour un corps différent", () => {
    const signatureA = signWebhookPayload("secret-test", "body-a");
    const signatureB = signWebhookPayload("secret-test", "body-b");
    expect(signatureA).not.toBe(signatureB);
  });
});
