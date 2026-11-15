import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

// Contrat HTTP de la route isolé : le point testé est le mapping du
// retryAfterMs du rate limiter vers l'en-tête Retry-After (audit 25-c).
vi.mock("@/lib/security/route-guard", () => ({
  protectRoute: vi.fn(),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  enforceRateLimit: vi.fn(),
}));

vi.mock("@/lib/execution/execution-gateway", () => ({
  executeThroughGateway: vi.fn(),
}));

vi.mock("@/lib/security/agent-policy", () => ({
  // Forme réaliste (la route dérive sa copie par spread de allowedTools).
  createAgentPolicy: vi.fn(() => ({
    allowedTools: ["web.search", "file.read", "file.create"],
    permissions: [
      "tool.read",
      "tool.write",
      "file.read",
      "file.write",
      "file.create",
      "network.read",
    ],
  })),
}));

vi.mock("@/lib/tools", () => ({
  executeTool: vi.fn(),
}));

import { protectRoute } from "@/lib/security/route-guard";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { executeThroughGateway } from "@/lib/execution/execution-gateway";
import { createAgentPolicy } from "@/lib/security/agent-policy";
import { executeTool } from "@/lib/tools";
import { POST } from "./route";

const mockedProtect = vi.mocked(protectRoute);
const mockedEnforce = vi.mocked(enforceRateLimit);
const mockedGateway = vi.mocked(executeThroughGateway);
const mockedCreatePolicy = vi.mocked(createAgentPolicy);
const mockedExecuteTool = vi.mocked(executeTool);

function postRequest(body: unknown): NextRequest {
  return new NextRequest("https://gen3ia.local/api/tools/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedProtect.mockResolvedValue({
    ok: true,
    context: { userId: "user-1", traceId: "trc_test" },
  } as never);
  mockedGateway.mockResolvedValue({ result: "ok" } as never);
});

describe("POST /api/tools/execute — en-tête Retry-After sur 429", () => {
  it("expose Retry-After en secondes entières (45 000 ms => 45)", async () => {
    mockedEnforce.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 45_000, distributed: true });
    const response = await POST(postRequest({ toolName: "web.search", input: {} }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("45");
    const body = await response.json();
    expect(body.success).toBe(false);
    // Le corps conserve retryAfterMs (compatibilité clients existants).
    expect(body.retryAfterMs).toBe(45_000);
    expect(mockedGateway).not.toHaveBeenCalled();
  });

  it("arrondit au-dessus (1 500 ms => 2 s) : le client ne réessaie pas trop tôt", async () => {
    mockedEnforce.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 1_500, distributed: true });
    const response = await POST(postRequest({ toolName: "web.search" }));
    expect(response.headers.get("retry-after")).toBe("2");
  });

  it("garantit un Retry-After >= 1 s même quand le délai résiduel est nul", async () => {
    mockedEnforce.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 0, distributed: true });
    const response = await POST(postRequest({ toolName: "web.search" }));
    expect(response.headers.get("retry-after")).toBe("1");
  });

  it("limiteur appelé avec la clé par utilisateur (30/min) avant toute exécution", async () => {
    mockedEnforce.mockResolvedValue({ allowed: true, remaining: 29, retryAfterMs: 0, distributed: true });
    const response = await POST(postRequest({ toolName: "web.search", input: {} }));
    expect(mockedEnforce).toHaveBeenCalledWith("tools:user-1", { limit: 30, windowMs: 60_000 });
    expect(response.status).toBe(200);
    expect(mockedGateway).toHaveBeenCalledOnce();
  });
});

describe("POST /api/tools/execute — politique console étendue aux outils médias (Task 103-a)", () => {
  it("dérive la politique du standard et y ajoute les 4 outils médias (voix, image, vidéo)", async () => {
    mockedEnforce.mockResolvedValue({ allowed: true, remaining: 29, retryAfterMs: 0, distributed: true });
    const response = await POST(postRequest({ toolName: "voice.speak", input: {} }));
    expect(response.status).toBe(200);
    // La copie part bien du niveau « standard » partagé (non modifié).
    expect(mockedCreatePolicy).toHaveBeenCalledWith("standard");
    const request = mockedGateway.mock.calls[0][0];
    expect(request.policy.allowedTools).toEqual(
      expect.arrayContaining([
        // Outils du standard…
        "web.search",
        "file.read",
        "file.create",
        // …étendus des outils médias réels (audit 2026-10-07).
        "voice.speak",
        "voice.list",
        "image.generate",
        "video.create",
      ]),
    );
  });

  it("un outil média traverse le gateway et atteint executeTool avec la même politique étendue", async () => {
    mockedEnforce.mockResolvedValue({ allowed: true, remaining: 28, retryAfterMs: 0, distributed: true });
    mockedExecuteTool.mockResolvedValue({ success: true, output: { spoken: true } } as never);
    // Le gateway factice exécute réellement le callback de la route.
    mockedGateway.mockImplementation(async (request) => request.execute());
    const response = await POST(
      postRequest({ toolName: "image.generate", input: { prompt: "Un chat astronaute" } }),
    );
    expect(response.status).toBe(200);
    expect(mockedExecuteTool).toHaveBeenCalledOnce();
    const toolRequest = mockedExecuteTool.mock.calls[0][0];
    expect(toolRequest.toolName).toBe("image.generate");
    expect(toolRequest.policy.allowedTools).toContain("image.generate");
    const body = await response.json();
    expect(body).toEqual({ success: true, result: { spoken: true } });
  });
});
