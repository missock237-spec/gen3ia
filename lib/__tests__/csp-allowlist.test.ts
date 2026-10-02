import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { cspAuthorizesAny, cspHasToken } from "../../scripts/lib/csp-probe.mjs";

/**
 * Verrou CSP (Task 60, priorité #4) : la CSP PRINCIPALE (middleware.ts,
 * toute l'application authentifiée) n'autorise plus `https:`/`wss:` ouverts
 * dans connect-src — allowlist explicite des domaines réellement appelés
 * par le navigateur (Firebase, Sentry, AdSense). La CSP ARTEFACT conserve
 * un connect-src ouvert VOLONTAIRE (apps générées dans une iframe d'origine
 * opaque — exception documentée dans le source).
 *
 * Pattern d'assertion de source (cf. billing/low-balance.test.ts) : le
 * verrou porte sur le source lui-même — inattaquable par refactorisation
 * silencieuse.
 */

const middlewareSrc = readFileSync(new URL("../../middleware.ts", import.meta.url), "utf8");
const requestSecuritySrc = readFileSync(new URL("../security/request-security.ts", import.meta.url), "utf8");

/** Extrait la valeur de la directive connect-src d'un bloc CSP concaténé. */
function extractConnectSrc(cspString: string): string[] {
  const directive = cspString.split(";").find((part) => part.trim().startsWith("connect-src"));
  return directive ? directive.trim().split(/\s+/).slice(1) : [];
}

/** Lit un bloc CSP du middleware et le reconstruit en chaîne unique (sans commentaires). */
function readCspBlock(constName: string): string {
  const marker = `const ${constName} = [`;
  const start = middlewareSrc.indexOf(marker);
  expect(start >= 0, `CSP ${constName} introuvable dans middleware.ts`).toBe(true);
  const end = middlewareSrc.indexOf("].join('; ')", start);
  expect(end > start, `fin du bloc ${constName} introuvable`).toBe(true);
  const block = middlewareSrc.slice(start + marker.length, end);
  const withoutComments = block.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  return withoutComments.replace(/",\s*"/g, "; ").replace(/"/g, "");
}

describe("CSP principale — allowlist connect-src (Task 60)", () => {
  const csp = readCspBlock("CONTENT_SECURITY_POLICY");
  const sources = extractConnectSrc(csp);

  it("plus AUCUN joker schéma https: / wss: dans la CSP principale", () => {
    expect(sources, "le joker https: doit disparaître de la CSP principale").not.toContain("https:");
    expect(sources, "le joker wss: doit disparaître de la CSP principale").not.toContain("wss:");
    expect(sources).toContain("'self'");
  });

  it("Firebase (auth client) : googleapis, gstatic, apis.google.com, canaux wss bornés", () => {
    expect(sources).toContain("https://*.googleapis.com");
    expect(sources).toContain("https://www.gstatic.com");
    expect(sources).toContain("https://apis.google.com");
    expect(sources).toContain("wss://*.googleapis.com");
    expect(sources).toContain("wss://*.firebaseio.com");
  });

  it("Sentry navigateur : hôtes d'ingestion autorisés exactement", () => {
    expect(sources).toContain("https://o4511820262473728.ingest.de.sentry.io");
    expect(sources).toContain("https://ingest.de.sentry.io");
    expect(sources).toContain("https://ingest.sentry.io");
  });

  it("AdSense : beacons googlesyndication/doubleclick/googleadservices", () => {
    expect(sources).toContain("https://pagead2.googlesyndication.com");
    expect(sources).toContain("https://*.googlesyndication.com");
    expect(sources).toContain("https://*.doubleclick.net");
    expect(sources).toContain("https://*.googleadservices.com");
  });

  it("sondes csp-probe : les hôtes critiques restent vérifiables par token exact", () => {
    expect(cspHasToken(csp, "'self'")).toBe(true);
    // *.googleapis.com autorise les sous-domaines Firebase par variantes de token.
    expect(cspAuthorizesAny(csp, "googleapis.com")).toBe(true);
    expect(cspAuthorizesAny(csp, "o4511820262473728.ingest.de.sentry.io")).toBe(true);
    expect(cspAuthorizesAny(csp, "pagead2.googlesyndication.com")).toBe(true);
    expect(cspAuthorizesAny(csp, "googleads.g.doubleclick.net")).toBe(true);
    // Un hôte piégé NON autorisé doit rester refusé (anti sous-chaîne).
    expect(cspAuthorizesAny(csp, "attacker.io")).toBe(false);
    expect(cspAuthorizesAny(csp, "evil-doubleclick.net.attacker.io")).toBe(false);
  });
});

describe("CSP ARTEFACT — exception documentée (Task 60)", () => {
  it("conserve le connect-src ouvert des apps générées, avec la justification en source", () => {
    const artefact = readCspBlock("ARTEFACT_CONTENT_SECURITY_POLICY");
    const sources = extractConnectSrc(artefact);
    expect(sources).toContain("https:");
    // La décision est DOCUMENTÉE (sandbox origine opaque) — pas un oubli.
    expect(middlewareSrc).toMatch(/connect-src ouvert VOLONTAIRE/);
  });
});

describe("securityHeaders (réponses JSON de garde) — connect-src fermé", () => {
  it("request-security.ts : 'self' uniquement", () => {
    expect(requestSecuritySrc).toContain("connect-src 'self'");
    expect(requestSecuritySrc).not.toMatch(/connect-src 'self' https:/);
  });
});
