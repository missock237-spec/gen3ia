import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

// Toutes les dépendances de la route sont simulées : on teste uniquement
// le contrat HTTP (le champ `storage` reflète l'état réel du stockage R2
// sans jamais faire crasher la sonde — audit 25-d).
vi.mock("@/lib/security/route-guard", () => ({
  protectRoute: vi.fn(),
}));

vi.mock("@/lib/cache/redis", () => ({
  isRedisConfigured: vi.fn(() => true),
  redisPing: vi.fn(),
}));

vi.mock("@/lib/memory/vector-store", () => ({
  isVectorStoreConfigured: vi.fn(() => true),
  countVectorPoints: vi.fn(),
  VECTOR_COLLECTION_MEMORIES: "memories",
  VECTOR_COLLECTION_KNOWLEDGE: "knowledge",
}));

vi.mock("@/lib/chat/vector-index", () => ({
  CONVERSATION_VECTOR_COLLECTION: "conversations",
}));

vi.mock("@/lib/sandbox/simulation", () => ({
  isSandboxConfigured: vi.fn(() => false),
}));

vi.mock("@/lib/storage/r2", () => ({
  pingR2: vi.fn(),
}));

import { protectRoute } from "@/lib/security/route-guard";
import { pingR2 } from "@/lib/storage/r2";
import { GET } from "./route";

const mockedProtect = vi.mocked(protectRoute);
const mockedPingR2 = vi.mocked(pingR2);

function getRequest(): NextRequest {
  return new NextRequest("https://gen3ia.local/api/health/infra", { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedProtect.mockResolvedValue({
    ok: true,
    context: { userId: "user-1", traceId: "trc_test" },
  } as never);
});

describe("GET /api/health/infra — champ storage (sonde R2)", () => {
  it("signale not_configured quand les env R2 sont absentes, route toujours 200", async () => {
    mockedPingR2.mockResolvedValue({ ok: false, reason: "not_configured" });
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.storage).toEqual({ ok: false, reason: "not_configured" });
    expect(mockedPingR2).toHaveBeenCalledWith(3_000);
  });

  it("signale ok:true (sans raison) quand R2 répond", async () => {
    mockedPingR2.mockResolvedValue({ ok: true });
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.storage).toEqual({ ok: true });
    expect(Object.hasOwn(body.storage, "reason")).toBe(false);
  });

  it("ne crash jamais : sonde R2 en échec => storage { ok:false, reason:'error' }", async () => {
    mockedPingR2.mockRejectedValue(new Error("dépendance R2 instable"));
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.storage).toEqual({ ok: false, reason: "error" });
  });
});
