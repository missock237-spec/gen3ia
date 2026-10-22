import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

/**
 * CONTRAT D'ATTACHMENTS — les DEUX routes de message (stream NDJSON et
 * repli non-stream) doivent accepter un attachment COMPLET sans perte de
 * champs. Avant réparation, la route non-stream strippait fileId /
 * fileKind / charCount / rowCount (divergence zod) : le contenu importé
 * devenait introuvable pour le moteur alors que le flux le conservait.
 */

vi.mock("@/lib/security/authenticated-request", () => ({
  requireUser: vi.fn(),
}));
vi.mock("@/lib/security/http-errors", () => ({
  errorBody: vi.fn((_error: unknown, message: string) => ({ error: message })),
  errorStatus: vi.fn(() => 400),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  clientIp: vi.fn(() => "127.0.0.1"),
}));
vi.mock("@/lib/cache/redis", () => ({
  rateLimitDistributed: vi.fn(),
}));
vi.mock("@/lib/domain/conversations/engine", () => ({
  runConversationTurn: vi.fn(),
}));
vi.mock("@/lib/billing/execution-gate", () => ({
  runWithExecutionBilling: vi.fn(),
  openExecutionBilling: vi.fn(),
}));

import { rateLimitDistributed } from "@/lib/cache/redis";
import { runWithExecutionBilling, openExecutionBilling } from "@/lib/billing/execution-gate";
import { requireUser } from "@/lib/security/authenticated-request";
import { runConversationTurn } from "@/lib/domain/conversations/engine";
import { POST as POST_NON_STREAM } from "./route";
import { POST as POST_STREAM } from "./stream/route";

const mockedRequireUser = vi.mocked(requireUser);
const mockedRateLimit = vi.mocked(rateLimitDistributed);
const mockedRunTurn = vi.mocked(runConversationTurn);
const mockedRunBilling = vi.mocked(runWithExecutionBilling);
const mockedOpenBilling = vi.mocked(openExecutionBilling);

const ATTACHMENT_COMPLET = {
  filename: "ventes.csv",
  path: "users/user-1/permanent/ventes.csv",
  contentType: "text/csv",
  sizeBytes: 30,
  fileId: "file-123",
  fileKind: "csv",
  charCount: 42,
  rowCount: 3,
};

function messageRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRequireUser.mockResolvedValue({ uid: "user-1" } as never);
  mockedRateLimit.mockResolvedValue({ allowed: true, remaining: 39, retryAfterMs: 0, distributed: true });
  mockedRunTurn.mockResolvedValue({ assistantMessage: { content: "ok" } } as never);
  mockedRunBilling.mockImplementation(({ fn }) => fn().then((result) => ({ result, billing: { label: "test" } })) as never);
  mockedOpenBilling.mockResolvedValue({
    run: async (fn: () => Promise<unknown>) => {
      await fn();
    },
    settle: async () => ({
      label: "test",
      currency: "EUR",
      chargeMinor: 0,
      reservedMinor: 0,
      providerCostEur: 0,
      marginEur: 0,
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    }),
    release: async () => undefined,
  } as never);
});

describe("contrat zod des attachments — stream ET non-stream alignés", () => {
  it("la route non-stream conserve fileId/fileKind/charCount/rowCount", async () => {
    const request = messageRequest("https://gen3ia.local/api/workspace/conversations/conv-1/messages", {
      message: "Analyse ce fichier",
      attachments: [ATTACHMENT_COMPLET],
    });
    const response = await POST_NON_STREAM(request, { params: Promise.resolve({ conversationId: "conv-1" }) });
    expect(response.status).toBe(200);

    const transmitted = mockedRunTurn.mock.calls[0]?.[0];
    expect(transmitted.attachments?.[0]).toMatchObject({
      filename: "ventes.csv",
      fileId: "file-123",
      fileKind: "csv",
      charCount: 42,
      rowCount: 3,
    });
  });

  it("la route stream conserve fileId/fileKind/charCount/rowCount", async () => {
    const request = messageRequest("https://gen3ia.local/api/workspace/conversations/conv-1/messages/stream", {
      message: "Analyse ce fichier",
      attachments: [ATTACHMENT_COMPLET],
    });
    const response = await POST_STREAM(request, { params: Promise.resolve({ conversationId: "conv-1" }) });
    expect(response.status).toBe(200);
    await response.text(); // draine le flux NDJSON

    const transmitted = mockedRunTurn.mock.calls[0]?.[0];
    expect(transmitted.attachments?.[0]).toMatchObject({
      filename: "ventes.csv",
      fileId: "file-123",
      fileKind: "csv",
      charCount: 42,
      rowCount: 3,
    });
  });

  it("un attachment minimal (flux historiques) reste accepté par les deux routes", async () => {
    for (const POST of [POST_NON_STREAM, POST_STREAM]) {
      mockedRunTurn.mockClear();
      const request = messageRequest("https://gen3ia.local/api/workspace/conversations/conv-1/messages", {
        message: "Analyse ce fichier",
        attachments: [{ filename: "rapport.pdf", path: "users/user-1/permanent/rapport.pdf" }],
      });
      const response = await POST(request, { params: Promise.resolve({ conversationId: "conv-1" }) });
      expect(response.status).toBe(200);
      if (POST === POST_STREAM) await response.text();
      expect(mockedRunTurn).toHaveBeenCalledOnce();
    }
  });
});
