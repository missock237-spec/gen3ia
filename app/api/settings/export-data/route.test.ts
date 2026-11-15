import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { HttpError } from "@/lib/security/http-errors";

/**
 * Export RGPD self-service /api/settings/export-data (Task 126) — contrat :
 * session obligatoire, agrégation isolée par section (une panne mémoire ou
 * artefacts n'annule PAS l'export), dépôt R2 sous la clé privée de
 * l'utilisateur puis URL signée courte, audit des deux issues.
 */

const protectMock = vi.fn();
const auditMock = vi.fn();
const getIdentityMock = vi.fn();
const listConversationsMock = vi.fn();
const listMessagesMock = vi.fn();
const listArtifactsMock = vi.fn();
const listRecentRunsMock = vi.fn();
const exportUserDataMock = vi.fn();
const putObjectMock = vi.fn();
const createUrlMock = vi.fn();

vi.mock("@/lib/security/route-guard", () => ({
  protectRoute: (...args: unknown[]) => protectMock(...args),
}));

vi.mock("@/lib/security/audit-events", () => ({
  recordAuditEventSafe: (...args: unknown[]) => auditMock(...args),
}));

vi.mock("@/lib/identity/r2-identity-store", () => ({
  getIdentity: (...args: unknown[]) => getIdentityMock(...args),
}));

vi.mock("@/lib/chat/repository", () => ({
  listConversations: (...args: unknown[]) => listConversationsMock(...args),
  listMessages: (...args: unknown[]) => listMessagesMock(...args),
}));

vi.mock("@/lib/domain/artifacts/repository", () => ({
  listArtifacts: (...args: unknown[]) => listArtifactsMock(...args),
}));

vi.mock("@/lib/domain/runs/repository", () => ({
  listRecentRuns: (...args: unknown[]) => listRecentRunsMock(...args),
}));

vi.mock("@/lib/memory/privacy", () => ({
  exportUserData: (...args: unknown[]) => exportUserDataMock(...args),
}));

vi.mock("@/lib/storage/r2", () => ({
  putObject: (...args: unknown[]) => putObjectMock(...args),
  createR2DownloadUrl: (...args: unknown[]) => createUrlMock(...args),
}));

vi.mock("@/lib/storage/user-data-store", () => ({
  userKey: (uid: string, ...segments: string[]) => `users/${uid}/${segments.join("/")}.json`,
}));

import { GET } from "./route";

const CONTEXT = { userId: "user-1", email: "u@gen3ia.io", traceId: "t1" };

function getRequest(): NextRequest {
  return new NextRequest("https://gen3ia.local/api/settings/export-data");
}

beforeEach(() => {
  vi.clearAllMocks();
  auditMock.mockReturnValue(undefined);
  getIdentityMock.mockResolvedValue({ uid: "user-1", displayName: "Utilisateur" });
  listConversationsMock.mockResolvedValue([{ id: "c1", title: "Mission", updatedAt: "2026-01-01T00:00:00.000Z" }]);
  listMessagesMock.mockResolvedValue([{ id: "m1", role: "user", content: "bonjour" }]);
  listArtifactsMock.mockResolvedValue([{ id: "a1", type: "document", title: "rapport.pdf" }]);
  listRecentRunsMock.mockResolvedValue([{ id: "r1", status: "completed" }]);
  exportUserDataMock.mockResolvedValue({ format: "gen3ia.memory-export", memories: [] });
  putObjectMock.mockResolvedValue(undefined);
  createUrlMock.mockResolvedValue("https://r2.signe.example/xyz");
});

describe("GET /api/settings/export-data", () => {
  it("agrège le compte, dépose en R2 et renvoie une URL signée courte", async () => {
    protectMock.mockResolvedValue({ ok: true, context: CONTEXT });
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string; expiresInSeconds: number; counts: Record<string, number> };
    expect(body.url).toBe("https://r2.signe.example/xyz");
    expect(body.expiresInSeconds).toBe(300);
    expect(body.counts).toEqual({ conversations: 1, artifacts: 1, jobs: 1 });

    // Dépôt sous la clé privée de l'utilisateur, jamais dans la réponse.
    expect(putObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.stringContaining("users/user-1/exports/") }),
    );
    expect(listConversationsMock).toHaveBeenCalledWith("user-1", 50);
    expect(listMessagesMock).toHaveBeenCalledWith("user-1", "c1", 200);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "privacy.export_data", outcome: "completed", actorId: "user-1" }),
    );
  });

  it("survit à une panne de section (warning, export quand même livré)", async () => {
    protectMock.mockResolvedValue({ ok: true, context: CONTEXT });
    listArtifactsMock.mockRejectedValue(new Error("R2 indisponible"));
    exportUserDataMock.mockRejectedValue(new Error("mémoire indisponible"));
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { warnings: string[]; counts: { artifacts: number } };
    expect(body.counts.artifacts).toBe(0);
    expect(body.warnings.some((w) => w.includes("artefacts"))).toBe(true);
    expect(body.warnings.some((w) => w.includes("mémoire"))).toBe(true);
  });

  it("refuse sans session (garde 401) et n'exporte rien", async () => {
    protectMock.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
    const response = await GET(getRequest());
    expect(response.status).toBe(401);
    expect(putObjectMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("journalise l'échec complet (audit outcome failed + 5xx)", async () => {
    protectMock.mockResolvedValue({ ok: true, context: CONTEXT });
    putObjectMock.mockRejectedValue(new HttpError(503, "R2 indisponible"));
    const response = await GET(getRequest());
    expect(response.status).toBe(503);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "privacy.export_data", outcome: "failed" }),
    );
  });
});
