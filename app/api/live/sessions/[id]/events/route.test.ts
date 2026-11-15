import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/live/sessions/[id]/events — journal d'événements de la session
 * Live (restauration post-Task 150). Verrous : authentification, isolation
 * propriétaire, limite de lecture bornée, lecture Firestore admin only.
 */

vi.mock("@/lib/firebase/auth-server", () => ({
  verifyFirebaseAuth: vi.fn(),
}));
vi.mock("@/lib/live/repository", () => ({
  assertLiveSessionOwner: vi.fn(),
}));
vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(),
  },
}));

import { verifyFirebaseAuth } from "@/lib/firebase/auth-server";
import { assertLiveSessionOwner } from "@/lib/live/repository";
import { adminDb } from "@/lib/firebase/admin";
import { GET } from "./route";

const mockedAuth = vi.mocked(verifyFirebaseAuth);
const mockedOwner = vi.mocked(assertLiveSessionOwner);

const SESSION_ID = "live_events_test";
const PC_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const EVENTS = [
  { id: "e1", type: "vision.decision", createdAt: 3 },
  { id: "e2", type: "action.result", ok: true, createdAt: 2 },
];

/** Chaîne Firestore : collection → doc(id) → collection("events") → orderBy → limit → get. */
function eventsChain(docs: unknown[]) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.get = vi.fn().mockResolvedValue({
    docs: docs.map((d) => ({ id: (d as { id: string }).id, data: () => d })),
  });
  chain.collection = vi.fn(() => chain);
  chain.doc = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  vi.mocked(adminDb.collection).mockImplementation(() => chain as never);
  return chain;
}

function getRequest(search = "") {
  return new NextRequest(`http://localhost/api/live/sessions/${SESSION_ID}/events${search}`, {
    headers: { "user-agent": PC_UA },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedAuth.mockResolvedValue({ uid: "user-1" } as never);
  mockedOwner.mockResolvedValue({ id: SESSION_ID, ownerId: "user-1" } as never);
});

describe("GET /api/live/sessions/[id]/events", () => {
  it("renvoie les événements du propriétaire, limite par défaut 50", async () => {
    const chain = eventsChain(EVENTS);
    const response = await GET(getRequest(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.events).toHaveLength(2);
    expect(data.events[0].type).toBe("vision.decision");
    expect(data.events[0].id).toBe("e1");
    expect(mockedOwner).toHaveBeenCalledWith(SESSION_ID, "user-1");
    expect(vi.mocked(adminDb.collection)).toHaveBeenCalledWith("liveAgentSessions");
    expect(chain.doc).toHaveBeenCalledWith(SESSION_ID);
    expect(chain.orderBy).toHaveBeenCalledWith("createdAt", "desc");
    expect(chain.limit).toHaveBeenCalledWith(50);
  });

  it("plafonne la limite demandée à 200", async () => {
    const chain = eventsChain(EVENTS);
    const response = await GET(getRequest("?limit=9999"), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(response.status).toBe(200);
    expect(chain.limit).toHaveBeenCalledWith(200);
  });

  it("borne la limite basse à 1", async () => {
    const chain = eventsChain(EVENTS);
    await GET(getRequest("?limit=0"), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(chain.limit).toHaveBeenCalledWith(1);
  });

  it("refuse un accès hors propriétaire (statut borné 400)", async () => {
    mockedOwner.mockRejectedValueOnce(new Error("Live session access denied"));
    eventsChain([]);
    const response = await GET(getRequest(), { params: Promise.resolve({ id: SESSION_ID }) });
    // errorStatus(error, 400) : « access denied » ne matche pas le message
    // d'authentification (le propriétaire est vérifié APRÈS l'auth Firebase) → 400.
    expect(response.status).toBe(400);
    expect(mockedAuth).toHaveBeenCalledTimes(1);
  });

  it("traduit une panne Firestore en statut 503 (DEGRADED)", async () => {
    mockedOwner.mockResolvedValue({ id: SESSION_ID, ownerId: "user-1" } as never);
    const chain = eventsChain([]);
    chain.get.mockRejectedValueOnce(new Error("firestore unavailable"));
    const response = await GET(getRequest(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(response.status).toBe(503);
  });
});
