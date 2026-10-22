import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * OUVERTURE PROPRIÉTAIRE — DELETE /api/agents/[id] accessible à tout
 * utilisateur CONNECTÉ (requireUser), le cloisonnement propriétaire/org
 * restant assuré par deleteAgentForUser (404 anti-énumération).
 * Contrats verrouillés :
 *  1. un utilisateur STANDARD (sans claim admin) supprime SON agent → 200 ;
 *  2. la délégation passe bien par deleteAgentForUser(user.uid, id) ;
 *  3. agent inexistant ou d'autrui → 404 (jamais 403 « réservé ») ;
 *  4. requête non authentifiée → 401 ;
 *  5. erreur de stockage → 500 (errorStatus).
 */

vi.mock("@/lib/security/authenticated-request", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/agents/repository", () => ({
  deleteAgentForUser: vi.fn(),
  getAgentForUser: vi.fn(),
  toSummary: vi.fn((record: Record<string, unknown>) => ({ id: record.id, name: record.name })),
  updateAgentForUser: vi.fn(),
}));

import { requireUser } from "@/lib/security/authenticated-request";
import { deleteAgentForUser } from "@/lib/agents/repository";

const mockUser = vi.mocked(requireUser);
const mockDelete = vi.mocked(deleteAgentForUser);

beforeEach(() => {
  vi.clearAllMocks();
  mockUser.mockResolvedValue({ uid: "user_1", claims: {} } as Awaited<ReturnType<typeof requireUser>>);
  mockDelete.mockResolvedValue(true);
});

function deleteRequest() {
  return new NextRequest("http://localhost/api/agents/agent_1", { method: "DELETE" });
}

const CONTEXT = { params: Promise.resolve({ id: "agent_1" }) };

describe("DELETE /api/agents/[id] — suppression par le propriétaire", () => {
  it("un utilisateur standard supprime SON agent (200, délégation deleteAgentForUser)", async () => {
    const { DELETE } = await import("./route");
    const response = await DELETE(deleteRequest(), CONTEXT);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deleted).toBe(true);
    expect(mockDelete).toHaveBeenCalledWith("user_1", "agent_1");
  });

  it("renvoie 404 pour un agent inexistant ou possédé par autrui", async () => {
    const { DELETE } = await import("./route");
    mockDelete.mockResolvedValue(false);
    const response = await DELETE(deleteRequest(), CONTEXT);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toContain("introuvable");
  });

  it("renvoie 401 sans authentification", async () => {
    const { DELETE } = await import("./route");
    const { HttpError } = await import("@/lib/security/http-errors");
    mockUser.mockRejectedValue(new HttpError(401, "Authentification requise.", "AUTH_REQUIRED"));
    const response = await DELETE(deleteRequest(), CONTEXT);
    expect(response.status).toBe(401);
  });

  it("traduit une erreur de stockage en 500", async () => {
    const { DELETE } = await import("./route");
    mockDelete.mockRejectedValue(new Error("Stockage indisponible en suppression."));
    const response = await DELETE(deleteRequest(), CONTEXT);
    expect(response.status).toBe(500);
  });
});
