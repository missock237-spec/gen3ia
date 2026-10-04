import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Task 96-c — contrat d'erreur de GET/POST /api/chat/conversations :
 * une erreur de PERSISTANCE (quota Firestore épuisé, repli indisponible)
 * donne un 503 dégradé canonique — JAMAIS un 401, réservé à l'authentification
 * (sinon l'UI traite une panne de base comme une déconnexion).
 */

vi.mock("@/lib/security/authenticated-request", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/chat/repository", () => ({
  createConversation: vi.fn(),
  listConversations: vi.fn(),
}));

import { requireUser } from "@/lib/security/authenticated-request";
import { createConversation, listConversations } from "@/lib/chat/repository";
import { GET, POST } from "./route";

const mockedRequireUser = vi.mocked(requireUser);
const mockedList = vi.mocked(listConversations);
const mockedCreate = vi.mocked(createConversation);

function getRequest(url = "https://gen3ia.local/api/chat/conversations"): NextRequest {
  return new NextRequest(url);
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest("https://gen3ia.local/api/chat/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Quota Firestore BRUT (gRPC 8) — ne matche PAS DEGRADED_MESSAGE_RE à lui seul. */
function rawQuotaError(): Error {
  return Object.assign(new Error("Resource has been exhausted (e.g., check quota)."), { code: 8 });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRequireUser.mockResolvedValue({ uid: "user-1" } as never);
});

describe("GET /api/chat/conversations — statuts d'erreur (Task 96-c)", () => {
  it("quota Firestore → 503 dégradé canonique (code PROVIDER_UNAVAILABLE), pas un 401", async () => {
    mockedList.mockRejectedValue(rawQuotaError());
    const response = await GET(getRequest());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe("PROVIDER_UNAVAILABLE");
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("repli indisponible (message dégradé) → 503", async () => {
    mockedList.mockRejectedValue(new Error("Firestore quota atteinte et Supabase fallback indisponible."));
    const response = await GET(getRequest());
    expect(response.status).toBe(503);
  });

  it("erreur d'authentification → 401 (réservé à l'authentification)", async () => {
    mockedRequireUser.mockRejectedValue(new Error("Missing Authorization header"));
    const response = await GET(getRequest());
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("AUTH_REQUIRED");
  });

  it("erreur métier inconnue → repli historique 401", async () => {
    mockedList.mockRejectedValue(new Error("Erreur inattendue de liste."));
    const response = await GET(getRequest());
    expect(response.status).toBe(401);
  });
});

describe("POST /api/chat/conversations — statuts d'erreur (Task 96-c)", () => {
  it("quota Firestore → 503 dégradé (la création de conversation n'est pas un 400)", async () => {
    mockedCreate.mockRejectedValue(rawQuotaError());
    const response = await POST(postRequest({ title: "Nouveau fil" }));
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("création nominale → 201", async () => {
    mockedCreate.mockResolvedValue({
      id: "conv-1", userId: "user-1", title: "Nouveau fil", messageCount: 0,
      status: "active" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as never);
    const response = await POST(postRequest({ title: "Nouveau fil" }));
    expect(response.status).toBe(201);
    expect((await response.json()).conversation.id).toBe("conv-1");
  });
});
