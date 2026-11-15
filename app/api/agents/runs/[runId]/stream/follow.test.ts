import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Suivi des missions en file (recommandation A) : GET /api/agents/runs/[runId]
 * et GET /api/agents/runs/[runId]/stream. Scopage propriétaire strict (404
 * anti-énumération), format SSE contractuel (progress / final, fenêtre bornée,
 * reconnect implicite d'EventSource).
 */

vi.mock("@/lib/security/authenticated-request", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/queue/mission-queue", () => ({ getMissionRun: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  executionLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }),
  safeError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
}));

import { requireUser } from "@/lib/security/authenticated-request";
import { getMissionRun } from "@/lib/queue/mission-queue";
import { HttpError } from "@/lib/security/http-errors";
import { GET as GET_STATUS } from "../route";
import { GET as GET_STREAM } from "./route";

const mockedRequireUser = vi.mocked(requireUser);
const mockedGet = vi.mocked(getMissionRun);

const RUN_ID = "0f0e0d0c-1111-2222-3333-444455556666";

const RECORD = {
  runId: RUN_ID,
  userId: "user-1",
  executionId: "exec-1",
  objective: "Étude de marché",
  status: "running" as const,
  attempts: 2,
  leaseUntilMs: Date.now() + 30_000,
  timeline: [{ id: "s1", name: "Recherche", type: "llm", status: "completed" }],
  pendingCount: 1,
  createdAtMs: 1,
  updatedAtMs: 42,
};

function statusRequest(runId = RUN_ID): NextRequest {
  return new NextRequest(`https://gen3ia.local/api/agents/runs/${runId}`, { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRequireUser.mockResolvedValue({ uid: "user-1" } as never);
  mockedGet.mockResolvedValue(structuredClone(RECORD) as never);
});

describe("GET /api/agents/runs/[runId] — statut", () => {
  it("400 sur runId mal formé (sans toucher au stockage)", async () => {
    const response = await GET_STATUS(statusRequest("../etc/passwd"), { params: Promise.resolve({ runId: "../etc/passwd" }) });
    expect(response.status).toBe(400);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("200 avec statut, timeline, compteur — JAMAIS le plan ni les payloads bruts", async () => {
    const response = await GET_STATUS(statusRequest(), { params: Promise.resolve({ runId: RUN_ID }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json();
    expect(payload).toMatchObject({ runId: RUN_ID, status: "running", pendingCount: 1, attempts: 2 });
    expect(payload.timeline).toHaveLength(1);
    expect(payload.plan).toBeUndefined();
    expect(payload.outputs).toBeUndefined();
  });

  it("404 anti-énumération : mission inconnue OU appartenant à un autre utilisateur", async () => {
    mockedGet.mockResolvedValueOnce(null);
    const notFound = await GET_STATUS(statusRequest(), { params: Promise.resolve({ runId: RUN_ID }) });
    expect(notFound.status).toBe(404);
    // Le scoping propriétaire est passé à getMissionRun (userId du holder).
    mockedGet.mockResolvedValueOnce(null);
    const foreign = await GET_STATUS(statusRequest(), { params: Promise.resolve({ runId: RUN_ID }) });
    expect(foreign.status).toBe(404);
    expect(mockedGet).toHaveBeenCalledWith("user-1", RUN_ID);
  });

  it("401 structuré sans session", async () => {
    mockedRequireUser.mockRejectedValueOnce(new HttpError(401, "Auth requise", "AUTH_REQUIRED"));
    const response = await GET_STATUS(statusRequest(), { params: Promise.resolve({ runId: RUN_ID }) });
    expect(response.status).toBe(401);
  });
});

describe("GET /api/agents/runs/[runId]/stream — SSE", () => {
  function streamRequest(runId = RUN_ID): NextRequest {
    return new NextRequest(`https://gen3ia.local/api/agents/runs/${runId}/stream`, { method: "GET" });
  }

  async function readEvents(response: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    // Lecture bornée : la route ferme elle-même le flux (statut terminal).
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.length > 64_000) break;
        const parts = text.split("\n\n");
        text = parts.pop() ?? "";
        for (const part of parts) {
          const eventMatch = part.match(/^event: (.+)$/m);
          const dataMatch = part.match(/^data: (.+)$/m);
          if (eventMatch && dataMatch) {
            try { events.push({ event: eventMatch[1], data: JSON.parse(dataMatch[1]) }); } catch { /* fin */ }
          }
        }
        if (events.some((event) => event.event === "final")) break;
      }
    } catch { /* flux fermé */ }
    try { await reader.cancel(); } catch { /* déjà fermé */ }
    return events;
  }

  it("401 sans session (aucun flux anonyme)", async () => {
    mockedRequireUser.mockRejectedValueOnce(new HttpError(401, "Auth requise", "AUTH_REQUIRED"));
    const response = await GET_STREAM(streamRequest(), { params: Promise.resolve({ runId: RUN_ID }) });
    expect(response.status).toBe(401);
  });

  it("400 sur runId mal formé", async () => {
    const response = await GET_STREAM(streamRequest("x"), { params: Promise.resolve({ runId: "x" }) });
    expect(response.status).toBe(400);
  });

  it("en-têtes SSE corrects (jamais de buffering proxy)", async () => {
    mockedGet.mockResolvedValueOnce({ ...RECORD, status: "completed" } as never);
    const response = await GET_STREAM(streamRequest(), { params: Promise.resolve({ runId: RUN_ID }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    await readEvents(response);
  });

  it("mission déjà complétée au premier relevé → progress + final immédiats", async () => {
    mockedGet.mockResolvedValue({ ...RECORD, status: "completed", completedAtMs: 99 } as never);
    const response = await GET_STREAM(streamRequest(), { params: Promise.resolve({ runId: RUN_ID }) });
    const events = await readEvents(response);
    // Le premier relevé reflète l'état RÉEL du document (completed ici).
    expect(events[0].event).toBe("progress");
    expect(events[0].data.status).toBe("completed");
    expect(events.at(-1)?.event).toBe("final");
    expect(events.at(-1)?.data.status).toBe("completed");
  });

  it("mission inconnue → final not_found immédiat", async () => {
    mockedGet.mockResolvedValue(null);
    const response = await GET_STREAM(streamRequest(), { params: Promise.resolve({ runId: RUN_ID }) });
    const events = await readEvents(response);
    expect(events).toEqual([{ event: "final", data: { runId: RUN_ID, status: "not_found" } }]);
  });

  it("déduplication : aucun progress tant que le document est inchangé", async () => {
    let polls = 0;
    mockedGet.mockImplementation(async () => {
      polls++;
      // polls 1-2 : document IDENTIQUE (aucun événement) ; poll 3 : transition
      // vers paused-utilisateur → progress + final + fermeture du flux.
      return polls < 3 ? { ...RECORD } : { ...RECORD, status: "paused" as const };
    });
    const response = await GET_STREAM(streamRequest(), { params: Promise.resolve({ runId: RUN_ID }) });
    const events = await readEvents(response);
    const progressStatuses = events.filter((event) => event.event === "progress").map((event) => event.data.status);
    expect(progressStatuses).toEqual(["running", "paused"]); // l'invariant n'a JAMAIS été re-émis entre les deux
    expect(events.at(-1)?.event).toBe("final");
    expect(events.at(-1)?.data.status).toBe("paused");
  });
});
