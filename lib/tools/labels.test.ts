import { describe, expect, it } from "vitest";

import {
  approvalToolLabel,
  humanizeConnectorAction,
  humanizeTechnicalName,
  toolLabel,
} from "@/lib/tools/labels";

/**
 * Garde-fou « aucune référence aux outils internes » : tout identifiant
 * technique exposé à l'utilisateur doit passer par la couche libellés et
 * ne jamais apparaître brut dans l'interface.
 */
describe("libellés des outils (couche anti-référence interne)", () => {
  it("traduit les outils internes connus en français", () => {
    expect(toolLabel("web.search")).toBe("Recherche web");
    expect(toolLabel("composio.execute")).toBe("Application connectée");
    expect(toolLabel("mcp.call")).toBe("Outil externe connecté");
    expect(toolLabel("artifact.create")).toBe("Création de document");
    expect(toolLabel("voice.speak")).toBe("Génération de voix");
  });

  it("ne révèle jamais un identifiant brut inconnu", () => {
    const label = toolLabel("internal.secret_tool");
    expect(label).not.toContain(".");
    expect(label).not.toContain("_");
    expect(label).toBe("Internal Secret Tool");
  });

  it("gère les valeurs vides", () => {
    expect(toolLabel(null)).toBe("Outil interne");
    expect(toolLabel("")).toBe("Outil interne");
  });

  it("humanise une action de connecteur (slug Composio)", () => {
    expect(humanizeConnectorAction("GMAIL_SEND_EMAIL")).toBe("Gmail — send email");
    expect(humanizeConnectorAction("SLACK_POST_MESSAGE")).toBe("Slack — post message");
    expect(humanizeConnectorAction("NOTION")).toBe("Notion");
  });

  it("combine outil + action dans les approbations sans nom interne", () => {
    expect(approvalToolLabel("composio.execute", "GMAIL_SEND_EMAIL")).toBe("Gmail — send email");
    expect(approvalToolLabel("file.delete", null)).toBe("Suppression de fichier");
    expect(approvalToolLabel("mcp.call", "GITHUB_CREATE_ISSUE")).toBe("Github — create issue");
  });

  it("humanizeTechnicalName neutralise tous les séparateurs", () => {
    expect(humanizeTechnicalName("web.api")).toBe("Web Api");
    expect(humanizeTechnicalName("UNKNOWN_TOOL-X")).toBe("Unknown Tool X");
  });
});
