import { describe, expect, it } from "vitest";

import { ConnectorMissingError, parseConnectorMissing, uniqueToolkits } from "./errors";

/**
 * Task 143 — axe 1 : l'erreur CONNECTOR_MISSING doit survivre à la
 * stringification du sérialiseur d'outils (executeTool ne conserve que
 * error.message) : le marqueur en tête du message fait la round-trip.
 */
describe("ConnectorMissingError", () => {
  it("porte le marqueur sérialisable et le toolkit", () => {
    const error = new ConnectorMissingError("Notion");
    expect(error.code).toBe("CONNECTOR_MISSING");
    expect(error.toolkit).toBe("notion");
    expect(error.message).toContain("[CONNECTOR_MISSING:notion]");
    expect(error).toBeInstanceOf(Error);
  });

  it("normalise le toolkit (espaces, casse)", () => {
    const error = new ConnectorMissingError("  GoogleDrive  ");
    expect(error.toolkit).toBe("googledrive");
  });
});

describe("parseConnectorMissing", () => {
  it("reconnaît un message stringifié et retourne le toolkit", () => {
    const message = new ConnectorMissingError("slack").message;
    expect(parseConnectorMissing(message)).toEqual({ toolkit: "slack" });
  });

  it("reconnaît le marqueur où qu'il soit dans le message", () => {
    const message = `Échec de l'outil : ${new ConnectorMissingError("gmail").message} (étape 2/3)`;
    expect(parseConnectorMissing(message)).toEqual({ toolkit: "gmail" });
  });

  it("rejette les erreurs d'une autre nature", () => {
    expect(parseConnectorMissing("Le serveur MCP a répondu 500")).toBeNull();
    expect(parseConnectorMissing("Outil inconnu : web.fetch")).toBeNull();
    expect(parseConnectorMissing("")).toBeNull();
    expect(parseConnectorMissing(null)).toBeNull();
    expect(parseConnectorMissing(undefined)).toBeNull();
  });

  it("rejette un toolkit malformé dans le marqueur", () => {
    expect(parseConnectorMissing("[CONNECTOR_MISSING:x] court")).toBeNull();
    expect(parseConnectorMissing("[CONNECTOR_MISSING:BAD-SLUG] casse")).toBeNull();
    expect(parseConnectorMissing("[CONNECTOR_MISSING:missing-bracket")).toBeNull();
  });
});

describe("uniqueToolkits", () => {
  it("déduplique et normalise en préservant l'ordre", () => {
    expect(uniqueToolkits(["Gmail", "gmail", " Slack ", "slack", ""])).toEqual(["gmail", "slack"]);
  });

  it("rejette les slugs invalides", () => {
    expect(uniqueToolkits(["ok", "a", "A B", "with space"])).toEqual(["ok"]);
  });
});
