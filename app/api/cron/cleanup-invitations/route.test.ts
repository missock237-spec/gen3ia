import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Cron /api/cron/cleanup-invitations (Task 111-b, fix Task 112) : le catch
 * retournait `errorStatus(error)` (NOMBRE) → 500 vide de Next. Contrat
 * verrouillé : 401 JSON sans secret invalide, erreur interne = 500 AVEC
 * corps JSON.
 */

const collectionGroupMock = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collectionGroup: (...args: unknown[]) => collectionGroupMock(...args),
    batch: () => ({ update: vi.fn(), commit: vi.fn(async () => undefined) }),
  },
}));

import { POST } from "./route";

function postRequest(authorization?: string): NextRequest {
  return new NextRequest("https://gen3ia.local/api/cron/cleanup-invitations", {
    method: "POST",
    ...(authorization ? { headers: { authorization } } : {}),
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = "secret-test-cron";
  collectionGroupMock.mockReset();
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("gate cron cleanup-invitations", () => {
  it("sans secret → 401 JSON", async () => {
    const response = await POST(postRequest());
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("UNAUTHORIZED");
  });

  it("mauvais secret → 401 JSON", async () => {
    const response = await POST(postRequest("Bearer mauvais"));
    expect(response.status).toBe(401);
  });

  it("secret valide + panne r2fs → 500 AVEC corps JSON (jamais vide)", async () => {
    collectionGroupMock.mockImplementation(() => {
      throw new Error("r2fs: lecture impossible");
    });
    const response = await POST(postRequest("Bearer secret-test-cron"));
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error?: string; code?: string };
    expect(body.error).toBeTruthy();
    expect(body.code).toBe("INTERNAL");
  });

  it("secret valide + aucun pending → ok, 0 expiration", async () => {
    collectionGroupMock.mockReturnValue({
      where: () => ({ get: async () => ({ size: 0, docs: [] }) }),
    });
    const response = await POST(postRequest("Bearer secret-test-cron"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok?: boolean; expired?: number; scanned?: number };
    expect(body.ok).toBe(true);
    expect(body.expired).toBe(0);
    expect(body.scanned).toBe(0);
  });
});
