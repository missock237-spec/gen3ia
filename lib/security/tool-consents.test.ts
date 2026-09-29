import { describe, expect, it } from "vitest";

import { consentCategoryForTool, decideConsent } from "./tool-consents";
import { CONSENT_CATEGORIES } from "./tool-consents";

describe("consentCategoryForTool — cartographie des catégories", () => {
  it("les appels externes relèvent d'external_apps", () => {
    expect(consentCategoryForTool("composio.execute")).toBe("external_apps");
    expect(consentCategoryForTool("web.api.write")).toBe("external_apps");
    // email.send est envoyé par la plateforme (Resend) : pas un appel à une
    // application externe au nom de l'utilisateur (modèle tool-permissions).
    expect(consentCategoryForTool("email.send")).toBeNull();
    expect(consentCategoryForTool("ext.abc123.send_message")).toBe("external_apps");
  });

  it("code/terminal → code_execution ; caméra → camera", () => {
    expect(consentCategoryForTool("code.execute")).toBe("code_execution");
    expect(consentCategoryForTool("terminal.execute")).toBe("code_execution");
    expect(consentCategoryForTool("camera.capture")).toBe("camera");
  });

  it("les destructeurs hors code → destructive", () => {
    expect(consentCategoryForTool("file.delete")).toBe("destructive");
  });

  it("les lectures internes/neutres ne sont pas concernées", () => {
    expect(consentCategoryForTool("web.search")).toBeNull();
    expect(consentCategoryForTool("memory.read")).toBeNull();
    expect(consentCategoryForTool("schedule.create")).toBeNull();
    expect(consentCategoryForTool("outil-inconnu")).toBeNull();
  });
});

describe("decideConsent — décision", () => {
  it("défaut ask : autorisé, sans pré-approbation", () => {
    const decision = decideConsent("composio.execute", {});
    expect(decision).toEqual({ category: "external_apps", mode: "ask", allowed: true, preApproved: false });
  });

  it("deny bloque avant toute exécution", () => {
    const decision = decideConsent("composio.execute", { external_apps: "deny" });
    expect(decision.allowed).toBe(false);
  });

  it("always pré-approuve UNIQUEMENT external_apps", () => {
    expect(decideConsent("composio.execute", { external_apps: "always" }).preApproved).toBe(true);
    expect(decideConsent("code.execute", { code_execution: "always" }).preApproved).toBe(false);
    expect(decideConsent("camera.capture", { camera: "always" }).preApproved).toBe(false);
    expect(decideConsent("file.delete", { destructive: "always" }).preApproved).toBe(false);
  });

  it("les outils non concernés passent toujours", () => {
    const decision = decideConsent("web.search", { external_apps: "deny" });
    expect(decision).toEqual({ category: null, mode: "ask", allowed: true, preApproved: false });
  });

  it("le catalogue de catégories est complet", () => {
    expect(CONSENT_CATEGORIES).toEqual(["external_apps", "code_execution", "camera", "destructive"]);
  });
});
