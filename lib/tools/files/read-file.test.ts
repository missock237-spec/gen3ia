import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage/r2", () => ({
  downloadFromR2: vi.fn(),
}));
vi.mock("@/lib/documents/file-engine", () => ({
  readWorkspaceFile: vi.fn(),
}));
vi.mock("@/lib/execution/workspace-registry", () => ({
  assertWorkspaceOwner: vi.fn(),
}));

import { downloadFromR2 } from "@/lib/storage/r2";
import { assertWorkspaceOwner } from "@/lib/execution/workspace-registry";
import { readWorkspaceFile } from "@/lib/documents/file-engine";
import { readFileTool } from "./read-file";

const mockedDownload = vi.mocked(downloadFromR2);
const mockedAssertWorkspace = vi.mocked(assertWorkspaceOwner);
const mockedReadWorkspace = vi.mocked(readWorkspaceFile);

const CONTEXT = { userId: "user-1", executionId: "exec-1" };

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * file.read RÉEL (exigence production) : l'outil était annoncé au
 * planificateur mais aucun exécuteur n'existait — toute étape file.read
 * échouait. Verrou : lecture du stockage permanent du propriétaire
 * (cloisonnement strict) et lecture de workspace autorisé.
 */
describe("outil file.read (exécuteur réel)", () => {
  it("est enregistré avec l'identifiant canonique et un risque de lecture", () => {
    expect(readFileTool.id).toBe("file.read");
    expect(readFileTool.risk).toBe("low");
  });

  it("lit un fichier du stockage permanent du propriétaire avec conversion réelle", async () => {
    mockedDownload.mockResolvedValue(Buffer.from("Rapport confidentiel : ventes 2026.") as never);
    const output = await readFileTool.execute(
      { path: "users/user-1/permanent/rapport.txt" },
      CONTEXT,
    );
    expect(output).toMatchObject({
      source: "permanent",
      kind: "text",
      conversion: "full",
      charCount: 35,
      content: "Rapport confidentiel : ventes 2026.",
      truncated: false,
    });
  });

  it("REFUSE une clé permanente d'un autre utilisateur (cloisonnement strict)", async () => {
    await expect(
      readFileTool.execute({ path: "users/victime/permanent/secret.txt" }, CONTEXT),
    ).rejects.toThrow(/workspaceId/);
    expect(mockedDownload).not.toHaveBeenCalled();
  });

  it("trunque le contenu au plafond de sortie (contexte outillage borné)", async () => {
    mockedDownload.mockResolvedValue(Buffer.from("a".repeat(60_000), "utf8") as never);
    const output = (await readFileTool.execute(
      { path: "users/user-1/permanent/big.txt" },
      CONTEXT,
    )) as { truncated: boolean; content: string; charCount: number };
    expect(output.truncated).toBe(true);
    expect(output.charCount).toBe(60_000);
    expect(output.content.endsWith("…")).toBe(true);
    expect(output.content.length).toBeLessThan(60_000);
  });

  it("lit un fichier de workspace autorisé (workspaceId + chemin relatif sûr)", async () => {
    mockedAssertWorkspace.mockResolvedValue({ id: "ws-1", root: "/tmp/ws", ownerId: "user-1", createdAtMs: Date.now(), expiresAtMs: Date.now() + 1_000 } as never);
    mockedReadWorkspace.mockResolvedValue(Buffer.from("contenu workspace") as never);
    const output = await readFileTool.execute(
      { path: "docs/notes.md", workspaceId: "ws-1" },
      CONTEXT,
    );
    expect(output).toMatchObject({ source: "workspace", conversion: "full", content: "contenu workspace" });
  });

  it("refuse la traversée de chemin dans un workspace", async () => {
    mockedAssertWorkspace.mockResolvedValue({ id: "ws-1", root: "/tmp/ws", ownerId: "user-1", createdAtMs: Date.now(), expiresAtMs: Date.now() + 1_000 } as never);
    await expect(
      readFileTool.execute({ path: "../../etc/passwd", workspaceId: "ws-1" }, CONTEXT),
    ).rejects.toThrow(/Unsafe/);
    expect(mockedReadWorkspace).not.toHaveBeenCalled();
  });

  it("exige workspaceId pour un chemin hors stockage permanent", async () => {
    await expect(
      readFileTool.execute({ path: "docs/notes.md" }, CONTEXT),
    ).rejects.toThrow(/workspaceId/);
  });
});
