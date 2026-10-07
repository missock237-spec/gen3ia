import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { HttpError } from "@/lib/security/http-errors";

/**
 * Rapprochement admin /api/admin/billing/reconcile (Task 104-b) : garde
 * admin obligatoire, scan champ simple (échecs + baux de processing
 * expirés), rapport sans écriture, retry borné à 10 retraitements par appel
 * via le même chemin idempotent que le webhook, erreurs isolées par
 * livraison.
 */

const requireAdminMock = vi.fn();
const claimChariowDeliveryMock = vi.fn();
const processChariowSaleMock = vi.fn();
const collectionMock = vi.fn();

vi.mock("@/lib/security/admin-access", () => ({
  requireAdmin: (...args: unknown[]) => requireAdminMock(...args),
}));
vi.mock("@/lib/billing/chariow-delivery", () => ({
  CHARIOW_LEASE_MS: 10 * 60 * 1000,
  claimChariowDelivery: (...args: unknown[]) => claimChariowDeliveryMock(...args),
  processChariowSale: (...args: unknown[]) => processChariowSaleMock(...args),
  // Réimplémentation fidèle des helpers purs (unit-testés dans lib/billing).
  receivedAtToMillis: (value: unknown) =>
    value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.now(),
  storedChariowPayload: (data: unknown) => {
    const payload = (data as { payload?: unknown } | null | undefined)?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    if ((payload as { __truncated?: unknown }).__truncated === true) return null;
    return payload as Record<string, unknown>;
  },
}));
vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (...args: unknown[]) => collectionMock(...args),
  },
}));

import { POST } from "./route";

const LEASE = 10 * 60 * 1000;

function collectionReturning(failedDocs: unknown[], processingDocs: unknown[]) {
  collectionMock.mockImplementation(() => ({
    where: (_field: string, _op: string, value: unknown) => ({
      limit: () => ({ get: value === "failed" ? failedGet : processingGet }),
    }),
  }));
  failedGet.mockResolvedValue({ docs: failedDocs });
  processingGet.mockResolvedValue({ docs: processingDocs });
}

const failedGet = vi.fn();
const processingGet = vi.fn();

function doc(id: string, data: Record<string, unknown>) {
  return { id, data: () => data };
}

function postRequest(body?: unknown): NextRequest {
  return new NextRequest("https://gen3ia.local/api/admin/billing/reconcile", {
    method: "POST",
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue({ uid: "admin-1" } as never);
});

describe("POST /api/admin/billing/reconcile — authentification", () => {
  it("401 sans session admin (et aucun scan Firestore)", async () => {
    requireAdminMock.mockRejectedValue(new HttpError(401, "Authentification requise : jeton manquant ou session expirée."));
    const response = await POST(postRequest());
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.code).toBe("AUTH_REQUIRED");
    expect(collectionMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/billing/reconcile — rapport (sans retry)", () => {
  it("collection vide → rapport nul, sans clés de retry", async () => {
    collectionReturning([], []);
    const response = await POST(postRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ failed: 0, staleProcessing: 0, oldest: null });
    expect("retried" in body).toBe(false);
  });

  it("détecte les échecs et les baux expirés, ignore les processing frais", async () => {
    const now = Date.now();
    collectionReturning(
      [doc("d-fail", { status: "failed", receivedAt: new Date(now - 30 * 60 * 1000) })],
      [
        doc("d-fresh", { status: "processing", receivedAt: new Date(now - 60 * 1000) }),
        doc("d-stale", { status: "processing", receivedAt: new Date(now - 2 * LEASE) }),
      ],
    );
    const body = await (await POST(postRequest())).json();
    expect(body.failed).toBe(1);
    expect(body.staleProcessing).toBe(1);
    // Le plus ancien des documents problématiques (l'échec à -30 min).
    expect(body.oldest).toBe(now - 30 * 60 * 1000);
    // Uniquement des requêtes champ simple (égalité status), limit 50.
    expect(collectionMock).toHaveBeenCalledWith("chariowPulseDeliveries");
  });

  it("corps sans retry explicite → rapport seul", async () => {
    collectionReturning([], []);
    const body = await (await POST(postRequest({ retry: false }))).json();
    expect("retried" in body).toBe(false);
    expect(claimChariowDeliveryMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/billing/reconcile — retry { retry: true }", () => {
  it("retraite au maximum 10 livraisons par appel", async () => {
    const docs = Array.from({ length: 12 }, (_, index) =>
      doc(`d-${index}`, { status: "failed", receivedAt: new Date(1_000 + index), payload: { sale: { id: `sale-${index}` } } }),
    );
    collectionReturning(docs, []);
    claimChariowDeliveryMock.mockResolvedValue({ action: "process" });
    processChariowSaleMock.mockResolvedValue({ kind: "credited", wallet: { balanceMinor: 1 } });

    const body = await (await POST(postRequest({ retry: true }))).json();
    expect(claimChariowDeliveryMock).toHaveBeenCalledTimes(10);
    expect(processChariowSaleMock).toHaveBeenCalledTimes(10);
    expect(body).toEqual(
      expect.objectContaining({ failed: 12, staleProcessing: 0, retried: 10, recovered: 10, stillFailed: 0 }),
    );
    // Les plus anciennes d'abord (receivedAt ascendant).
    expect(claimChariowDeliveryMock.mock.calls[0][0]).toBe("d-0");
    expect(claimChariowDeliveryMock.mock.calls[9][0]).toBe("d-9");
  });

  it("payload manquant (document antérieur à 104-b) → signalé mais non retraité", async () => {
    collectionReturning(
      [
        doc("d-legacy", { status: "failed", receivedAt: new Date(1_000) }),
        doc("d-ok", { status: "failed", receivedAt: new Date(2_000), payload: { sale: { id: "sale-1" } } }),
      ],
      [],
    );
    claimChariowDeliveryMock.mockResolvedValue({ action: "process" });
    processChariowSaleMock.mockResolvedValue({ kind: "credited", wallet: {} });

    const body = await (await POST(postRequest({ retry: true }))).json();
    expect(claimChariowDeliveryMock).toHaveBeenCalledTimes(1);
    expect(claimChariowDeliveryMock).toHaveBeenCalledWith("d-ok", { sale: { id: "sale-1" } });
    expect(body.retried).toBe(1);
    expect(body.recovered).toBe(1);
    expect(body.stillFailed).toBe(0);
  });

  it("échec de retraitement isolé : les autres livraisons continuent", async () => {
    collectionReturning(
      [
        doc("d-1", { status: "failed", receivedAt: new Date(1_000), payload: { sale: { id: "sale-1" } } }),
        doc("d-2", { status: "failed", receivedAt: new Date(2_000), payload: { sale: { id: "sale-2" } } }),
        doc("d-3", { status: "failed", receivedAt: new Date(3_000), payload: { sale: { id: "sale-3" } } }),
      ],
      [],
    );
    claimChariowDeliveryMock.mockResolvedValue({ action: "process" });
    processChariowSaleMock
      .mockResolvedValueOnce({ kind: "failed", error: "toujours en échec" })
      .mockRejectedValueOnce(new Error("panne infrastructure"))
      .mockResolvedValueOnce({ kind: "credited", wallet: {} });

    const body = await (await POST(postRequest({ retry: true }))).json();
    expect(body).toEqual(
      expect.objectContaining({ failed: 3, retried: 3, recovered: 1, stillFailed: 2 }),
    );
  });

  it("claim non « process » (réglé ailleurs / in-flight) → ni repris ni échoué", async () => {
    collectionReturning(
      [doc("d-1", { status: "failed", receivedAt: new Date(1_000), payload: { sale: { id: "sale-1" } } })],
      [],
    );
    claimChariowDeliveryMock.mockResolvedValue({ action: "duplicate-processed" });

    const body = await (await POST(postRequest({ retry: true }))).json();
    expect(processChariowSaleMock).not.toHaveBeenCalled();
    expect(body).toEqual(
      expect.objectContaining({ failed: 1, retried: 0, recovered: 0, stillFailed: 0 }),
    );
  });
});

describe("gardes structurelles (convention du dépôt)", () => {
  const source = readFileSync(path.join(import.meta.dirname, "route.ts"), "utf8");

  it("garde : la route passe par la garde admin et le bail partagé", () => {
    expect(source).toContain("requireAdmin(");
    expect(source).toContain("CHARIOW_LEASE_MS");
    // Scan borné (aucune lecture illimitée de la collection).
    expect(source).toContain(".limit(SCAN_LIMIT)");
  });
});
