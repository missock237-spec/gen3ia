import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveOrigineClient } from "@/lib/media/origine-client";

/**
 * ORIGINE RÉELLEMENT NAVIGUÉE — gardes du correctif « médias réellement
 * envoyés dans la conversation » (demande propriétaire 2026-11-12).
 *
 * CONSTAT PRODUCTION (sonde réelle) : derrière nginx, les liens durables des
 * messages persistés valaient « https://localhost:3000/api/media/durable?… »
 * (Host du proxy_pass + X-Forwarded-Proto) — l'audio et la vidéo EXISTAIENT
 * dans R2 mais le lien livré était injoignable : pour l'utilisateur, rien
 * n'avait été créé ni envoyé. Gardes verrouillés :
 *  - X-Forwarded-Host (signal proxy) prioritaire, allowlist obligatoire ;
 *  - Referer accepté (usage LIEN vers le même client — zéro SSRF) ;
 *  - localhost JAMAIS en production (ni résolveur, ni urlDurableAbsolue) ;
 *  - falsifiable (javascript:, hôte hors allowlist) → repli canonique.
 */

function enTetes(valeurs: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(valeurs)) h.set(k, v);
  return h;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveOrigineClient — l'hôte réellement navigué", () => {
  it("X-Forwarded-Host https prioritaire (proxy nginx → www navigué)", () => {
    vi.stubEnv("GEN3IA_APP_ORIGIN", "https://gen3ia.online");
    const origine = resolveOrigineClient({
      headers: enTetes({ "x-forwarded-host": "www.gen3ia.online", "x-forwarded-proto": "https" }),
      nextUrl: { origin: "https://localhost:3000" },
    });
    expect(origine).toBe("https://www.gen3ia.online");
  });

  it("X-Forwarded-Host multi-valeurs : la première est lue", () => {
    vi.stubEnv("GEN3IA_APP_ORIGIN", "https://gen3ia.online");
    const origine = resolveOrigineClient({
      headers: enTetes({ "x-forwarded-host": "www.gen3ia.online, interne.local" }),
      nextUrl: { origin: "https://localhost:3000" },
    });
    expect(origine).toBe("https://www.gen3ia.online");
  });

  it("X-Forwarded-Host absent + nextUrl localhost en production → canonique (jamais un lien localhost)", () => {
    vi.stubEnv("GEN3IA_APP_ORIGIN", "https://www.gen3ia.online");
    vi.stubEnv("NODE_ENV", "production");
    const origine = resolveOrigineClient({
      headers: enTetes({}),
      nextUrl: { origin: "https://localhost:3000" },
    });
    expect(origine).toBe("https://www.gen3ia.online");
  });

  it("Referer utilisé quand aucun signal proxy (usage lien uniquement)", () => {
    vi.stubEnv("GEN3IA_APP_ORIGIN", "https://gen3ia.online");
    const origine = resolveOrigineClient({
      headers: enTetes({ referer: "https://www.gen3ia.online/chat" }),
      nextUrl: { origin: "https://localhost:3000" },
    });
    expect(origine).toBe("https://www.gen3ia.online");
  });

  it("Referer falsifié (javascript:, hôte hors allowlist) → ignoré", () => {
    vi.stubEnv("GEN3IA_APP_ORIGIN", "https://www.gen3ia.online");
    vi.stubEnv("NODE_ENV", "production");
    for (const falsifie of ["javascript:alert(1)", "https://malveillant.exemple/chat", "ftp://www.gen3ia.online/x"]) {
      const origine = resolveOrigineClient({
        headers: enTetes({ referer: falsifie }),
        nextUrl: { origin: "https://localhost:3000" },
      });
      expect(origine).toBe("https://www.gen3ia.online");
    }
  });

  it("aucun signal valide + canonique absente → undefined (l'appelant garde son repli)", () => {
    vi.stubEnv("GEN3IA_APP_ORIGIN", "");
    vi.stubEnv("NODE_ENV", "production");
    const origine = resolveOrigineClient({
      headers: enTetes({ referer: "javascript:alert(1)" }),
      nextUrl: { origin: "https://localhost:3000" },
    });
    expect(origine).toBeUndefined();
  });

  it("hors production, localhost reste valable (développement local)", () => {
    vi.stubEnv("GEN3IA_APP_ORIGIN", "");
    vi.stubEnv("NODE_ENV", "development");
    const origine = resolveOrigineClient({
      headers: enTetes({}),
      nextUrl: { origin: "http://localhost:3000" },
    });
    expect(origine).toBe("http://localhost:3000");
  });
});

describe("urlDurableAbsolue — garde anti-link-localhost", () => {
  it("candidat localhost + canonique disponible → canonique gagne (production)", () => {
    vi.stubEnv("GEN3IA_APP_ORIGIN", "https://www.gen3ia.online");
    vi.resetModules();
    return import("@/lib/media/url-durable").then(({ urlDurableAbsolue: absolue }) => {
      expect(absolue("users/r2_abc/permanent/x.mp3", "https://localhost:3000")).toBe(
        "https://www.gen3ia.online/api/media/durable?path=users%2Fr2_abc%2Fpermanent%2Fx.mp3",
      );
    });
  });

  it("candidat localhost SANS canonique (dev) → localhost conservé", () => {
    vi.stubEnv("GEN3IA_APP_ORIGIN", "");
    vi.resetModules();
    return import("@/lib/media/url-durable").then(({ urlDurableAbsolue: absolue }) => {
      expect(absolue("users/r2_abc/permanent/x.mp3", "http://localhost:3000")).toBe(
        "http://localhost:3000/api/media/durable?path=users%2Fr2_abc%2Fpermanent%2Fx.mp3",
      );
    });
  });

  it("candidat https www prioritaire sur la canonique apex (cookie host-only)", () => {
    vi.stubEnv("GEN3IA_APP_ORIGIN", "https://gen3ia.online");
    vi.resetModules();
    return import("@/lib/media/url-durable").then(({ urlDurableAbsolue: absolue }) => {
      expect(absolue("users/r2_abc/permanent/x.mp3", "https://www.gen3ia.online")).toBe(
        "https://www.gen3ia.online/api/media/durable?path=users%2Fr2_abc%2Fpermanent%2Fx.mp3",
      );
    });
  });

  it("clé vidéo du pipeline résolvable sur l'origine réellement naviguée", () => {
    vi.stubEnv("GEN3IA_APP_ORIGIN", "https://gen3ia.online");
    vi.resetModules();
    return import("@/lib/media/url-durable").then(({ urlDurableAbsolue: absolue }) => {
      expect(
        absolue("users/r2_abc/video/proj-1/render/master.mp4", "https://www.gen3ia.online"),
      ).toBe(
        "https://www.gen3ia.online/api/media/durable?path=users%2Fr2_abc%2Fvideo%2Fproj-1%2Frender%2Fmaster.mp4",
      );
    });
  });
});

describe("chaînes de livraison — cohérence des quatre routes", () => {
  it("stream + messages + webgpu-complete + webgpu-fallback utilisent tous resolveOrigineClient", () => {
    const sources = [
      "app/api/workspace/conversations/[conversationId]/messages/stream/route.ts",
      "app/api/workspace/conversations/[conversationId]/messages/route.ts",
      "app/api/media/webgpu-complete/route.ts",
      "app/api/media/webgpu-fallback/route.ts",
    ];
    for (const chemin of sources) {
      const source = readFileSync(chemin, "utf8");
      expect(source, chemin).toContain("resolveOrigineClient");
      expect(source, chemin).toContain("@/lib/media/origine-client");
    }
  });
});
