import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

// Audit 25-c : la création de conversations n'était pas rate-limitée.
// On teste le contrat HTTP : 429 propre + Retry-After, limite appliquée
// après authentification et avant toute écriture Firestore.
vi.mock("@/lib/security/authenticated-request", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  enforceRateLimit: vi.fn(),
}));

vi.mock("@/lib/chat/repository", () => ({
  createConversation: vi.fn(),
  listConversations: vi.fn(),
}));

vi.mock("@/lib/domain/projects/repository", () => ({
  getProject: vi.fn(),
}));

import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { createConversation, listConversations } from "@/lib/chat/repository";
import { GET, POST } from "./route";

const mockedRequireUser = vi.mocked(requireUser);
const mockedEnforce = vi.mocked(enforceRateLimit);
const mockedCreate = vi.mocked(createConversation);
const mockedList = vi.mocked(listConversations);

function postRequest(body: unknown): NextRequest {
  return new NextRequest("https://gen3ia.local/api/workspace/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(): NextRequest {
  return new NextRequest("https://gen3ia.local/api/workspace/conversations?limit=10", { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRequireUser.mockResolvedValue({ uid: "user-1" });
  mockedEnforce.mockResolvedValue({ allowed: true, remaining: 19, retryAfterMs: 0, distributed: true });
  mockedCreate.mockResolvedValue({ id: "conv-1", title: "Nouvelle conversation" } as never);
  mockedList.mockResolvedValue([]);
});

describe("POST /api/workspace/conversations — rate limite de création", () => {
  it("applique le limiteur RENFORCÉ (local + Redis) : 20/min par utilisateur", async () => {
    await POST(postRequest({}));
    expect(mockedEnforce).toHaveBeenCalledWith("ws-conv-create:user-1", { limit: 20, windowMs: 60_000 });
  });

  it("retourne 429 propre avec Retry-After quand la limite est atteinte", async () => {
    mockedEnforce.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 30_000, distributed: true });
    const response = await POST(postRequest({ title: "Spam" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    const body = await response.json();
    expect(body.error).toBeTruthy();
    // Aucune écriture Firestore au-delà du quota.
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("crée la conversation (201) quand la limite autorise", async () => {
    const response = await POST(postRequest({ title: "Ma conversation" }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.conversation.id).toBe("conv-1");
    expect(mockedCreate).toHaveBeenCalledOnce();
  });

  it("authentifie AVANT de limiter (pas de quota consommé par un anonyme)", async () => {
    mockedRequireUser.mockRejectedValue(new Error("Unauthorized"));
    const response = await POST(postRequest({}));
    expect(response.status).toBe(401);
    expect(mockedEnforce).not.toHaveBeenCalled();
  });
});

describe("GET /api/workspace/conversations — hors périmètre de la correction", () => {
  it("la liste n'est PAS concernée par le quota de création", async () => {
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    expect(mockedEnforce).not.toHaveBeenCalled();
  });
});
