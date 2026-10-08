import { describe, expect, it } from "vitest";

import { parseNdjsonStream } from "@/lib/live/voice/ndjson-stream";

/** Construit un ReadableStream binaire à partir de chunks texte ARBITRAIRES. */
function fluxDepuis(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

interface EvenementTest {
  type: string;
  text?: string;
}

async function collecter(chunks: string[]): Promise<EvenementTest[]> {
  const events: EvenementTest[] = [];
  for await (const event of parseNdjsonStream<EvenementTest>(fluxDepuis(chunks).getReader())) {
    events.push(event);
  }
  return events;
}

describe("parseNdjsonStream", () => {
  it("assemble les lignes coupées en plein milieu par les chunks réseau", async () => {
    const events = await collecter([
      '{"type":"tr',
      'anscript","text":"bon',
      'jour"}\n{"type":"do',
      'ne"}\n',
    ]);
    expect(events).toEqual([
      { type: "transcript", text: "bonjour" },
      { type: "done" },
    ]);
  });

  it("ignore les lignes vides (keep-alive d'un proxy)", async () => {
    const events = await collecter(['\n\n{"type":"a"}\n\n\n{"type":"b"}\n\n']);
    expect(events).toEqual([{ type: "a" }, { type: "b" }]);
  });

  it("consomme une dernière ligne sans saut de ligne final", async () => {
    const events = await collecter(['{"type":"a"}\n{"type":"b"}']);
    expect(events).toEqual([{ type: "a" }, { type: "b" }]);
  });

  it("traite plusieurs objets dans un même chunk", async () => {
    const events = await collecter(['{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n']);
    expect(events).toEqual([{ type: "a" }, { type: "b" }, { type: "c" }]);
  });

  it("ignore une ligne JSON malformée sans casser le flux", async () => {
    const events = await collecter(['{"type":"a"}\n{cassé\n{"type":"b"}\n']);
    expect(events).toEqual([{ type: "a" }, { type: "b" }]);
  });

  it("tolère les fins de ligne CRLF", async () => {
    const events = await collecter(['{"type":"a"}\r\n{"type":"b"}\r\n']);
    expect(events).toEqual([{ type: "a" }, { type: "b" }]);
  });

  it("gère un flux vide", async () => {
    const events = await collecter([]);
    expect(events).toEqual([]);
  });

  it("préserve l'ordre et le typage générique des événements du protocole", async () => {
    interface TurnEvent {
      type: "sentence" | "audio";
      index?: number;
      text?: string;
      dataUri?: string;
    }
    const events: TurnEvent[] = [];
    for await (const event of parseNdjsonStream<TurnEvent>(
      fluxDepuis([
        `${JSON.stringify({ type: "sentence", index: 0, text: "Bonjour" })}\n`,
        `${JSON.stringify({ type: "audio", index: 0, dataUri: "data:audio/wav;base64,AAA" })}\n`,
      ]).getReader(),
    )) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "sentence", index: 0, text: "Bonjour" });
    expect(events[1]?.dataUri).toContain("base64,");
  });

  it("libère le reader quand le consommateur interrompt la boucle", async () => {
    // Un chunk PAR LIGNE : à la coupure, le générateur n'a consommé que le
    // premier chunk — les suivants restent lisibles dans le flux. (Avec un
    // seul chunk pour tout, il serait déjà drainé : un parseur NDJSON ne
    // peut pas « rendre » un chunk déjà lu au ReadableStream.)
    const stream = fluxDepuis(['{"type":"a"}\n', '{"type":"b"}\n', '{"type":"c"}\n']);
    const reader = stream.getReader();
    let premiers: EvenementTest[] = [];
    for await (const event of parseNdjsonStream<EvenementTest>(reader)) {
      premiers = [event];
      break; // sortie anticipée (ex. barge-in fatal)
    }
    expect(premiers).toEqual([{ type: "a" }]);
    // Le verrou libéré par le générateur permet d'acquérir un nouveau reader.
    const second = stream.getReader();
    const reste: EvenementTest[] = [];
    for (;;) {
      const { done, value } = await second.read();
      if (done) break;
      reste.push(
        ...(JSON.parse(`[${new TextDecoder().decode(value).trim().replace(/\n/g, ",")}]`) as EvenementTest[]),
      );
    }
    expect(reste.map((e) => e.type)).toEqual(["b", "c"]);
  });
});
