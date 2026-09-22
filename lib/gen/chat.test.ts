import { describe, expect, it } from "vitest";

import { isSafeGenConnectorSlug } from "./chat";

/**
 * Garde-fou de l'isolement de Gen : les actions connecteurs autorisées sont
 * STRICTEMENT en lecture. Toute action d'écriture/effacement/envoi doit être
 * rejetée, quel que soit son préfixe.
 */
describe("gen — allowlist d'actions connecteurs (lecture stricte)", () => {
  it("accepte les actions de lecture typiques", () => {
    expect(isSafeGenConnectorSlug("GMAIL_SEARCH_EMAILS")).toBe(true);
    expect(isSafeGenConnectorSlug("GOOGLEDRIVE_LIST_FILES")).toBe(true);
    expect(isSafeGenConnectorSlug("SLACK_GET_CHANNEL_HISTORY")).toBe(true);
    expect(isSafeGenConnectorSlug("NOTION_FETCH_PAGE")).toBe(true);
    expect(isSafeGenConnectorSlug("GITHUB_LIST_REPOSITORIES")).toBe(true);
  });

  it("rejette les écritures, envois, suppressions et déguisements", () => {
    expect(isSafeGenConnectorSlug("GMAIL_SEND_EMAIL")).toBe(false);
    expect(isSafeGenConnectorSlug("GMAIL_DELETE_EMAIL")).toBe(false);
    expect(isSafeGenConnectorSlug("NOTION_CREATE_PAGE")).toBe(false);
    expect(isSafeGenConnectorSlug("SLACK_POST_MESSAGE")).toBe(false);
    expect(isSafeGenConnectorSlug("GOOGLEDRIVE_UPLOAD_FILE")).toBe(false);
    expect(isSafeGenConnectorSlug("READ_THEN_DELETE")).toBe(false);
    expect(isSafeGenConnectorSlug("LIST_REPOS_GITHUB_CREATE_REPOSITORY")).toBe(false);
  });

  it("rejette les slugs sans préfixe de lecture explicite", () => {
    expect(isSafeGenConnectorSlug("EMAILS")).toBe(false);
    expect(isSafeGenConnectorSlug("")).toBe(false);
  });
});
