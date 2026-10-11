import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Task 121 — ROUTE DE SUIVI JULES (/api/cron/jules-followup).
 *
 * Objectif métier : une session Jules lancée depuis le chat IA est suivie
 * AUTOMATIQUEMENT — chaque passage sonde l'API Jules (GET /sessions) pour les
 * sessions actives et livre le résultat dans la conversation d'origine dès
 * l'état terminal. Les tests verrouillent :
 *  - l'AUTHENTIFICATION (GET bearer CRON_SECRET, POST signature de tick) ;
 *  - la LIVRAISON à l'état terminal : message FR avec phrase-marker + ligne
 *    « Session : », artefact code portant l'URL de sortie (patch/PR) ;
 *  - l'IDEMPOTENCE (marqueur absent mais message déjà dans le fil → PAS de
 *    second message — miroir deliverJobToConversation, Task 113) ;
 *  - le sondage IN_PROGRESS (aucune livraison, compteur incrémenté, prochain
 *    ticket programmé dans la file de ticks R2 — boucle auto-perpétuée) ;
 *  - l'état CANCELLED (livraison honnête, aucune sortie inventée).
 *
 * Patterns : mocks Firestore/réponses Jules par fetch global, calqués sur
 * lib/video/production-queue-delivery.test.ts (état hoisted persistant entre
 * les passages pour tester l'idempotence de bout en bout).
 */

// ---------------------------------------------------------------------------
// État hoisted — sessions Jules (Firestore factice) + fil de conversation
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  appended: [] as Array<{ conversationId: string; content: string }>,
  listed: [] as Array<{ role: string; content: string }>,
  artifacts: [] as Array<Record<string, unknown>>,
  tickets: [] as string[],
  verifyTick: true,
}));

// ---------------------------------------------------------------------------
// Mocks — couches de persistance, livraison et file de ticks
// ---------------------------------------------------------------------------

vi.mock("@/lib/db/firestore-resilient", () => ({
  resilientCreate: vi.fn(async (collection: string, id: string, payload: Record<string, unknown>) => {
    state.docs.set(`${collection}/${id}`, { ...payload });
  }),
  resilientQuery: vi.fn(async (collection: string, filters: Array<{ field: string; value: unknown }>, options?: { limit?: number }) => {
    return [...state.docs.entries()]
      .filter(([key]) => key.startsWith(`${collection}/`))
      .map(([, doc]) => doc)
      .filter((doc) => filters.every((f) => doc[f.field] === f.value))
      .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))
      .slice(0, options?.limit ?? 10);
  }),
  resilientSet: vi.fn(async (collection: string, id: string, payload: Record<string, unknown>, options?: { merge?: boolean }) => {
    const key = `${collection}/${id}`;
    const existing = state.docs.get(key) ?? {};
    state.docs.set(key, options?.merge === true ? { ...existing, ...payload } : { ...payload });
  }),
}));

vi.mock("@/lib/chat/repository", () => ({
  appendMessage: vi.fn(async (input: { conversationId: string; content: string }) => {
    state.appended.push({ conversationId: input.conversationId, content: input.content });
    state.listed.push({ role: "assistant", content: input.content });
    return { id: `msg-${state.appended.length}`, role: "assistant", content: input.content };
  }),
  listMessages: vi.fn(async (_userId: string, _conversationId: string, _limit: number, _options: unknown) => {
    return state.listed.map((m) => ({ ...m, id: "m" }));
  }),
}));

vi.mock("@/lib/domain/artifacts/repository", () => ({
  createArtifact: vi.fn(async (input: Record<string, unknown>) => {
    state.artifacts.push(input);
    return { id: `artifact-${state.artifacts.length}`, ...input };
  }),
}));

vi.mock("@/lib/storage/r2", () => ({
  isR2Configured: () => true,
  putObjectConditional: vi.fn(async (key: string) => {
    state.tickets.push(key);
    return true;
  }),
}));

vi.mock("@/lib/queue/tick-queue", () => ({
  tickQueueConfigured: () => true,
  verifyTickRequest: vi.fn(() => state.verifyTick),
  signTickBody: vi.fn(() => "v1.0.test"),
  TICK_SIGNATURE_HEADER: "x-gen3a-tick",
}));

// ---------------------------------------------------------------------------
// API Jules — fetch global mocké (GET /sessions/{name})
// ---------------------------------------------------------------------------

const julesResponses = vi.hoisted(() => ({
  bySession: new Map<string, Record<string, unknown>>(),
}));

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: unknown) => {
    const target = String(url);
    const name = target.split("/sessions/")[1] ?? "";
    const decoded = decodeURIComponent(name);
    const payload = julesResponses.bySession.get(decoded);
    if (!payload) {
      return { ok: false, status: 404, text: async () => "session inconnue" };
    }
    return { ok: true, status: 200, json: async () => payload };
  }),
);

// ---------------------------------------------------------------------------
// Route sous test (import APRÈS les mocks)
// ---------------------------------------------------------------------------

import { GET, POST } from "./route";

const BASE = "https://gen3ia.local/api/cron/jules-followup";

function getRequest(authorization?: string): NextRequest {
  return new NextRequest(BASE, {
    method: "GET",
    ...(authorization ? { headers: { authorization } } : {}),
  });
}

function postRequest(body: string): NextRequest {
  return new NextRequest(BASE, { method: "POST", body });
}

/** Insère une session active dans le Firestore factice. */
function insertSession(overrides: Record<string, unknown> = {}): string {
  const id = `jules-${state.docs.size + 1}`;
  const now = new Date().toISOString();
  state.docs.set(`julesSessions/${id}`, {
    id,
    userId: "user-1",
    conversationId: "conv-1",
    session: "sessions/abc123",
    repo: "acme/api",
    prompt: "corrige le bug de login",
    title: "Bug de login",
    status: "active",
    pollAttempts: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return id;
}

beforeEach(() => {
  state.docs.clear();
  state.appended = [];
  state.listed = [];
  state.artifacts = [];
  state.tickets = [];
  state.verifyTick = true;
  julesResponses.bySession.clear();
  // Clé Jules présente : le client HTTP authentifie (X-Goog-Api-Key) et le
  // fetch global mocké joue le rôle de l'API v1alpha.
  vi.stubEnv("CRON_SECRET", "cron-secret-123");
  vi.stubEnv("JULES_API_KEY", "test-jules-key");
  vi.mocked(fetch).mockClear();
});

/* ------------------------------------------------------------------ */
/* Authentification                                                     */
/* ------------------------------------------------------------------ */

describe("authentification de la route de suivi Jules", () => {
  it("rejette le GET sans bearer CRON_SECRET (401)", async () => {
    const response = await GET(getRequest());
    expect(response.status).toBe(401);
  });

  it("rejette le GET avec un bearer incorrect (401)", async () => {
    const response = await GET(getRequest("Bearer mauvais-secret"));
    expect(response.status).toBe(401);
  });

  it("rejette le POST sans signature de tick ni bearer (401)", async () => {
    state.verifyTick = false;
    const response = await POST(postRequest('{"v":1}'));
    expect(response.status).toBe(401);
  });

  it("accepte le GET avec le bearer CRON_SECRET correct (200)", async () => {
    const response = await GET(getRequest("Bearer cron-secret-123"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("accepte le POST signé par la file de ticks (202)", async () => {
    const response = await POST(postRequest('{"v":1}'));
    expect(response.status).toBe(202);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Livraison terminale + idempotence                                    */
/* ------------------------------------------------------------------ */

describe("sondage Jules — livraison terminale", () => {
  it("livre l'état COMPLETED : message FR + artefact avec l'URL de sortie, puis marque le document", async () => {
    insertSession();
    julesResponses.bySession.set("abc123", {
      name: "sessions/abc123",
      state: "COMPLETED",
      outputs: [
        { url: "https://github.com/acme/api/pull/12", type: "pull_request" },
        { url: "https://patch-diff.example/abc123.diff", type: "patched_branch_diff" },
      ],
    });

    const response = await GET(getRequest("Bearer cron-secret-123"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { found: number; delivered: number; finished: number; stillActive: number };
    expect(body).toMatchObject({ found: 1, delivered: 1, finished: 1, stillActive: 0 });

    // LE livrable : message assistant dans la conversation d'origine.
    expect(state.appended).toHaveLength(1);
    const content = state.appended[0]!.content;
    expect(content).toContain("Votre tâche Jules est terminée");
    expect(content).toContain("Session : sessions/abc123");
    expect(content).toContain("acme/api");
    expect(content).toContain("https://github.com/acme/api/pull/12");
    expect(content).toContain("https://patch-diff.example/abc123.diff");

    // Artefact de livraison : l'URL de la pull request devient cliquable.
    expect(state.artifacts).toHaveLength(1);
    expect(state.artifacts[0]).toMatchObject({
      type: "code",
      url: "https://github.com/acme/api/pull/12",
    });

    // Marqueur d'idempotence posé + statut terminal.
    const doc = state.docs.get("julesSessions/jules-1") as Record<string, unknown>;
    expect(doc.status).toBe("completed");
    expect(doc.deliveredAt).toBeTruthy();
  });

  it("est IDEMPOTENT : un document re-passé actif sans marqueur, mais message déjà livré → aucun doublon", async () => {
    insertSession();
    julesResponses.bySession.set("abc123", { name: "sessions/abc123", state: "COMPLETED", outputs: [] });

    // Premier passage : livraison.
    await GET(getRequest("Bearer cron-secret-123"));
    expect(state.appended).toHaveLength(1);

    // Incident simulé : le marqueur deliveredAt est PERDU (écriture
    // best-effort échouée) — le document repasse « active » tel quel.
    const doc = state.docs.get("julesSessions/jules-1") as Record<string, unknown>;
    doc.status = "active";
    delete doc.deliveredAt;

    // Second passage : l'anti-doublon par lecture du fil empêche le doublon
    // (le message livré contient la phrase-marker + la ligne Session).
    const response = await GET(getRequest("Bearer cron-secret-123"));
    const body = (await response.json()) as { delivered: number; finished: number };
    expect(body.finished).toBe(1);
    expect(body.delivered).toBe(0);
    expect(state.appended).toHaveLength(1);

    // Le marqueur est re-posé au mieux : le prochain passage sort immédiatement.
    const repatched = state.docs.get("julesSessions/jules-1") as Record<string, unknown>;
    expect(repatched.status).toBe("completed");
    expect(repatched.deliveredAt).toBeTruthy();
  });

  it("livre l'état CANCELLED avec un message honnête, sans sortie inventée", async () => {
    insertSession();
    julesResponses.bySession.set("abc123", { name: "sessions/abc123", state: "CANCELLED" });

    const response = await GET(getRequest("Bearer cron-secret-123"));
    expect(response.status).toBe(200);
    expect(state.appended).toHaveLength(1);
    expect(state.appended[0]!.content).toContain("Votre tâche Jules a bien été annulée");
    // Pas d'URL de sortie → pas d'artefact inventé.
    expect(state.artifacts).toHaveLength(0);
  });

  it("livre l'état FAILED avec le message d'erreur remonté par Jules", async () => {
    insertSession();
    julesResponses.bySession.set("abc123", { name: "sessions/abc123", state: "FAILED", errorMessage: "quota exceeded" });

    await GET(getRequest("Bearer cron-secret-123"));
    expect(state.appended).toHaveLength(1);
    expect(state.appended[0]!.content).toContain("Votre tâche Jules n'a pas abouti");
    expect(state.appended[0]!.content).toContain("quota exceeded");
  });
});

/* ------------------------------------------------------------------ */
/* Session toujours active — auto-perpétuation                          */
/* ------------------------------------------------------------------ */

describe("sondage Jules — session toujours en cours", () => {
  it("IN_PROGRESS : aucune livraison, compteur incrémenté, prochain tick programmé dans la file R2", async () => {
    insertSession();
    julesResponses.bySession.set("abc123", { name: "sessions/abc123", state: "IN_PROGRESS" });

    const response = await GET(getRequest("Bearer cron-secret-123"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { stillActive: number; delivered: number; nextTick: { ok: boolean } };
    expect(body.stillActive).toBe(1);
    expect(body.delivered).toBe(0);
    expect(body.nextTick.ok).toBe(true);

    // Aucun message livré prématurément.
    expect(state.appended).toHaveLength(0);

    // Le compteur de sondages progresse (borne anti-boucle infinie).
    const doc = state.docs.get("julesSessions/jules-1") as Record<string, unknown>;
    expect(doc.pollAttempts).toBe(1);
    expect(doc.status).toBe("active");

    // Le prochain passage est programmé : ticket au FORMAT de la file de
    // ticks R2 (préfixe + échéance en tête de clé — pump existant, non modifié).
    expect(state.tickets).toHaveLength(1);
    expect(state.tickets[0]).toMatch(/^queue\/tickets\/v1\/\d{16}-[0-9a-f-]+\.json$/);
  });

  it("zéro session active : aucun ticket programmé (la boucle s'arrête toute seule)", async () => {
    const response = await GET(getRequest("Bearer cron-secret-123"));
    const body = (await response.json()) as { found: number; nextTick: { ok: boolean } };
    expect(body.found).toBe(0);
    expect(body.nextTick.ok).toBe(false);
    expect(state.tickets).toHaveLength(0);
  });

  it("un incident de sondage (404) ne bloque pas les autres sessions", async () => {
    insertSession();
    insertSession({ id: "jules-2", session: "sessions/xyz789" });
    // Première session : erreur API (session inconnue côté Jules).
    // (julesResponses n'a PAS « abc123 » → 404 simulé par le fetch mock.)
    julesResponses.bySession.set("xyz789", { name: "sessions/xyz789", state: "COMPLETED" });

    const response = await GET(getRequest("Bearer cron-secret-123"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { delivered: number; stillActive: number };
    expect(body.delivered).toBe(1); // xyz789 livrée malgré l'échec d'abc123.
    expect(body.stillActive).toBe(1); // abc123 reste active (tentative comptée).
  });
});
