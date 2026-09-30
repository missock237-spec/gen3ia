import { describe, expect, it } from "vitest";

import { readNextRedirect, sanitizeRedirect } from "./auth-client";

/**
 * sanitizeRedirect — barrière anti open-redirect de la connexion Gen3ia
 * (audit CodeQL js/client-side-unvalidated-url-redirection). N'accepte que
 * les chemins internes réellement same-origin : le parseur WHATWG convertit
 * "\" en "/", donc "/\evil.com" était autrefois interprété comme
 * "//evil.com" — redirection protocol-relative vers un domaine tiers.
 */

describe("sanitizeRedirect — seuls les chemins internes survivent", () => {
  it("chemins internes légitimes : préservés à l'identique", () => {
    expect(sanitizeRedirect("/studio")).toBe("/studio");
    expect(sanitizeRedirect("/workspace/conversations/abc?x=1")).toBe("/workspace/conversations/abc?x=1");
    expect(sanitizeRedirect("/billing")).toBe("/billing");
  });

  it("URL absolues et protocol-relatives : rejetées", () => {
    expect(sanitizeRedirect("https://evil.example")).toBeNull();
    expect(sanitizeRedirect("http://evil.example/path")).toBeNull();
    expect(sanitizeRedirect("//evil.example")).toBeNull();
    expect(sanitizeRedirect("javascript:alert(1)")).toBeNull();
    expect(sanitizeRedirect("data:text/html,<script>")).toBeNull();
  });

  it("contournement backslash du parseur WHATWG : rejeté (le fix central)", () => {
    expect(sanitizeRedirect("/\\evil.example")).toBeNull();
    expect(sanitizeRedirect("/\\\\evil.example")).toBeNull();
    expect(sanitizeRedirect("/\\/\\/evil.example")).toBeNull();
  });

  it("entrées vides : null (pas de redirection par défaut silencieuse)", () => {
    expect(sanitizeRedirect(null)).toBeNull();
    expect(sanitizeRedirect(undefined)).toBeNull();
    expect(sanitizeRedirect("")).toBeNull();
  });
});

describe("readNextRedirect (pur côté signature)", () => {
  it("exporte bien la fonction consommée par les pages de connexion", () => {
    expect(typeof readNextRedirect).toBe("function");
  });
});
