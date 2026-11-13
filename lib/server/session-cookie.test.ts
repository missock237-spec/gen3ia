import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_COOKIE_NAME,
  clearSessionCookieHeader,
  domaineSessionDepuisHote,
  sessionCookieHeader,
  signSessionPayload,
  verifySessionCookie,
} from "./session-cookie";

/**
 * Cookie de session inter-hôtes (fix 2026-11-13 — « gen3 construit la vidéo
 * mais il ne l'envoie jamais ») : le cookie était HOST-ONLY, une session
 * posée sur www.gen3ia.online n'était jamais envoyée aux liens médias
 * durables posés sur gen3ia.online (apex) dans les messages PERSISTÉS —
 * le clic renvoyait 401 et l'utilisateur ne voyait jamais sa vidéo.
 *
 * CONTRAT : en production, pour les hôtes gen3ia.online (apex ou www), le
 * cookie porte Domain=.gen3ia.online (valable aux deux hôtes). AUCUN autre
 * hôte (jamais .vercel.app, jamais localhost) et AUCUN changement en dev.
 */

const PAYLOAD = {
  uid: "u1",
  email: "u1@test.io",
  name: "Utilisateur 1",
  picture: null,
  provider: "r2-password",
};

describe("domaineSessionDepuisHote — attribut Domain pour les liens inter-hôtes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("production + apex gen3ia.online → Domain=.gen3ia.online", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(domaineSessionDepuisHote("gen3ia.online")).toBe(".gen3ia.online");
  });

  it("production + www.gen3ia.online → Domain=.gen3ia.online", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(domaineSessionDepuisHote("www.gen3ia.online")).toBe(".gen3ia.online");
  });

  it("production + hôte avec port → le port est nettoyé avant décision", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(domaineSessionDepuisHote("www.gen3ia.online:443")).toBe(".gen3ia.online");
  });

  it("production + hôte étranger (vercel.app preview) → AUCUN Domain (jamais de joker partagé)", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(domaineSessionDepuisHote("gen3ia.vercel.app")).toBeUndefined();
    expect(domaineSessionDepuisHote("evil.example.com")).toBeUndefined();
  });

  it("production + localhost → jamais d'attribut Domain", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(domaineSessionDepuisHote("localhost")).toBeUndefined();
    expect(domaineSessionDepuisHote("127.0.0.1")).toBeUndefined();
  });

  it("hors production → jamais d'attribut Domain (comportement historique conservé)", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(domaineSessionDepuisHote("gen3ia.online")).toBeUndefined();
    vi.stubEnv("NODE_ENV", "test");
    expect(domaineSessionDepuisHote("www.gen3ia.online")).toBeUndefined();
  });

  it("hôte absent/vide → undefined", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(domaineSessionDepuisHote(null)).toBeUndefined();
    expect(domaineSessionDepuisHote("")).toBeUndefined();
    expect(domaineSessionDepuisHote(undefined)).toBeUndefined();
  });
});

describe("sessionCookieHeader — l'attribut Domain est posé avec l'hôte de la requête", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("production gen3ia.online → Set-Cookie contient Domain=.gen3ia.online et reste vérifiable", () => {
    vi.stubEnv("NODE_ENV", "production");
    const header = sessionCookieHeader(PAYLOAD, "gen3ia.online");
    expect(header).toContain("Domain=.gen3ia.online");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    const valeur = header.split(";")[0]?.split("=").slice(1).join("=");
    expect(verifySessionCookie(valeur)).not.toBeNull();
  });

  it("production www + x-forwarded-host avec port → Domain posé (port nettoyé)", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(sessionCookieHeader(PAYLOAD, "www.gen3ia.online:443")).toContain("Domain=.gen3ia.online");
  });

  it("sans hôte (appel historique) → header inchangé, sans Domain", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(sessionCookieHeader(PAYLOAD)).not.toContain("Domain=");
    vi.stubEnv("NODE_ENV", "development");
    expect(sessionCookieHeader(PAYLOAD, "gen3ia.online")).not.toContain("Domain=");
  });

  it("clearSessionCookieHeader avec hôte production → efface AUSSI la variante à Domain", () => {
    vi.stubEnv("NODE_ENV", "production");
    const header = clearSessionCookieHeader("www.gen3ia.online");
    expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("Domain=.gen3ia.online");
  });

  it("le cookie signé avec/sans Domain reste lisible par readSessionCookie (même secret)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const header = sessionCookieHeader(PAYLOAD, "gen3ia.online");
    const cookiePair = header.split(";")[0] ?? "";
    expect(cookiePair.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    const payloadLu = verifySessionCookie(cookiePair.slice(SESSION_COOKIE_NAME.length + 1));
    expect(payloadLu?.uid).toBe("u1");
    expect(payloadLu?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // signSessionPayload reste exporté pour les autres surfaces (middleware).
    expect(signSessionPayload(PAYLOAD).length).toBeGreaterThan(0);
  });
});
