import { describe, expect, it } from "vitest";

import { cspAuthorizes, cspAuthorizesAny, cspHasToken, urlHasHost } from "./csp-probe.mjs";

describe("cspHasToken (token exact, plus jamais de sous-chaîne)", () => {
  const csp = "script-src 'self' https://apis.google.com https://www.gstatic.com; frame-src https://doubleclick.net";

  it("accepte un token exact d'une directive", () => {
    expect(cspHasToken(csp, "https://apis.google.com")).toBe(true);
    expect(cspHasToken(csp, "'self'")).toBe(true);
    expect(cspHasToken(csp, "https://doubleclick.net")).toBe(true);
  });

  it("refuse une sous-chaîne qui n'est pas un token (piège CodeQL fermé)", () => {
    const trap = "script-src 'self' https://evil-apis.google.com.attacker.io";
    expect(cspHasToken(trap, "https://apis.google.com")).toBe(false);
    const trap2 = "script-src 'self' https://notdoubleclick.net.evil.io";
    expect(cspHasToken(trap2, "https://doubleclick.net")).toBe(false);
  });

  it("les tokens avec guillemets sont distincts", () => {
    expect(cspHasToken("script-src 'unsafe-eval'", "'unsafe-eval'")).toBe(true);
    expect(cspHasToken("script-src 'unsafe-eval'", "unsafe-eval")).toBe(false);
  });

  it("gère les entrées dégénérées", () => {
    expect(cspHasToken("", "x")).toBe(false);
    expect(cspHasToken(undefined, "x")).toBe(false);
    expect(cspHasToken("a", "")).toBe(false);
  });
});

describe("cspAuthorizes (directive + source, égalité de token)", () => {
  it("trouve une source dans la directive demandée", () => {
    const csp = "script-src 'self' pagead2.googlesyndication.com; frame-src 'self' *.doubleclick.net";
    expect(cspAuthorizes(csp, "script-src", "pagead2.googlesyndication.com")).toBe(true);
    expect(cspAuthorizes(csp, "frame-src", "doubleclick.net")).toBe(true);
  });

  it("reconnaît les variantes schéma et wildcard de la production réelle", () => {
    const csp = "script-src 'self' https://pagead2.googlesyndication.com; frame-src https://*.doubleclick.net";
    expect(cspAuthorizes(csp, "script-src", "pagead2.googlesyndication.com")).toBe(true);
    expect(cspAuthorizes(csp, "frame-src", "doubleclick.net")).toBe(true);
    expect(cspAuthorizesAny(csp, "doubleclick.net")).toBe(true);
  });

  it("refuse une source présente dans une AUTRE directive", () => {
    const csp = "img-src pagead2.googlesyndication.com; script-src 'self'";
    expect(cspAuthorizes(csp, "script-src", "pagead2.googlesyndication.com")).toBe(false);
  });

  it("refuse les hôtes piégés par sous-chaîne", () => {
    const csp = "script-src 'self' https://pagead2.googlesyndication.com.evil.io";
    expect(cspAuthorizes(csp, "script-src", "pagead2.googlesyndication.com")).toBe(false);
  });

  it("insensible à la casse du nom de directive uniquement", () => {
    const csp = "Script-Src 'self' https://www.gstatic.com";
    expect(cspAuthorizes(csp, "script-src", "https://www.gstatic.com")).toBe(true);
  });

  it("frame-ancestors 'none' / 'self' en tokens avec guillemets", () => {
    expect(cspAuthorizes("frame-ancestors 'none'", "frame-ancestors", "'none'")).toBe(true);
    expect(cspAuthorizes("frame-ancestors 'self'", "frame-ancestors", "'self'")).toBe(true);
    expect(cspAuthorizes("frame-ancestors 'none'", "frame-ancestors", "'self'")).toBe(false);
  });
});

describe("cspAuthorizesAny (n'importe quelle directive, variantes incluses)", () => {
  it("matche la CSP de production réelle (schémas et wildcards)", () => {
    const prod = "script-src 'self' 'unsafe-inline' https://apis.google.com https://pagead2.googlesyndication.com https://*.googlesyndication.com https://*.doubleclick.net; frame-src 'self' https://accounts.google.com https://googleads.g.doubleclick.net https://*.doubleclick.net";
    expect(cspAuthorizesAny(prod, "pagead2.googlesyndication.com")).toBe(true);
    expect(cspAuthorizesAny(prod, "doubleclick.net")).toBe(true);
    expect(cspAuthorizesAny(prod, "apis.google.com")).toBe(true);
    expect(cspAuthorizesAny(prod, "evil-doubleclick.net.attacker.io")).toBe(false);
    expect(cspAuthorizesAny(prod, "notdoubleclick.net")).toBe(false);
  });

  it("refuse les entrées dégénérées", () => {
    expect(cspAuthorizesAny("", "x")).toBe(false);
    expect(cspAuthorizesAny(undefined, "x")).toBe(false);
    expect(cspAuthorizesAny("a b", "")).toBe(false);
  });
});

describe("urlHasHost (hôte exact ou sous-domaine délimité)", () => {
  it("accepte l'hôte exact et les sous-domaines légitimes", () => {
    expect(urlHasHost("https://accounts.google.com/o/oauth2?v=1", "accounts.google.com")).toBe(true);
    expect(urlHasHost("https://mail.accounts.google.com/x", "accounts.google.com")).toBe(true);
  });

  it("refuse les piégeages par sous-chaîne (CodeQL incomplete-url-substring)", () => {
    expect(urlHasHost("https://evil-accounts.google.com.x.io/popup", "accounts.google.com")).toBe(false);
    expect(urlHasHost("https://accounts.google.com.evil.io/", "accounts.google.com")).toBe(false);
    expect(urlHasHost("https://notaccounts.google.com.evil.io/", "accounts.google.com")).toBe(false);
  });

  it("refuse les entrées non URL", () => {
    expect(urlHasHost("pas une url", "accounts.google.com")).toBe(false);
    expect(urlHasHost("", "accounts.google.com")).toBe(false);
    expect(urlHasHost(null, "accounts.google.com")).toBe(false);
  });
});
