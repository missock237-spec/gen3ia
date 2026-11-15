import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tool « webhook.heal » (Task 140) — passerelle webhook auto-réparatrice.
 *
 * Verrous :
 *  1. diagnostic déterministe dans l'ordre spec (auth → rate_limited → 5xx →
 *     timeout → payload_size → schema_mismatch → network → unknown) ;
 *  2. 401 + endpoint DÉCLARÉ → corps resigné en HMAC-SHA256 (en-tête
 *     x-gen3ia-signature), en-tête x-gen3ia-event transmis ;
 *  3. schema_mismatch → adaptation IA de la charge (corps envoyé vérifié) ;
 *     échec IA → charge d'origine rejouée, jamais bloquée ;
 *  4. rate_limited → attente (Retry-After borné à 5 s) PUIS rejeu unique ;
 *  5. rejeu 5xx → ok:false + recommandation française ;
 *  6. URL bloquée par la garde SSRF → erreur française, aucun fetch.
 *
 * Frontières moquées : fetch (global), generateForUser (LLM facturé),
 * listOutgoingWebhooks (registre utilisateur), assertPublicHttpUrl (SSRF).
 * signWebhookPayload reste RÉEL (fonction pure) pour vérifier la signature.
 */

const generateMock = vi.hoisted(() => vi.fn());
const listOutgoingWebhooksMock = vi.hoisted(() => vi.fn());
const assertPublicHttpUrlMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: (...args: unknown[]) => generateMock(...args),
}));

vi.mock("@/lib/integrations/webhooks/store", () => ({
  listOutgoingWebhooks: (...args: unknown[]) => listOutgoingWebhooksMock(...args),
  listActiveEndpointsForEvent: vi.fn(async () => []),
}));

vi.mock("@/lib/security/url-safety", () => ({
  assertPublicHttpUrl: (...args: unknown[]) => assertPublicHttpUrlMock(...args),
}));

import { signWebhookPayload } from "@/lib/integrations/webhooks/emit";
import { webhookHealTool } from "./webhook-heal";

const CONTEXT = { userId: "user-1", executionId: "exec-heal-1" };
const TARGET = "https://hooks.exemple.com/dest";
const MAX_PAYLOAD_BYTES = 256 * 1024;

const fetchMock = vi.fn();

interface FetchCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal };
}

function lastFetchCall(): FetchCall {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as unknown[];
  return { url: String(call[0]), init: call[1] as FetchCall["init"] };
}

beforeEach(() => {
  generateMock.mockReset();
  listOutgoingWebhooksMock.mockReset().mockResolvedValue([]);
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
  assertPublicHttpUrlMock.mockReset().mockImplementation(async (url: string) => {
    if (url.includes("169.254") || url.includes("localhost") || url.includes("127.0.0.1")) {
      throw new Error("Access to private IP addresses is blocked.");
    }
    return new URL(url);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ──────────────────────────────────────────────────────────────────── */
/* (a) 401 + endpoint déclaré → signature HMAC                          */
/* ──────────────────────────────────────────────────────────────────── */

describe("webhook.heal — auth : signature HMAC de l'endpoint déclaré", () => {
  it("(a) resigne le corps et retransmet x-gen3ia-event, rejeu OK", async () => {
    listOutgoingWebhooksMock.mockResolvedValue([
      {
        id: "wh-1",
        ownerId: "user-1",
        url: TARGET,
        events: ["execution.completed"],
        disabled: false,
        createdAt: Date.now(),
        secret: "topsecret",
      },
    ]);

    const result = await webhookHealTool.execute(
      {
        endpointUrl: TARGET,
        payload: { hello: "world" },
        lastStatus: 401,
        headers: { "x-gen3ia-event": "execution.completed" },
      },
      CONTEXT,
    );

    expect(result.diagnosis.type).toBe("auth");
    expect(result.diagnosis.strategy).toMatch(/HMAC/i);
    expect(listOutgoingWebhooksMock).toHaveBeenCalledWith("user-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const call = lastFetchCall();
    expect(call.url).toBe(TARGET);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers["content-type"]).toBe("application/json");
    expect(call.init.headers["x-gen3ia-event"]).toBe("execution.completed");
    // Signature vérifiée avec la VRAIE fonction (HMAC du corps final).
    expect(call.init.headers["x-gen3ia-signature"]).toBe(
      signWebhookPayload("topsecret", JSON.stringify({ hello: "world" })),
    );
    expect(result.retry).toMatchObject({ attempted: true, status: 200, ok: true });
    expect(typeof result.retry.latencyMs).toBe("number");
    expect(result.adaptations.some((note) => note.includes("resigné"))).toBe(true);
  });

  it("(a-bis) 401 + endpoint NON déclaré → note explicite, aucune signature envoyée", async () => {
    const result = await webhookHealTool.execute(
      { endpointUrl: TARGET, payload: { a: 1 }, lastStatus: 401 },
      CONTEXT,
    );
    expect(result.diagnosis.type).toBe("auth");
    expect(lastFetchCall().init.headers["x-gen3ia-signature"]).toBeUndefined();
    expect(result.adaptations.some((note) => note.includes("endpoint non déclaré"))).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* (b) schema_mismatch → adaptation IA (fail-soft)                      */
/* ──────────────────────────────────────────────────────────────────── */

describe("webhook.heal — schema_mismatch : adaptation IA de la charge", () => {
  it("(b) adapte la charge selon le schéma attendu et envoie la version adaptée", async () => {
    generateMock.mockImplementation(async (_call: { request: { system: string } }) => ({
      chargeMinor: 1,
      providerCostEur: 0,
      response: {
        text: JSON.stringify({
          payload: { orderRef: "A-1", montant: 12 },
          explanation: "champ « order » renommé en « orderRef » comme attendu",
        }),
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    }));

    const result = await webhookHealTool.execute(
      { endpointUrl: TARGET, payload: { order: "A-1", amount: 12 }, lastStatus: 422 },
      CONTEXT,
    );

    expect(result.diagnosis.type).toBe("schema_mismatch");
    expect(generateMock).toHaveBeenCalledTimes(1);
    const llmCall = generateMock.mock.calls[0]?.[0] as { request: { task: string; maxTokens: number; messages: Array<{ content: string }> } };
    expect(llmCall.request.task).toBe("automation");
    expect(llmCall.request.maxTokens).toBe(1_200);
    expect(llmCall.request.messages[0]?.content).toContain('"order"');

    const sent = JSON.parse(lastFetchCall().init.body);
    expect(sent).toEqual({ orderRef: "A-1", montant: 12 });
    expect(result.adaptations.some((note) => note.includes("orderRef"))).toBe(true);
    expect(result.retry).toMatchObject({ attempted: true, ok: true });
  });

  it("(b-bis) échec de l'adaptation IA → charge D'ORIGINE rejouée avec note, rejeu jamais bloqué", async () => {
    generateMock.mockImplementation(async () => {
      throw new Error("Le modèle n'a pas produit une réponse conforme au format attendu après 2 tentative(s).");
    });

    const result = await webhookHealTool.execute(
      {
        endpointUrl: TARGET,
        payload: { order: "A-1" },
        lastError: "field 'orderRef' is required",
      },
      CONTEXT,
    );

    expect(result.diagnosis.type).toBe("schema_mismatch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(lastFetchCall().init.body)).toEqual({ order: "A-1" });
    expect(result.adaptations.some((note) => note.includes("charge d'origine conservée"))).toBe(true);
    expect(result.retry.attempted).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* (c) rate_limited → attente bornée avant rejeu                        */
/* ──────────────────────────────────────────────────────────────────── */

describe("webhook.heal — rate_limited : attente avant rejeu", () => {
  it("(c) attend 5 s par défaut puis rejoue une seule fois", async () => {
    vi.useFakeTimers();
    const pending = webhookHealTool.execute(
      { endpointUrl: TARGET, payload: { n: 1 }, lastStatus: 429 },
      CONTEXT,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(result.diagnosis.type).toBe("rate_limited");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.retry).toMatchObject({ attempted: true, ok: true });
    expect(result.adaptations.some((note) => note.includes("5000 ms"))).toBe(true);
  });

  it("(c-bis) honore Retry-After quand il est plus court (2 s)", async () => {
    vi.useFakeTimers();
    const pending = webhookHealTool.execute(
      { endpointUrl: TARGET, payload: { n: 1 }, lastStatus: 429, lastError: "Too Many Requests — Retry-After: 2" },
      CONTEXT,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(result.adaptations.some((note) => note.includes("2000 ms"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* (d) rejeu qui échoue + recommandations                               */
/* ──────────────────────────────────────────────────────────────────── */

describe("webhook.heal — rejeu en échec et recommandations", () => {
  it("(d) rejeu 5xx → ok:false avec recommandation française", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    const result = await webhookHealTool.execute(
      { endpointUrl: TARGET, payload: { n: 1 }, lastStatus: 500 },
      CONTEXT,
    );
    expect(result.diagnosis.type).toBe("server_error");
    expect(result.retry).toMatchObject({ attempted: true, status: 503, ok: false });
    expect(result.recommendation).toMatch(/destinataire/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("(d-bis) échec réseau du rejeu → erreur capturée sans crash", async () => {
    fetchMock.mockRejectedValue(new Error("fetch failed"));
    const result = await webhookHealTool.execute(
      { endpointUrl: TARGET, payload: { n: 1 }, lastStatus: 504 },
      CONTEXT,
    );
    expect(result.retry.attempted).toBe(true);
    expect(result.retry.ok).toBeUndefined();
    expect(result.retry.error).toContain("fetch failed");
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* (e) SSRF + diagnostics restants                                     */
/* ──────────────────────────────────────────────────────────────────── */

describe("webhook.heal — garde SSRF et autres diagnostics", () => {
  it("(e) URL privée → erreur française, AUCUN fetch émis", async () => {
    await expect(
      webhookHealTool.execute(
        { endpointUrl: "http://169.254.169.254/hook", payload: { n: 1 }, lastStatus: 500 },
        CONTEXT,
      ),
    ).rejects.toThrow(/protection SSRF/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listOutgoingWebhooksMock).not.toHaveBeenCalled();
  });

  it("payload_size → charge remplacée par un aperçu tronqué", async () => {
    const result = await webhookHealTool.execute(
      { endpointUrl: TARGET, payload: { blob: "x".repeat(300_000) } },
      CONTEXT,
    );
    expect(result.diagnosis.type).toBe("payload_size");
    const sent = JSON.parse(lastFetchCall().init.body);
    expect(sent.truncated).toBe(true);
    expect(sent.originalSizeBytes).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    expect(sent.preview).toHaveLength(1_024);
    expect(sent.preview).toContain("blob");
    expect(result.recommendation).toMatch(/hors bande/);
  });

  it("timeout / network / unknown — classifications déterministes", async () => {
    const timeout = await webhookHealTool.execute(
      { endpointUrl: TARGET, payload: { n: 1 }, lastError: "Request aborted: timeout after 8000ms" },
      CONTEXT,
    );
    expect(timeout.diagnosis.type).toBe("timeout");

    const network = await webhookHealTool.execute(
      { endpointUrl: TARGET, payload: { n: 1 }, lastError: "getaddrinfo ENOTFOUND hooks.exemple.com" },
      CONTEXT,
    );
    expect(network.diagnosis.type).toBe("network");

    const unknown = await webhookHealTool.execute({ endpointUrl: TARGET, payload: { n: 1 } }, CONTEXT);
    expect(unknown.diagnosis.type).toBe("unknown");
    expect(unknown.recommendation).toMatch(/console Gen3ia/);
  });

  it("impose application/json et retire les en-têtes de transport du rejeu", async () => {
    const result = await webhookHealTool.execute(
      {
        endpointUrl: TARGET,
        payload: { n: 1 },
        headers: { "Content-Type": "text/xml", "X-Custom": "valeur", "Content-Length": "999" },
      },
      CONTEXT,
    );
    const headers = lastFetchCall().init.headers;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["content-length"]).toBeUndefined();
    expect(headers["x-custom"]).toBe("valeur");
    expect(result.adaptations.some((note) => note.includes("content-length"))).toBe(true);
  });

  it("priorité du statut sur la taille : 401 + charge lourde → auth", async () => {
    const result = await webhookHealTool.execute(
      { endpointUrl: TARGET, payload: { blob: "x".repeat(300_000) }, lastStatus: 401 },
      CONTEXT,
    );
    expect(result.diagnosis.type).toBe("auth");
  });
});
