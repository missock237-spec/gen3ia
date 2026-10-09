import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { HttpError } from "@/lib/security/http-errors";

/**
 * Route admin /api/admin/migrate-firestore-r2 (Task 111-b, fix Task 112) :
 * le garde d'auth doit répondre un 401/403 JSON COMPLET — le catch
 * historique retournait `errorStatus(error)` (un NOMBRE), ce qui faisait
 * planter Next avec un 500 VIDE sans corps (constaté en prod au smoke du
 * 2026-10-09). Contrat verrouillé : jamais de 500 sur une erreur d'auth.
 */

const requireAdminMock = vi.fn();

vi.mock("@/lib/security/admin-access", () => ({
  requireAdmin: (...args: unknown[]) => requireAdminMock(...args),
}));

vi.mock("@/lib/firebase/admin", () => ({
  getAdminApp: vi.fn(() => ({})),
}));

vi.mock("@/lib/r2fs/store", () => ({
  rawPut: vi.fn(async () => ({ exists: true, data: {}, etag: '"t"', fresh: false })),
}));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(() => ({
    collection: vi.fn(),
    listCollections: vi.fn(async () => []),
  })),
}));

import { POST } from "./route";

function postRequest(): NextRequest {
  return new NextRequest("https://gen3ia.local/api/admin/migrate-firestore-r2", {
    method: "POST",
    body: JSON.stringify({}),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  requireAdminMock.mockReset();
});

describe("gate admin migrate-firestore-r2 (contrat de statut)", () => {
  it("non authentifié → 401 JSON (JAMAIS un 500 vide)", async () => {
    requireAdminMock.mockRejectedValue(new HttpError(401, "Authentication required.", "AUTH_REQUIRED"));
    const response = await POST(postRequest());
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string; code?: string };
    expect(body.code).toBe("AUTH_REQUIRED");
    expect(body.error).toBeTruthy();
  });

  it("authentifié non admin → 403 JSON", async () => {
    requireAdminMock.mockRejectedValue(new HttpError(403, "Administrator access required.", "FORBIDDEN"));
    const response = await POST(postRequest());
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("FORBIDDEN");
  });

  it("erreur interne → 500 AVEC corps JSON (code INTERNAL)", async () => {
    requireAdminMock.mockResolvedValue({ id: "u1", claims: { admin: true } });
    requireAdminMock.mockRejectedValueOnce(new Error("boom inattendu"));
    const response = await POST(postRequest());
    expect(response.status).toBe(500);
    const body = (await response.json()) as { code?: string; error?: string };
    expect(body.code).toBe("INTERNAL");
    expect(body.error).toBeTruthy();
  });

  it("admin légitime → rapport de migration (collections vides)", async () => {
    requireAdminMock.mockResolvedValue({ id: "u1", claims: { admin: true } });
    const response = await POST(postRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok?: boolean; totalDocs?: number };
    expect(body.ok).toBe(true);
    expect(body.totalDocs).toBe(0);
  });
});
