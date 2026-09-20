import { describe, expect, it } from "vitest";
import { isEmailProviderConfigured } from "./send";

describe("email agentique", () => {
  it("signale l'absence de configuration Resend", () => {
    const previous = { ...process.env };
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM_ADDRESS;
    expect(isEmailProviderConfigured()).toBe(false);
    process.env = previous;
  });

  it("détecte une configuration complète", () => {
    const previous = { ...process.env };
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM_ADDRESS = "agent@gen3ia.online";
    expect(isEmailProviderConfigured()).toBe(true);
    process.env = previous;
  });
});
