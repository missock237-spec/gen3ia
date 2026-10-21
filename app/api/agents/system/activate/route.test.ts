import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Route interne POST /api/agents/system/activate (demande utilisateur n°5).
 * Contrats verrouillés :
 *  1. AGENTS_SYSTEM_SECRET absent → 503 honnête (aucune activation simulée) ;
 *  2. bearer manquant/erroné → 401 (comparaison à temps constant) ;
 *  3. bearer valide + corps valide → 200 avec le résultat du service ;
 *  4. corps invalide → 400 ;
 *  5. échec du service → 500 avec le message réel.
 */

const mockedActivate = vi.fn();

vi.mock("@/lib/agents/system-activation", () => ({
  activateAgentSystemForUser: (...args: unknown[]) => mockedActivate(...args),
}));

import { POST } from "./route";

const RESULT = {
  activated: true,
  subAgents: [
    { id: "agent_1", name: "Assistant Navigateur — Recherche Web", type: "research", typeLabel: "Assistance navigateur", status: "active", tools: ["browser.navigate"] },
  ],
};

function post(body: unknown, authorization?: string): NextRequest {
  return new NextRequest("http://localhost/api/agents/system/activate", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AGENTS_SYSTEM_SECRET = "secret-interne-test";
  mockedActivate.mockResolvedValue(RESULT);
});

afterEach(() => {
  delete process.env.AGENTS_SYSTEM_SECRET;
});

describe("POST /api/agents/system/activate — authentification système", () => {
  it("renvoie 503 honnête quand le secret serveur n'est pas configuré", async () => {
    delete process.env.AGENTS_SYSTEM_SECRET;
    const response = await POST(post({ userId: "user-12345" }, "Bearer secret-interne-test"));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toMatch(/AGENTS_SYSTEM_SECRET/);
    expect(mockedActivate).not.toHaveBeenCalled();
  });

  it("renvoie 401 sans bearer (utilisateur banni du chemin interne)", async () => {
    const response = await POST(post({ userId: "user-12345" }));
    expect(response.status).toBe(401);
    expect(mockedActivate).not.toHaveBeenCalled();
  });

  it("renvoie 401 sur un bearer erroné", async () => {
    const response = await POST(post({ userId: "user-12345" }, "Bearer mauvais-secret"));
    expect(response.status).toBe(401);
    expect(mockedActivate).not.toHaveBeenCalled();
  });

  it("active le système agent avec le secret valide et renvoie les sous-agents", async () => {
    const response = await POST(post({ userId: "user-12345", demande: "surveille ce site", source: "chat" }, "Bearer secret-interne-test"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.activated).toBe(true);
    expect(body.subAgents).toHaveLength(1);
    expect(body.requestId).toBeTruthy();
    expect(mockedActivate).toHaveBeenCalledWith({ userId: "user-12345", demande: "surveille ce site", source: "chat" });
  });

  it("renvoie 400 sur un corps invalide (userId trop court / manquant)", async () => {
    const response = await POST(post({ userId: "x" }, "Bearer secret-interne-test"));
    expect(response.status).toBe(400);
    expect(mockedActivate).not.toHaveBeenCalled();
  });

  it("propage l'échec du service en 500 avec le message réel", async () => {
    mockedActivate.mockRejectedValue(new Error("Stockage indisponible"));
    const response = await POST(post({ userId: "user-12345" }, "Bearer secret-interne-test"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toMatch(/Stockage indisponible/);
  });
});
