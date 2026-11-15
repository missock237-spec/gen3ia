import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PIPELINE_OUTPUT_FILENAME, PIPELINE_STATE_FILENAME } from "./corpus";

/**
 * Ingestion serveur du corpus : consommation par offset du JSONL partagé
 * avec le daemon, état atomique, plafonds, best-effort — testée contre un
 * répertoire temporaire RÉEL avec l'ingestion knowledge MOCKÉE.
 */

const ingesterMock = vi.fn();

vi.mock("@/lib/knowledge/ingestion", () => ({
  ingestKnowledgeDocument: (...args: unknown[]) => ingesterMock(...args),
}));

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function record(id: string, mots = 120): object {
  return {
    id,
    url: `https://example.com/${id.slice(0, 8)}`,
    title: `Document ${id.slice(0, 8)}`,
    content: "Un contenu assez long pour passer le filtre de cent mots. ".repeat(Math.ceil(mots / 11)),
    scrapedAt: "2026-01-15T10:30:00.000Z",
    metadata: { wordCount: mots, httpStatus: 200 },
  };
}

let sandbox: string;
let dataDirEnv: string | undefined;

beforeEach(async () => {
  ingesterMock.mockReset();
  ingesterMock.mockResolvedValue(undefined);
  sandbox = await fsp.mkdtemp(join(tmpdir(), "gen3ia-ingest-"));
  dataDirEnv = process.env.PIPELINE_DATA_DIR;
  process.env.PIPELINE_DATA_DIR = sandbox;
});

afterEach(async () => {
  if (dataDirEnv === undefined) delete process.env.PIPELINE_DATA_DIR;
  else process.env.PIPELINE_DATA_DIR = dataDirEnv;
  await fsp.rm(sandbox, { recursive: true, force: true });
});

async function ecrireJsonl(lignes: Array<object | string>): Promise<void> {
  // Append-only comme le daemon : chaque écriture se termine par \n.
  const brut =
    lignes.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
  await fsp.writeFile(join(sandbox, PIPELINE_OUTPUT_FILENAME), brut, "utf-8");
}

async function lireEtat(): Promise<{ offset: number; seenHashes: string[] }> {
  const brut = await fsp.readFile(join(sandbox, PIPELINE_STATE_FILENAME), "utf-8");
  return JSON.parse(brut);
}

describe("runPipelineIngest", () => {
  it("no-op propre quand le daemon n'a encore rien produit", async () => {
    const { runPipelineIngest } = await import("./ingest");
    const result = await runPipelineIngest();
    expect(result).toMatchObject({ ok: true, ingested: 0, offset: 0, truncated: false });
    expect(ingesterMock).not.toHaveBeenCalled();
  });

  it("ingère les documents valides vers le périmètre corpus et avance l'offset", async () => {
    const { runPipelineIngest } = await import("./ingest");
    const { CORPUS_PROJECT_ID, CORPUS_USER_ID } = await import("./corpus");
    await ecrireJsonl([record(SHA_A), record(SHA_B)]);

    const result = await runPipelineIngest();
    expect(result.ok).toBe(true);
    expect(result.ingested).toBe(2);
    expect(ingesterMock).toHaveBeenCalledTimes(2);
    const appel = ingesterMock.mock.calls[0][0] as Record<string, unknown>;
    expect(appel.userId).toBe(CORPUS_USER_ID);
    expect(appel.projectId).toBe(CORPUS_PROJECT_ID);
    expect(appel.source).toBe("url");

    const etat = await lireEtat();
    expect(etat.seenHashes).toEqual([SHA_A, SHA_B]);
    const stat = await fsp.stat(join(sandbox, PIPELINE_OUTPUT_FILENAME));
    expect(etat.offset).toBe(stat.size);
  });

  it("ne re-ingère JAMAIS après un second passage (offset + registre)", async () => {
    const { runPipelineIngest } = await import("./ingest");
    await ecrireJsonl([record(SHA_A)]);
    await runPipelineIngest();
    const second = await runPipelineIngest();
    expect(second.ingested).toBe(0);
    expect(ingesterMock).toHaveBeenCalledTimes(1);
  });

  it("laisse une ligne incomplète au daemon (offset arrêté avant)", async () => {
    const { runPipelineIngest } = await import("./ingest");
    const complet = JSON.stringify(record(SHA_A)) + "\n";
    const partiel = JSON.stringify(record(SHA_B)).slice(0, 30);
    await fsp.writeFile(join(sandbox, PIPELINE_OUTPUT_FILENAME), complet + partiel, "utf-8");

    const result = await runPipelineIngest();
    expect(result.ingested).toBe(1);
    const etat = await lireEtat();
    expect(etat.offset).toBe(Buffer.byteLength(complet, "utf-8"));
  });

  it("plafonne le lot (truncated) SANS perdre les documents restants", async () => {
    const { runPipelineIngest } = await import("./ingest");
    await ecrireJsonl([record(SHA_A), record(SHA_B), record(SHA_C)]);

    const premier = await runPipelineIngest({ maxDocs: 1 });
    expect(premier.ingested).toBe(1);
    expect(premier.truncated).toBe(true);

    ingesterMock.mockClear();
    const second = await runPipelineIngest({ maxDocs: 10 });
    expect(second.ingested).toBe(2);
    expect(second.truncated).toBe(false);
  });

  it("un échec d'ingestion n'arrête pas le lot et n' bloque pas l'offset", async () => {
    const { runPipelineIngest } = await import("./ingest");
    ingesterMock.mockImplementation((input: { name: string }) => {
      if (input.name.includes(SHA_B.slice(0, 8))) throw new Error("qdrant down");
      return Promise.resolve(undefined);
    });
    await ecrireJsonl([record(SHA_A), record(SHA_B), record(SHA_C)]);

    const result = await runPipelineIngest();
    expect(result.ok).toBe(true);
    expect(result.ingested).toBe(2);
    expect(result.failures).toEqual([
      expect.objectContaining({ reason: "qdrant down" }),
    ]);
    const etat = await lireEtat();
    // Tous les documents consommés : pas de boucle d'échec infinie.
    const stat = await fsp.stat(join(sandbox, PIPELINE_OUTPUT_FILENAME));
    expect(etat.offset).toBe(stat.size);
  });

  it("détecte une rotation (fichier plus court que l'offset) et repart de zéro", async () => {
    const { runPipelineIngest } = await import("./ingest");
    await ecrireJsonl([record(SHA_A), ""]);
    await runPipelineIngest();

    // Le daemon rote le fichier : contenu STRICTEMENT plus court que
    // l'offset précédent (rotation/troncation).
    ingesterMock.mockClear();
    await fsp.writeFile(
      join(sandbox, PIPELINE_OUTPUT_FILENAME),
      JSON.stringify(record(SHA_B)) + "\n",
      "utf-8",
    );
    const result = await runPipelineIngest();
    expect(result.ingested).toBe(1);
    expect(ingesterMock).toHaveBeenCalledTimes(1);
  });

  it("écarte les lignes invalides en avançant quand même l'offset", async () => {
    const { runPipelineIngest } = await import("./ingest");
    // Chaîne vide finale = le JSONL se termine par \n (dernière ligne complète).
    await ecrireJsonl(["{corrompu", record(SHA_A), ""]);

    const result = await runPipelineIngest();
    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(1);
    const stat = await fsp.stat(join(sandbox, PIPELINE_OUTPUT_FILENAME));
    const etat = await lireEtat();
    expect(etat.offset).toBe(stat.size);
  });

  it("sérialise les passages concurrents (mutex interne)", async () => {
    const { runPipelineIngest } = await import("./ingest");
    await ecrireJsonl([record(SHA_A), record(SHA_B)]);
    // L'ingester est lent : deux passages lancés en même temps.
    ingesterMock.mockImplementation(() => new Promise((r) => setTimeout(r, 25)));

    const [a, b] = await Promise.all([runPipelineIngest(), runPipelineIngest()]);
    // Le mutex sérialise : total ingéré = 2, jamais 4.
    expect(a.ingested + b.ingested).toBe(2);
    expect(ingesterMock).toHaveBeenCalledTimes(2);
  });
});
