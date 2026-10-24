import { describe, expect, it } from "vitest";

import { Gen3iaError } from "../src/errors.js";
import { createSseParser, type SseEvent } from "../src/sse.js";

/** Collecteur d'événements pratique pour les assertions. */
function collect(): { events: SseEvent[]; parser: ReturnType<typeof createSseParser> } {
  const events: SseEvent[] = [];
  const parser = createSseParser((event) => events.push(event));
  return { events, parser };
}

describe("createSseParser (contrat flux missions Gen3ia)", () => {
  it("distribue un événement progress complet (event: + data: + ligne vide)", () => {
    const { events, parser } = collect();
    parser.push('event: progress\ndata: {"runId":"r1","status":"running"}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("progress");
    expect(JSON.parse(events[0]?.data ?? "{}")).toMatchObject({ runId: "r1", status: "running" });
  });

  it("ignore les commentaires heartbeat (: ping) sans distribuer d'événement", () => {
    const { events, parser } = collect();
    parser.push(": ping\n\n");
    expect(events).toHaveLength(0);
  });

  it("joint les lignes data: multiples par \\n (spec SSE)", () => {
    const { events, parser } = collect();
    parser.push("event: final\ndata: ligne-1\ndata: ligne-2\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("ligne-1\nligne-2");
  });

  it("utilise « message » comme nom d'événement par défaut", () => {
    const { events, parser } = collect();
    parser.push("data: sans-nom\n\n");
    expect(events[0]?.event).toBe("message");
  });

  it("tolère les fragments coupés au milieu d'une ligne (chunks réseau)", () => {
    const { events, parser } = collect();
    parser.push('event: pro');
    parser.push('gress\ndata: {"ok"');
    parser.push(':true}\n');
    parser.push('\n');
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("progress");
    expect(JSON.parse(events[0]?.data ?? "{}")).toEqual({ ok: true });
  });

  it("accepte les fins de ligne CRLF", () => {
    const { events, parser } = collect();
    parser.push('event: final\r\ndata: {"status":"completed"}\r\n\r\n');
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("final");
  });

  it("n'autorise qu'un seul espace après les deux-points (spec SSE)", () => {
    const { events, parser } = collect();
    parser.push("data:  deux-espaces\n\n");
    expect(events[0]?.data).toBe(" deux-espaces");
  });

  it("end() distribue une dernière ligne complète sans \\n final", () => {
    const { events, parser } = collect();
    parser.push("data: dernier-mot");
    parser.end();
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("dernier-mot");
  });

  it("ne distribue rien si aucune donnée n'a été reçue", () => {
    const { events, parser } = collect();
    parser.push("event: progress\n");
    parser.end();
    expect(events).toHaveLength(0);
  });

  it("rejette un flux corrompu dépassant 1 Mio sans fin de ligne", () => {
    const { parser } = collect();
    expect(() => parser.push("x".repeat(1_048_577))).toThrow(Gen3iaError);
  });

  it("gère une séquence complète progress → progress → final comme le serveur", () => {
    const { events, parser } = collect();
    parser.push(
      [
        'event: progress\ndata: {"runId":"r","status":"queued","pendingCount":2}\n\n',
        'event: progress\ndata: {"runId":"r","status":"running","pendingCount":1}\n\n',
        'event: final\ndata: {"runId":"r","status":"completed"}\n\n',
      ].join(""),
    );
    expect(events.map((e) => e.event)).toEqual(["progress", "progress", "final"]);
  });
});
