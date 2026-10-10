import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FILE DE TICKS R2 (remplacement de QStash) — tests unitaires :
 *  - signature interne : HMAC dérivé du secret R2, temps constant, fraîcheur ;
 *  - activation : R2 + secret + origine canonique requis ;
 *  - nudge opportuniste : throttlé par processus ;
 *  - vérification : bearer CRON_SECRET accepté, signature invalide rejetée.
 */

const r2Mocks = vi.hoisted(() => ({
  isR2Configured: vi.fn(() => true),
  putObjectConditional: vi.fn(),
  getObjectWithEtag: vi.fn(),
  deleteObject: vi.fn(),
  listObjectsUnderPrefix: vi.fn(),
}));

vi.mock("@/lib/storage/r2", () => ({
  isR2Configured: r2Mocks.isR2Configured,
  putObjectConditional: r2Mocks.putObjectConditional,
  getObjectWithEtag: r2Mocks.getObjectWithEtag,
  deleteObject: r2Mocks.deleteObject,
  listObjectsUnderPrefix: r2Mocks.listObjectsUnderPrefix,
}));

vi.mock("@/lib/queue/origin", () => ({
  resolveJobOrigin: vi.fn(() => ({ ok: true, origin: "https://gen3ia.online" })),
  assertSafeDestinationUrl: vi.fn(),
}));

import {
  signTickBody,
  verifyTickSignature,
  verifyTickRequest,
  tickQueueConfigured,
  tickSignatureKey,
  enqueueMissionTick,
  nudgePumpFromPolling,
  pumpDueTicks,
} from "./tick-queue";

// Valeur FACTICE à faible entropie (convention du dépôt, cf. .gitleaks.toml) :
// jamais un vrai secret — sert uniquement à dériver la clé de signature des tests.
const CLE_R2_FACTICE = "cle-r2-factice-pour-les-tests-gen3ia";

beforeEach(() => {
  process.env.R2_ACCOUNT_ID = "acct";
  process.env.R2_ACCESS_KEY_ID = "key";
  process.env.R2_SECRET_ACCESS_KEY = CLE_R2_FACTICE;
  process.env.R2_BUCKET = "bucket";
  delete process.env.CRON_SECRET;
  vi.clearAllMocks();
});

describe("tickQueueConfigured — activation de la file", () => {
  it("activée quand R2 est configuré (le secret de signature en est dérivé)", () => {
    expect(tickQueueConfigured()).toBe(true);
  });

  it("désactivée quand R2 n'est pas configuré", () => {
    const previous = r2Mocks.isR2Configured;
    const previousSecret = process.env.R2_SECRET_ACCESS_KEY;
    r2Mocks.isR2Configured.mockReturnValueOnce(false);
    delete process.env.R2_SECRET_ACCESS_KEY;
    expect(tickQueueConfigured()).toBe(false);
    expect(tickSignatureKey()).toBe(null);
    process.env.R2_SECRET_ACCESS_KEY = previousSecret;
    r2Mocks.isR2Configured.mockReturnValue(true);
    void previous;
  });
});

describe("Signature interne des ticks", () => {
  it("signe puis vérifie un corps (aller-retour exact)", () => {
    const body = JSON.stringify({ runId: "0f0e0d0c-1111-2222-3333-444455556666" });
    const signature = signTickBody(body);
    expect(signature).toMatch(/^v1\.\d+\.[0-9a-f]{64}$/);
    expect(verifyTickSignature(body, signature)).toBe(true);
  });

  it("rejette un corps modifié après signature (anti-falsification)", () => {
    const signature = signTickBody('{"runId":"aaa"}');
    expect(verifyTickSignature('{"runId":"bbb"}', signature)).toBe(false);
  });

  it("rejette une signature périmée (anti-replay > 300 s)", () => {
    const body = "{}";
    const staleTs = Date.now() - 400_000;
    const key = tickSignatureKey() as string;
    const hmac = createHmac("sha256", key).update(`${staleTs}\n${body}`).digest("hex");
    expect(verifyTickSignature(body, `v1.${staleTs}.${hmac}`)).toBe(false);
  });

  it("rejette un format de header invalide (silence, jamais d'exception)", () => {
    for (const header of [null, "", "v2.1.2", "v1 abc", "v1.."]) {
      expect(verifyTickSignature("{}", header as string | null)).toBe(false);
    }
  });

  it("l'horodatage embarqué est frais (la fenêtre anti-replay est jouable)", () => {
    const signature = signTickBody("{}");
    const ts = Number(signature.split(".")[1]);
    expect(Math.abs(Date.now() - ts)).toBeLessThanOrEqual(2_000);
  });
});

describe("verifyTickRequest — authentification des receivers", () => {
  it("accepte la signature interne valide", () => {
    const body = '{"runId":"x"}';
    expect(verifyTickRequest(body, null, signTickBody(body))).toBe(true);
  });

  it("accepte le bearer CRON_SECRET (cron Vercel / sonde)", () => {
    process.env.CRON_SECRET = "cron-secret-test";
    expect(verifyTickRequest("{}", "Bearer cron-secret-test", null)).toBe(true);
  });

  it("rejette un bearer CRON_SECRET erroné", () => {
    process.env.CRON_SECRET = "cron-secret-test";
    expect(verifyTickRequest("{}", "Bearer wrong", null)).toBe(false);
  });

  it("rejette tout sans signature ni secret configuré", () => {
    expect(verifyTickRequest("{}", null, null)).toBe(false);
    expect(verifyTickRequest("{}", "Bearer anything", null)).toBe(false);
  });
});

describe("enqueueMissionTick — écriture du ticket R2", () => {
  it("écrit un ticket via création conditionnelle (If-None-Match:*) et délivre", async () => {
    r2Mocks.putObjectConditional.mockResolvedValue({ etag: '"e1"' });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: { cancel: () => Promise.resolve() },
    }) as unknown as typeof fetch;

    const result = await enqueueMissionTick("0f0e0d0c-1111-2222-3333-444455556666");

    expect(result).toMatchObject({ ok: true, mode: "r2-queue" });
    expect(r2Mocks.putObjectConditional).toHaveBeenCalledTimes(1);
    const [key, bodyBuffer, , opts] = r2Mocks.putObjectConditional.mock.calls[0];
    expect(String(key)).toMatch(/^queue\/tickets\/v1\/\d{16}-[0-9a-f-]+\.json$/);
    expect(opts).toEqual({ ifNoneMatch: "*" });
    const document = JSON.parse(Buffer.from(bodyBuffer as Buffer).toString("utf8"));
    expect(document).toMatchObject({ kind: "mission-tick", path: "/api/queue/mission-tick" });
    expect(JSON.parse(document.body).runId).toBe("0f0e0d0c-1111-2222-3333-444455556666");
    expect(document.attempts).toBe(0);
    expect(typeof document.dueAtMs).toBe("number");
  });

  it("erreur honnête quand la création conditionnelle est refusée (collision)", async () => {
    r2Mocks.putObjectConditional.mockResolvedValue(null);
    const result = await enqueueMissionTick("0f0e0d0c-1111-2222-3333-444455556666");
    expect(result).toMatchObject({ ok: false, mode: "error" });
  });

  it("non configuré quand R2 est absent — aucun appel R2", async () => {
    r2Mocks.isR2Configured.mockReturnValueOnce(false);
    const result = await enqueueMissionTick("0f0e0d0c-1111-2222-3333-444455556666");
    expect(result).toMatchObject({ ok: false, mode: "unconfigured" });
    expect(r2Mocks.putObjectConditional).not.toHaveBeenCalled();
  });
});

describe("pumpDueTicks — rattrapage des tickets dus", () => {
  function makeTicket(overrides: Record<string, unknown> = {}, dueAtMs = Date.now() - 1000): { key: string; etag: string; data: Buffer } {
    const document = {
      kind: "mission-tick",
      body: JSON.stringify({ runId: "0f0e0d0c-1111-2222-3333-444455556666" }),
      path: "/api/queue/mission-tick",
      dueAtMs,
      attempts: 0,
      createdAtMs: Date.now() - 2000,
      ...overrides,
    };
    return {
      key: `queue/tickets/v1/${String(dueAtMs).padStart(16, "0")}-11111111-2222-3333-4444-555566667777.json`,
      etag: '"etag-1"',
      data: Buffer.from(JSON.stringify(document), "utf8"),
    };
  }

  it("délivre un ticket dû, le consomme (delete) après 2xx du receiver", async () => {
    const ticket = makeTicket();
    r2Mocks.listObjectsUnderPrefix.mockResolvedValue([{ key: ticket.key, sizeBytes: 100, updatedAt: "" }]);
    r2Mocks.getObjectWithEtag.mockResolvedValue({ data: ticket.data, etag: ticket.etag });
    r2Mocks.putObjectConditional.mockResolvedValue({ etag: '"e2"' }); // claim CAS OK
    r2Mocks.deleteObject.mockResolvedValue(undefined);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { cancel: () => Promise.resolve() },
    }) as unknown as typeof fetch;

    const outcome = await pumpDueTicks();

    expect(outcome.delivered).toBe(1);
    expect(r2Mocks.deleteObject).toHaveBeenCalledWith(ticket.key);
    // La délivrance porte la signature interne et vise le chemin du receiver.
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain("/api/queue/mission-tick");
    expect(String((init as RequestInit).headers?.["x-gen3a-tick"])).toMatch(/^v1\.\d+\.[0-9a-f]{64}$/);
  });

  it("ne délivre PAS un ticket non échu ni sous bail actif", async () => {
    const future = makeTicket({}, Date.now() + 600_000);
    const leased = makeTicket({ leaseUntilMs: Date.now() + 60_000 });
    r2Mocks.listObjectsUnderPrefix.mockResolvedValue([
      { key: future.key, sizeBytes: 1, updatedAt: "" },
      { key: leased.key, sizeBytes: 1, updatedAt: "" },
    ]);
    r2Mocks.getObjectWithEtag
      .mockResolvedValueOnce({ data: future.data, etag: future.etag })
      .mockResolvedValueOnce({ data: leased.data, etag: leased.etag });

    const outcome = await pumpDueTicks();
    expect(outcome.delivered).toBe(0);
    expect(r2Mocks.putObjectConditional).not.toHaveBeenCalled();
  });

  it("réessaie avec backoff quand le receiver répond 5xx (ticket réécrit à une échéance future)", async () => {
    const ticket = makeTicket();
    r2Mocks.listObjectsUnderPrefix.mockResolvedValue([{ key: ticket.key, sizeBytes: 1, updatedAt: "" }]);
    r2Mocks.getObjectWithEtag.mockResolvedValue({ data: ticket.data, etag: ticket.etag });
    r2Mocks.putObjectConditional.mockResolvedValue({ etag: '"e2"' });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      body: { cancel: () => Promise.resolve() },
    }) as unknown as typeof fetch;

    const outcome = await pumpDueTicks();

    expect(outcome.delivered).toBe(0);
    expect(outcome.retried).toBe(1);
    // Nouvelle clé = échéance retardée (backoff 30 s au premier essai).
    const retryPut = r2Mocks.putObjectConditional.mock.calls.find(([key]) => String(key) !== ticket.key);
    expect(retryPut).toBeDefined();
    const retryKey = String(retryPut?.[0]);
    const retryDueAt = Number(retryKey.slice("queue/tickets/v1/".length).slice(0, 16));
    expect(retryDueAt).toBeGreaterThan(Date.now());
    // L'ancien ticket est supprimé après réécriture.
    expect(r2Mocks.deleteObject).toHaveBeenCalledWith(ticket.key);
  });

  it("met en quarantaine un ticket après épuisement des tentatives", async () => {
    const ticket = makeTicket({ attempts: 5 });
    r2Mocks.listObjectsUnderPrefix.mockResolvedValue([{ key: ticket.key, sizeBytes: 1, updatedAt: "" }]);
    r2Mocks.getObjectWithEtag.mockResolvedValue({ data: ticket.data, etag: ticket.etag });
    r2Mocks.putObjectConditional.mockResolvedValue({ etag: '"e2"' });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      body: { cancel: () => Promise.resolve() },
    }) as unknown as typeof fetch;

    const outcome = await pumpDueTicks();

    expect(outcome.deadLettered).toBe(1);
    // Le ticket part en quarantaine (queue/dead/) et est retiré de la file.
    const deadPut = r2Mocks.putObjectConditional.mock.calls.find(([key]) => String(key).startsWith("queue/dead/"));
    expect(deadPut).toBeDefined();
    expect(r2Mocks.deleteObject).toHaveBeenCalledWith(ticket.key);
  });

  it("purge les tickets trop anciens (> 7 jours), quelle que soit leur échéance", async () => {
    const ticket = makeTicket({ createdAtMs: Date.now() - 8 * 24 * 3600_000 }, Date.now() + 3600_000);
    r2Mocks.listObjectsUnderPrefix.mockResolvedValue([{ key: ticket.key, sizeBytes: 1, updatedAt: "" }]);
    r2Mocks.getObjectWithEtag.mockResolvedValue({ data: ticket.data, etag: ticket.etag });

    const outcome = await pumpDueTicks();
    expect(outcome.purged).toBe(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("un concurrent plus rapide (claim CAS refusé) ne double rien", async () => {
    const ticket = makeTicket();
    r2Mocks.listObjectsUnderPrefix.mockResolvedValue([{ key: ticket.key, sizeBytes: 1, updatedAt: "" }]);
    r2Mocks.getObjectWithEtag.mockResolvedValue({ data: ticket.data, etag: ticket.etag });
    r2Mocks.putObjectConditional.mockResolvedValue(null); // CAS refusé

    const outcome = await pumpDueTicks();
    expect(outcome.delivered).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("nudgePumpFromPolling — throttle par processus", () => {
  it("ne lance qu'un pump par fenêtre de 15 s (fire-and-forget)", () => {
    const calls: unknown[][] = [];
    r2Mocks.listObjectsUnderPrefix.mockImplementation((...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve([]);
    });
    nudgePumpFromPolling();
    nudgePumpFromPolling();
    nudgePumpFromPolling();
    // Le nudge est asynchrone : la liste n'est appelée qu'UNE fois au maximum.
    expect(calls.length).toBeLessThanOrEqual(1);
  });
});
