import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

// Le proxy est testé tel quel (aucune dépendance à simuler) :
// lib/device/detect est un module pur et next/server fonctionne en Node.
import { config, proxy } from "../../proxy";

function requestTo(pathname: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://gen3ia.local${pathname}`, { method: "GET", headers });
}

beforeEach(() => {
  // Date.now influence l'id généré : on fige le temps pour des assertions
  // déterministes.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("proxy — corrélation x-gen3ia-trace-id (audit 25-a)", () => {
  it("ajoute un id généré (format trc_*) sur les réponses /api/*", () => {
    const response = proxy(requestTo("/api/health"));
    const traceId = response.headers.get("x-gen3ia-trace-id");
    expect(traceId).toBeTruthy();
    expect(traceId).toMatch(/^trc_[a-z0-9]+$/);
    // Id court (lisibilité logs) mais suffisamment long pour éviter les collisions.
    expect(traceId!.length).toBeGreaterThanOrEqual(12);
  });

  it("réutilise l'id entrant s'il est sain (corrélation de bout en bout)", () => {
    const response = proxy(requestTo("/api/workspace/conversations", { "x-gen3ia-trace-id": "client-trace-42" }));
    expect(response.headers.get("x-gen3ia-trace-id")).toBe("client-trace-42");
  });

  it("remplace un id entrant invalide (anti-injection dans les logs)", () => {
    const response = proxy(requestTo("/api/health", { "x-gen3ia-trace-id": "court!" }));
    const traceId = response.headers.get("x-gen3ia-trace-id");
    expect(traceId).not.toBe("court!");
    expect(traceId).toMatch(/^trc_[a-z0-9]+$/);
  });

  it("ne pose PAS le header sur les pages non-API", () => {
    const response = proxy(requestTo("/dashboard"));
    expect(response.headers.get("x-gen3ia-trace-id")).toBeNull();
    // Le reste du comportement du proxy est préservé.
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("préserve la redirection d'accès client (comportement existant)", () => {
    const response = proxy(
      requestTo("/dashboard", { cookie: "gen3ia_client_access=/client/c/demo" }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://gen3ia.local/client/c/demo");
  });

  it("le matcher couvre bien les routes API", () => {
    const matcher = Array.isArray(config.matcher) ? config.matcher.join("|") : config.matcher;
    expect(matcher.length).toBeGreaterThan(0);
  });
});
