import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /api/public/health — sonde de supervision", () => {
  it("reste 200 ok:true sans dépendance", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("gen3ia");
    expect(typeof body.time).toBe("string");
  });

  it("n'est JAMAIS mise en cache : Cache-Control no-store (audit 25-e, angle mort CDN)", async () => {
    const response = await GET();
    // x-vercel-cache STALE/age 85–269 s rendait la sonde aveugle : la
    // fraîcheur doit être garantie en toutes circonstances.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
