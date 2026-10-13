import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Client Bland AI — tests comportementaux (fetch mocké, aucun réseau) :
 *  - authentification Bearer + erreurs normalisées (formats v1 et v2) ;
 *  - envoi d'appel (mapping des champs, garde « no call_id ») ;
 *  - normalisation des détails d'appel (transcripts, rôles, statuts) ;
 *  - vérification de signature webhook (HMAC-SHA256 hex).
 */

beforeEach(() => {
  vi.stubEnv("BLAND_API_KEY", "org_test_key_1234567890");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

import {
  createBlandAgent,
  getBlandCall,
  isBlandConfigured,
  normalizeBlandCallDetails,
  sendBlandCall,
  verifyBlandWebhookSignature,
} from "@/lib/integrations/bland/client";

describe("Client Bland — authentification et erreurs", () => {
  it("envoie l'en-tête authorization Bearer et le content-type JSON", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: "success", call_id: "call-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await sendBlandCall({ phoneNumber: "+237600000000", agentId: "agt-1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.bland.ai/v1/calls");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer org_test_key_1234567890");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.phone_number).toBe("+237600000000");
    expect(body.agent_id).toBe("agt-1");
    expect(body.record).toBe(true);
  });

  it("normalise les erreurs v1 ({ error, message }) en BlandError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "invalid_phone_number", message: "Phone number is invalid" }, 400)),
    );
    await expect(sendBlandCall({ phoneNumber: "+1", agentId: "agt-1" })).rejects.toMatchObject({
      name: "BlandError",
      status: 400,
      code: "invalid_phone_number",
      message: expect.stringContaining("Phone number is invalid") as unknown,
    });
  });

  it("normalise les erreurs v2 ({ data: null, errors: [...] }) en BlandError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { data: null, errors: [{ error: "INVALID_NAME", message: "name must be a non-empty string" }] },
          400,
        ),
      ),
    );
    await expect(createBlandAgent("  ")).rejects.toMatchObject({
      name: "BlandError",
      code: "INVALID_NAME",
      status: 400,
    });
  });

  it("refuse un appel sans call_id dans la réponse (garde anti-corps vide)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ status: "error" })));
    await expect(sendBlandCall({ phoneNumber: "+237600000000" })).rejects.toMatchObject({
      name: "BlandError",
      code: "NO_CALL_ID",
    });
  });

  it("isBlandConfigured suit la présence de la clé", async () => {
    expect(isBlandConfigured()).toBe(true);
    vi.stubEnv("BLAND_API_KEY", "");
    expect(isBlandConfigured()).toBe(false);
  });
});

describe("Normalisation des détails d'appel", () => {
  it("mappe les champs bruts (call_id/c_id, transcripts, rôles robot) vers Gen3ia", () => {
    const details = normalizeBlandCallDetails({
      c_id: "abc-123",
      status: "completed",
      completed: true,
      queue_status: "complete",
      answered_by: "human",
      call_ended_by: "ASSISTANT",
      call_length: 2.35,
      price: 0.09,
      recording_url: "https://rec.example/abc.mp3",
      summary: "Appel de test.",
      concatenated_transcript: "user: Allo\nassistant: Bonjour",
      transcripts: [
        { text: "Allo ?", user: "user", created_at: "2026-10-13T10:00:00Z" },
        { text: "Bonjour !", user: "assistant", created_at: "2026-10-13T10:00:05Z" },
        { text: "Pour joindre le service, tapez 1", user: "robot", created_at: "2026-10-13T10:00:07Z" },
        { text: "", user: "assistant" },
      ],
      metadata: { userId: "u1" },
      error_message: null,
    });

    expect(details.callId).toBe("abc-123");
    expect(details.completed).toBe(true);
    expect(details.answeredBy).toBe("human");
    expect(details.lengthMinutes).toBe(2.35);
    expect(details.recordingUrl).toBe("https://rec.example/abc.mp3");
    // robot (IVR) mappé en user ; tour vide ignoré.
    expect(details.transcripts).toEqual([
      { role: "user", text: "Allo ?", at: "2026-10-13T10:00:00Z" },
      { role: "assistant", text: "Bonjour !", at: "2026-10-13T10:00:05Z" },
      { role: "user", text: "Pour joindre le service, tapez 1", at: "2026-10-13T10:00:07Z" },
    ]);
  });

  it("getBlandCall interroge GET /v1/calls/{id} et normalise", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ call_id: "xyz", status: "in-progress", completed: false, queue_status: "active" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const details = await getBlandCall("xyz");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.bland.ai/v1/calls/xyz");
    expect(details.callId).toBe("xyz");
    expect(details.completed).toBe(false);
    expect(details.queueStatus).toBe("active");
  });
});

describe("Signature webhook Bland", () => {
  it("vérifie le HMAC-SHA256 hex du corps brut (comparaison exacte)", async () => {
    vi.stubEnv("BLAND_WEBHOOK_SECRET", "secret-bland");
    const { createHmac } = await import("node:crypto");
    const body = JSON.stringify({ call_id: "abc", status: "completed" });
    const signature = createHmac("sha256", "secret-bland").update(body, "utf8").digest("hex");

    expect(verifyBlandWebhookSignature(body, signature)).toBe(true);
    expect(verifyBlandWebhookSignature(body + " ", signature)).toBe(false);
    expect(verifyBlandWebhookSignature(body, "deadbeef")).toBe(false);
    expect(verifyBlandWebhookSignature(body, null)).toBe(false);
  });

  it("retourne false sans secret configuré (mode bootstrap — le webhook journalise)", async () => {
    vi.stubEnv("BLAND_WEBHOOK_SECRET", "");
    expect(verifyBlandWebhookSignature("{}", "signature")).toBe(false);
  });
});
