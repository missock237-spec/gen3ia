import { describe, expect, it } from "vitest";

import {
  AUTHORIZATION_MODES,
  AUTO_APPROVAL_AUDIT_REASON,
  DEFAULT_AUTHORIZATION_MODE,
  authorizationModeLabel,
  isAuthorizationMode,
  isAutoApprovable,
  isNeverAutoApprove,
} from "./authorization-mode";

describe("modes d'autorisation (sélecteur « Toujours demander ▼ »)", () => {
  it("expose exactement les trois modes de la maquette", () => {
    expect(AUTHORIZATION_MODES.map((item) => item.id)).toEqual(["always_ask", "ask_if_needed", "auto_allow"]);
    expect(AUTHORIZATION_MODES.map((item) => item.label)).toEqual([
      "Toujours demander",
      "Demander si nécessaire",
      "Autoriser automatiquement",
    ]);
    expect(DEFAULT_AUTHORIZATION_MODE).toBe("always_ask");
  });

  it("valide les modes reçus du client", () => {
    expect(isAuthorizationMode("auto_allow")).toBe(true);
    expect(isAuthorizationMode("always_ask")).toBe(true);
    expect(isAuthorizationMode("ask_if_needed")).toBe(true);
    expect(isAuthorizationMode("toujours")).toBe(false);
    expect(isAuthorizationMode(undefined)).toBe(false);
    expect(isAuthorizationMode(null)).toBe(false);
  });

  it("protège les outils critiques, même en mode automatique", () => {
    expect(isNeverAutoApprove("ads.publish")).toBe(true);
    expect(isNeverAutoApprove("file.delete")).toBe(true);
    expect(isNeverAutoApprove("phone.call")).toBe(true);
    // Outils non critiques : auto-approuvables en mode auto_allow.
    expect(isNeverAutoApprove("web.search")).toBe(false);
    expect(isNeverAutoApprove("composio.execute")).toBe(false);
    expect(isNeverAutoApprove("file.read")).toBe(false);
  });

  it("fournit un label lisible avec repli sûr", () => {
    expect(authorizationModeLabel("always_ask")).toBe("Toujours demander");
    expect(authorizationModeLabel("auto_allow")).toBe("Autoriser automatiquement");
  });

  it("trace l'audit des approbations automatiques", () => {
    expect(AUTO_APPROVAL_AUDIT_REASON).toContain("auto_allow");
    expect(AUTO_APPROVAL_AUDIT_REASON.length).toBeGreaterThan(20);
  });

  describe("isAutoApprovable (moteur conversationnel + agent chat)", () => {
    it("n'auto-approuve que le mode auto_allow", () => {
      expect(isAutoApprovable("auto_allow", "composio.execute", "high")).toBe(true);
      expect(isAutoApprovable("always_ask", "composio.execute", "high")).toBe(false);
      expect(isAutoApprovable("ask_if_needed", "composio.execute", "high")).toBe(false);
      expect(isAutoApprovable(undefined, "composio.execute", "high")).toBe(false);
    });

    it("respecte le plancher : outils critiques et risque critical jamais contournés", () => {
      expect(isAutoApprovable("auto_allow", "ads.publish", "high")).toBe(false);
      expect(isAutoApprovable("auto_allow", "file.delete", "high")).toBe(false);
      expect(isAutoApprovable("auto_allow", "phone.call", "high")).toBe(false);
      expect(isAutoApprovable("auto_allow", "composio.execute", "critical")).toBe(false);
      // Outil externe non critique : auto-approuvable.
      expect(isAutoApprovable("auto_allow", "email.send", "high")).toBe(true);
    });
  });
});
