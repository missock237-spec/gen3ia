import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FILE.CREATE LIVRABLE (audit multimodal, axe C) : le fichier créé restait
 * prisonnier du workspace éphémère — l'output { workspaceId, filename }
 * ne produisait JAMAIS d'artefact conversation (artifactFromToolOutput
 * exige path/key/storageKey). Verrous :
 *  1. la création workspace reste la fonction première (écriture réelle) ;
 *  2. une CLÉ PERMANENTE est retournée (storageKey) + copiePermanente=true
 *     → l'artefact devient téléchargeable dans le chat ;
 *  3. fail-soft : un incident R2 NE fait PAS échouer la création
 *     (copiePermanente=false, sans storageKey, honnête) ;
 *  4. les protections d'origine restent intègres (chemin hors workspace,
 *     payload > 10 MiB).
 */

const uploadToR2Mock = vi.fn();
const isR2ConfiguredMock = vi.fn();

vi.mock("@/lib/storage/r2", () => ({
  uploadToR2: (...args: unknown[]) => uploadToR2Mock(...args),
  isR2Configured: () => isR2ConfiguredMock(),
}));

vi.mock("@/lib/execution/workspace-registry", () => ({
  assertWorkspaceOwner: async () => ({ id: "ws1", root: workspaceRoot }),
}));

import { createFileTool } from "./create";

let workspaceRoot: string;

describe("file.create — fichier workspace + copie permanente livrable", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    workspaceRoot = await mkdtemp(path.join(tmpdir(), "gen3ia-filecreate-"));
    isR2ConfiguredMock.mockReturnValue(true);
    uploadToR2Mock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("écrit le fichier ET archive la copie permanente avec la clé livrable", async () => {
    const output = (await createFileTool.execute(
      {
        workspaceId: "ws1",
        filename: "rapports/notes.txt",
        dataBase64: Buffer.from("contenu réel").toString("base64"),
        encoding: "base64",
      },
      { userId: "u1" },
    )) as { success: boolean; storageKey?: string; copiePermanente?: boolean; sizeBytes: number };

    expect(output.success).toBe(true);
    expect(output.copiePermanente).toBe(true);
    expect(output.storageKey).toBe("users/u1/permanent/workspaces/ws1/rapports/notes.txt");
    expect(output.sizeBytes).toBe(13); // « contenu réel » : 12 caractères, « é » = 2 octets
    // Le fichier workspace existe réellement.
    const ecrit = await readFile(path.join(workspaceRoot, "rapports/notes.txt"), "utf8");
    expect(ecrit).toBe("contenu réel");
    // L'upload R2 reçoit le bon type MIME.
    expect(uploadToR2Mock).toHaveBeenCalledWith(
      "users/u1/permanent/workspaces/ws1/rapports/notes.txt",
      expect.any(Buffer),
      "text/plain",
    );
  });

  it("incident R2 : la création workspace RÉUSSIT, copie permanente honnêtement false", async () => {
    uploadToR2Mock.mockRejectedValue(new Error("R2 injoignable"));

    const output = (await createFileTool.execute(
      {
        workspaceId: "ws1",
        filename: "a.txt",
        dataBase64: Buffer.from("ok").toString("base64"),
        encoding: "base64",
      },
      { userId: "u1" },
    )) as { success: boolean; storageKey?: string; copiePermanente?: boolean };

    expect(output.success).toBe(true);
    expect(output.copiePermanente).toBe(false);
    expect(output.storageKey).toBeUndefined();
  });

  it("R2 non configuré : création workspace normale, pas de fausse promesse de copie", async () => {
    isR2ConfiguredMock.mockReturnValue(false);

    const output = (await createFileTool.execute(
      {
        workspaceId: "ws1",
        filename: "b.txt",
        dataBase64: Buffer.from("ok").toString("base64"),
        encoding: "base64",
      },
      { userId: "u1" },
    )) as { success: boolean; copiePermanente?: boolean };

    expect(output.success).toBe(true);
    expect(output.copiePermanente).toBe(false);
    expect(uploadToR2Mock).not.toHaveBeenCalled();
  });

  it("les protections d'origine restent intègres (traversée, payload)", async () => {
    await expect(
      createFileTool.execute(
        { workspaceId: "ws1", filename: "../escape.txt", dataBase64: "aGk=", encoding: "base64" },
        { userId: "u1" },
      ),
    ).rejects.toThrow();

    await expect(
      createFileTool.execute(
        {
          workspaceId: "ws1",
          filename: "gros.bin",
          dataBase64: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"),
          encoding: "base64",
        },
        { userId: "u1" },
      ),
    ).rejects.toThrow("exceeds 10 MiB");
  });
});
