import { describe, expect, it } from "vitest";
import { getMessagingChannelStatus, normalizeWhatsAppRecipient } from "./index";
import { buildRemoteApprovalLinks, signRemoteApprovalToken, verifyRemoteApprovalToken } from "./remote-approval";

describe("messaging", () => {
  it("normalise les numéros WhatsApp", () => {
    expect(normalizeWhatsAppRecipient("+237 690-000-000")).toBe("+237690000000");
    expect(normalizeWhatsAppRecipient("(0)1 42 68 53 00")).toBe("0142685300");
  });

  it("ne signale aucun canal sans variables d'environnement", () => {
    const previous = { ...process.env };
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    const status = getMessagingChannelStatus();
    expect(status).toEqual({ whatsapp: false, telegram: false, slack: false });
    process.env = previous;
  });
});

describe("remote approval tokens (HMAC)", () => {
  const payload = { approvalId: "approval-1", ownerId: "user-1", expiresAt: Date.now() + 60_000 };

  it("valide un token signé", () => {
    const token = signRemoteApprovalToken(payload);
    const verified = verifyRemoteApprovalToken(token);
    expect(verified).toEqual(payload);
  });

  it("rejette un token altéré", () => {
    const token = signRemoteApprovalToken(payload);
    const tampered = `${token.slice(0, -4)}AAAA`;
    expect(verifyRemoteApprovalToken(tampered)).toBeNull();
  });

  it("rejette un token expiré", () => {
    const expired = { ...payload, expiresAt: Date.now() - 1_000 };
    const token = signRemoteApprovalToken(expired);
    expect(verifyRemoteApprovalToken(token)).toBeNull();
  });

  it("rejette les formats invalides", () => {
    expect(verifyRemoteApprovalToken("")).toBeNull();
    expect(verifyRemoteApprovalToken("pas-un-token")).toBeNull();
    expect(verifyRemoteApprovalToken("a.b.c")).toBeNull();
  });

  it("génère des liens web Approuver/Refuser partageant le token", () => {
    const links = buildRemoteApprovalLinks("approval-9", "user-9", Date.now() + 60_000);
    expect(links.approveUrl).toContain("/approvals/approval-9?token=");
    const token = new URL(links.approveUrl).searchParams.get("token") ?? "";
    expect(verifyRemoteApprovalToken(token)?.approvalId).toBe("approval-9");
  });
});
