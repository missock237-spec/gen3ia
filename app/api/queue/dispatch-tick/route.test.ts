import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Receiver /api/queue/dispatch-tick (Task 62) — la boucle de dispatch
 * planifié hérite du contrat de sécurité de mission-tick : signature
 * QStash = authentification, config absente = 503, échec du publish du
 * successeur = 5xx (redélivrance), échec du dispatch lui-même = 500.
 */

vi.mock("@/lib/observability/logger", () => ({
  executionLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }),
  safeError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
}));
vi.mock("@/lib/agents/scheduler", () => ({ dispatchSchedules: vi.fn() }));
vi.mock("@/lib/queue/qstash", () => ({
  qstashConfig: vi.fn(),
  verifyUpstashSignature: vi.fn(),
  publishDispatchTick: vi.fn(),
}));
vi.mock("@/lib/queue/dispatch-loop", () => ({
  scheduleNextDispatchTick: vi.fn(),
  slotFor: vi.fn(() => Math.floor(Date.now() / 300_000)),
}));

import { dispatchSchedules } from "@/lib/agents/scheduler";
import { scheduleNextDispatchTick } from "@/lib/queue/dispatch-loop";
import { publishDispatchTick, qstashConfig, verifyUpstashSignature } from "@/lib/queue/qstash";
import { POST } from "./route";

const mockedConfig = vi.mocked(qstashConfig);
const mockedVerify = vi.mocked(verifyUpstashSignature);
const mockedPublish = vi.mocked(publishDispatchTick);
const mockedDispatch = vi.mocked(dispatchSchedules);
const mockedScheduleNext = vi.mocked(scheduleNextDispatchTick);

function request(body: string, signature: string | null = "v1,abc") {
  return new NextRequest("http://localhost/api/queue/dispatch-tick", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      ...(signature ? { "upstash-signature": signature } : {}),
    },
  });
}

const CONFIG = { token: "t", currentSigningKey: "c", nextSigningKey: "n" };

beforeEach(() => {
  vi.clearAllMocks();
  mockedConfig.mockReturnValue(CONFIG);
  process.env.GEN3IA_APP_ORIGIN = "https://gen3ia.online";
});

describe("POST /api/queue/dispatch-tick", () => {
  it("503 si la file n'est pas configurée (avant toute vérification)", async () => {
    mockedConfig.mockReturnValue(null);
    const response = await POST(request("{}"));
    expect(response.status).toBe(503);
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it("401 si la signature est invalide (avant tout parsing métier)", async () => {
    mockedVerify.mockReturnValue(false);
    const response = await POST(request('{"slotEpoch":1}'));
    expect(response.status).toBe(401);
    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it("413 si le corps dépasse le plafond défensif", async () => {
    mockedVerify.mockReturnValue(true);
    const response = await POST(request(JSON.stringify({ pad: "x".repeat(5_000) })));
    expect(response.status).toBe(413);
  });

  it("tick sain : dispatch exécuté + successeur publié → 200 détaillé", async () => {
    mockedVerify.mockReturnValue(true);
    mockedDispatch.mockResolvedValue({ checked: 3, due: 2, executed: [{ id: "s1" }] } as never);
    mockedScheduleNext.mockImplementation(async (_origin, _slot, _now, publish) => {
      // Exécute le vrai câblage : la callback fournie par la route doit
      // appeler publishDispatchTick avec les options du contrôleur.
      await publish({ delaySeconds: 250, slotEpoch: 42 });
      return { kind: "published", slotEpoch: 42, delaySeconds: 250 };
    });

    const response = await POST(request(JSON.stringify({ slotEpoch: 41 })));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.slotEpoch).toBe(41);
    expect(body.successor).toMatchObject({ kind: "published", slotEpoch: 42 });
    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect(mockedPublish).toHaveBeenCalledTimes(1);
    expect(mockedPublish.mock.calls[0]?.[0]).toBe("https://gen3ia.online");
    expect(mockedPublish.mock.calls[0]?.[1]).toMatchObject({ delaySeconds: 250, slotEpoch: 42 });
  });

  it("échec du publish du successeur → 502 (QStash redélivrera)", async () => {
    mockedVerify.mockReturnValue(true);
    mockedDispatch.mockResolvedValue({ checked: 3, due: 0, executed: [] } as never);
    mockedScheduleNext.mockResolvedValue({ kind: "publish-failed", slotEpoch: 42, error: "publish down" });

    const response = await POST(request(JSON.stringify({ slotEpoch: 41 })));
    expect(response.status).toBe(502);
  });

  it("échec du dispatch lui-même → 500", async () => {
    mockedVerify.mockReturnValue(true);
    mockedDispatch.mockRejectedValue(new Error("Firestore indisponible"));

    const response = await POST(request(JSON.stringify({ slotEpoch: 41 })));
    expect(response.status).toBe(500);
  });

  it("corps sans slotEpoch : le slot est déduit de l'horloge (défensif)", async () => {
    mockedVerify.mockReturnValue(true);
    mockedDispatch.mockResolvedValue({ checked: 0, due: 0, executed: [] } as never);
    mockedScheduleNext.mockResolvedValue({ kind: "already-scheduled", slotEpoch: 43 });

    const response = await POST(request("{}"));
    expect(response.status).toBe(200);
    expect(mockedScheduleNext).toHaveBeenCalledTimes(1);
    const fromSlot = mockedScheduleNext.mock.calls[0]?.[1];
    expect(typeof fromSlot).toBe("number");
  });
});
