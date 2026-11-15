import { describe, expect, it } from "vitest";
import { assertActionAllowed, constantTimeEqual, createPairingToken, hashPairingToken } from "./security";
import { LiveActionSchema } from "./types";

describe("live agent security", () => {
  it("creates a token that can be verified by hash without storing plaintext", () => {
    const token = createPairingToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(hashPairingToken(token)).not.toBe(token);
    expect(constantTimeEqual(hashPairingToken(token), hashPairingToken(token))).toBe(true);
    expect(constantTimeEqual(hashPairingToken(token), hashPairingToken(`${token}x`))).toBe(false);
  });

  it("enforces input permissions for every control action", () => {
    const mouseMove = LiveActionSchema.parse({ type: "mouse.move", x: 10, y: 20 });
    expect(() => assertActionAllowed(mouseMove, ["screen.read"])).toThrow("input.mouse");
    expect(() => assertActionAllowed(mouseMove, ["screen.read", "input.mouse"])).not.toThrow();

    const keyboard = LiveActionSchema.parse({ type: "keyboard.key", key: "Enter" });
    expect(() => assertActionAllowed(keyboard, ["screen.read"])).toThrow("input.keyboard");
  });

  it("rejects invalid or unsafe coordinate payloads", () => {
    expect(() => LiveActionSchema.parse({ type: "mouse.move", x: -1, y: 10 })).toThrow();
    expect(() => LiveActionSchema.parse({ type: "mouse.move", x: Number.NaN, y: 10 })).toThrow();
    expect(() => LiveActionSchema.parse({ type: "keyboard.type", text: "a".repeat(10001) })).toThrow();
  });
});
