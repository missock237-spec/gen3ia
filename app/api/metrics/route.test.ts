import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NextRequest } from "next/server";

/**
 * GET /api/metrics (Task G — SRE) — endpoint SLI Prometheus :
 *  - METRICS_TOKEN ABSENT → ouvert (données numériques non sensibles), 200 ;
 *  - METRICS_TOKEN DÉFINI → Bearer OBLIGATOIRE (401 sans/mauvais token,
 *    200 avec le bon), comparaison à temps constant ;
 *  - réponse = texte Prometheus (Content-Type 0.0.4, no-store, préfixe gen3ia_).
 */

import { GET } from "./route";

const TOKEN = "jeton-metrics-test-64c9";

function requete(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://gen3ia.local/api/metrics", { method: "GET", headers });
}

beforeEach(() => {
  delete process.env.METRICS_TOKEN;
});

afterEach(() => {
  delete process.env.METRICS_TOKEN;
});

describe("GET /api/metrics — sans METRICS_TOKEN (mode ouvert)", () => {
  it("répond 200 avec du texte Prometheus (no-store, version=0.0.4)", async () => {
    const response = await GET(requete());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("content-type")).toContain("version=0.0.4");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const corps = await response.text();
    expect(corps).toContain("# TYPE gen3ia_http_requests_total counter");
    expect(corps).toContain("# TYPE gen3ia_uptime_seconds gauge");
    expect(corps).toMatch(/gen3ia_uptime_seconds \d/);
  });

  it("n'exige PAS de Bearer quand la variable n'est pas définie", async () => {
    const response = await GET(requete({ authorization: "Bearer n'importe-quoi" }));
    expect(response.status).toBe(200);
  });
});

describe("GET /api/metrics — avec METRICS_TOKEN (mode protégé)", () => {
  beforeEach(() => {
    process.env.METRICS_TOKEN = TOKEN;
  });

  it("refuse sans en-tête Authorization (401)", async () => {
    const response = await GET(requete());
    expect(response.status).toBe(401);
    const body = (await response.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
  });

  it("refuse un Bearer erroné (401)", async () => {
    const response = await GET(requete({ authorization: "Bearer mauvais-jeton" }));
    expect(response.status).toBe(401);
  });

  it("refuse un Bearer tronqué (pas de correspondance partielle)", async () => {
    const response = await GET(requete({ authorization: `Bearer ${TOKEN.slice(0, 8)}` }));
    expect(response.status).toBe(401);
  });

  it("accepte le bon Bearer (200 + format Prometheus)", async () => {
    const response = await GET(requete({ authorization: `Bearer ${TOKEN}` }));
    expect(response.status).toBe(200);
    const corps = await response.text();
    expect(corps).toContain("# TYPE gen3ia_http_requests_total counter");
  });
});
