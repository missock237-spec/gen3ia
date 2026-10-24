import { describe, expect, it } from "vitest";

import { Gen3iaClient } from "../src/client.js";
import { Gen3iaTimeoutError } from "../src/errors.js";
import type {
  MissionFinalEvent,
  MissionProgressEvent,
} from "../src/types.js";

type Reply = Response | Error;

function fetchMock(replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: unknown, init: RequestInit = {}) => {
    const next = replies.shift();
    calls.push({ url: String(url), init });
    if (!next) throw new Error("fetch mock épuisé : requête inattendue");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function statusBody(status: string) {
  return {
    runId: "r1",
    status,
    objective: "Mission de test",
    attempts: 1,
    pendingCount: status === "completed" ? 0 : 1,
    timeline: [],
    createdAtMs: 1,
    updatedAtMs: 2,
  };
}

/** Fabrique une Response SSE prête à consommer (corps déjà en file). */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}

describe("missions.waitFor — polling jusqu'au statut terminal", () => {
  it("s'arrête sur « completed » et renvoie le statut final", async () => {
    const { fetch: impl, calls } = fetchMock([
      jsonResponse(statusBody("running")),
      jsonResponse(statusBody("running")),
      jsonResponse(statusBody("completed")),
    ]);
    const client = new Gen3iaClient({ firebaseToken: "tok", fetch: impl });
    const final = await client.missions.waitFor("r1", { pollMs: 1 });

    expect(final.status).toBe("completed");
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toContain("/api/agents/runs/r1");
  });

  it("s'arrête sur « paused » (pause utilisateur — l'appelant décide de la suite)", async () => {
    const { fetch: impl } = fetchMock([jsonResponse(statusBody("paused"))]);
    const client = new Gen3iaClient({ firebaseToken: "tok", fetch: impl });
    const final = await client.missions.waitFor("r1", { pollMs: 1 });
    expect(final.status).toBe("paused");
  });

  it("lève Gen3iaTimeoutError en dépassant le délai (mission fantôme détectable)", async () => {
    // Mock inépuisable : la mission reste « running » aussi longtemps que
    // nécessaire — seul le délai du client doit terminer la boucle (le mock
    // séquentiel épuiserait la file avant l'échéance et déclencherait
    // des retries GET parasites).
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: unknown, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return jsonResponse(statusBody("running"));
    }) as unknown as typeof fetch;
    const client = new Gen3iaClient({ firebaseToken: "tok", fetch: impl, maxRetries: 0 });
    await expect(client.missions.waitFor("r1", { pollMs: 1, timeoutMs: 25 })).rejects.toBeInstanceOf(Gen3iaTimeoutError);
  });
});

describe("missions.stream — une connexion SSE", () => {
  it("distribue onProgress puis onFinal et termine la promesse done", async () => {
    const { fetch: impl, calls } = fetchMock([
      sseResponse([
        'event: progress\ndata: {"runId":"r1","status":"running","pendingCount":1,"attempts":1,"timeline":[],"updatedAtMs":1}\n\n',
        'event: final\ndata: {"runId":"r1","status":"completed"}\n\n',
      ]),
    ]);
    const client = new Gen3iaClient({ firebaseToken: "tok", fetch: impl });

    const progress: MissionProgressEvent[] = [];
    const finals: MissionFinalEvent[] = [];
    const handle = await client.missions.stream("r1", {
      onProgress: (e) => progress.push(e),
      onFinal: (e) => finals.push(e),
    });
    await handle.done;

    expect(progress).toHaveLength(1);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.status).toBe("completed");
    expect(calls[0]?.url).toContain("/api/agents/runs/r1/stream");
    expect((calls[0]?.init.headers as Record<string, string>).Accept).toBe("text/event-stream");
  });

  it("les heartbeats (commentaires) ne déclenchent aucun handler", async () => {
    const { fetch: impl } = fetchMock([sseResponse([": ping\n\n", 'event: final\ndata: {"runId":"r1","status":"completed"}\n\n'])]);
    const client = new Gen3iaClient({ firebaseToken: "tok", fetch: impl });
    const finals: MissionFinalEvent[] = [];
    const handle = await client.missions.stream("r1", { onFinal: (e) => finals.push(e) });
    await handle.done;
    expect(finals).toHaveLength(1);
  });

  it("signal appelant : close() via AbortController termine sans erreur", async () => {
    // Flux infini (le serveur ferme après ~50 s ; ici on simule le pire cas).
    // En réel, l'abort de fetch annule le corps : le mock doit le reproduire
    // en rejetant la lecture du stream quand le signal du handle s'allume.
    const encoder = new TextEncoder();
    let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const infinite = new ReadableStream<Uint8Array>({
      start(controller) {
        sourceController = controller;
        const interval = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            /* stream déjà fermé — l'intervalle s'arrêtera au timeout ci-dessous */
          }
        }, 5);
        setTimeout(() => clearInterval(interval), 2_000);
      },
    });
    const impl = (async (_url: unknown, init: RequestInit = {}) => {
      init.signal?.addEventListener("abort", () => {
        try {
          sourceController?.error(new Error("The operation was aborted"));
        } catch {
          /* déjà en erreur */
        }
      }, { once: true });
      return new Response(infinite, { status: 200 });
    }) as unknown as typeof fetch;

    const client = new Gen3iaClient({ firebaseToken: "tok", fetch: impl });
    const handle = await client.missions.stream("r1", {});
    handle.close();
    await expect(handle.done).resolves.toBeUndefined();
  });
});

describe("missions.follow — auto-reconnexion tant que pas de final", () => {
  it("reconnecte après une fenêtre serveur écoulée et capte le final à la fenêtre suivante", async () => {
    const { fetch: impl, calls } = fetchMock([
      // Fenêtre 1 : un progress puis fermeture propre SANS final (50 s simulées).
      sseResponse(['event: progress\ndata: {"runId":"r1","status":"running","pendingCount":1,"attempts":1,"timeline":[],"updatedAtMs":1}\n\n']),
      // Fenêtre 2 : le final.
      sseResponse(['event: final\ndata: {"runId":"r1","status":"completed"}\n\n']),
    ]);
    const client = new Gen3iaClient({ firebaseToken: "tok", fetch: impl });

    const finals: MissionFinalEvent[] = [];
    const progress: MissionProgressEvent[] = [];
    const follow = await client.missions.follow(
      "r1",
      { onProgress: (e) => progress.push(e), onFinal: (e) => finals.push(e) },
      { reconnectDelayMs: 1 },
    );
    // follow n'expose que close() : on attend le final par sondage court.
    for (let i = 0; i < 200 && finals.length === 0; i++) await new Promise((r) => setTimeout(r, 5));

    expect(progress).toHaveLength(1);
    expect(finals).toHaveLength(1);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    follow.close();
  });

  it("close() interrompt la boucle de reconnexion", async () => {
    const { fetch: impl } = fetchMock([
      sseResponse([]), // fenêtre vide — déclencherait une reconnexion
      sseResponse([]),
      sseResponse([]),
      sseResponse([]),
    ]);
    const client = new Gen3iaClient({ firebaseToken: "tok", fetch: impl });
    const follow = await client.missions.follow("r1", {}, { reconnectDelayMs: 1 });
    follow.close();
    // Aucun final, aucune erreur : la boucle s'est arrêtée proprement.
    await new Promise((r) => setTimeout(r, 20));
  });
});
