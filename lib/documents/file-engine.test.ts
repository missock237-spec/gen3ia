import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readWorkspaceFile, writeWorkspaceFile } from "./file-engine";
import { UnsafeArchivePathError } from "./zip/path-security";

// ────────────────────────────────────────────────────────────────────────────
// Task 104-c — garde du moteur de fichiers workspace (alerte CodeQL #55 :
// création exclusive en mode 0600, sémantique d'écrasement préservée,
// refus de traverse toujours actif).
// ────────────────────────────────────────────────────────────────────────────

async function makeWorkspace(): Promise<string> {
  // mkdtemp : répertoire 0700 imprévisible, équivalent à la racine réelle
  // des workspaces (createExecutionWorkspace : mkdir mode 0700).
  return mkdtemp(path.join(tmpdir(), "gen3ia-file-engine-test-"));
}

describe("writeWorkspaceFile / readWorkspaceFile (Task 104-c)", () => {
  let workspaceRoot = "";

  afterEach(async () => {
    if (workspaceRoot) {
      await rm(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = "";
    }
  });

  it("écrit puis relit un fichier (contenu exact, chemin relatif rendu)", async () => {
    workspaceRoot = await makeWorkspace();
    const returned = await writeWorkspaceFile({
      workspaceRoot,
      relativePath: "notes/rapport.md",
      content: "# Rapport\n\nContenu initial.",
    });
    expect(returned).toBe("notes/rapport.md");
    const content = await readWorkspaceFile({ workspaceRoot, relativePath: "notes/rapport.md" });
    expect(content.toString("utf8")).toBe("# Rapport\n\nContenu initial.");
  });

  it("réécriture du même chemin = écrasement (sémantique préservée par rm-then-exclusive)", async () => {
    workspaceRoot = await makeWorkspace();
    await writeWorkspaceFile({ workspaceRoot, relativePath: "out.json", content: '{"v":1}' });
    await writeWorkspaceFile({ workspaceRoot, relativePath: "out.json", content: '{"v":2}' });
    const content = await readWorkspaceFile({ workspaceRoot, relativePath: "out.json" });
    expect(content.toString("utf8")).toBe('{"v":2}');
  });

  it("fichier écrit en mode 0600 (propriétaire seul, durcissement CodeQL #55)", async () => {
    workspaceRoot = await makeWorkspace();
    await writeWorkspaceFile({ workspaceRoot, relativePath: "secret.txt", content: "donnée" });
    const infos = await stat(path.join(workspaceRoot, "secret.txt"));
    // 0600 : aucun bit groupe/autres — l'umask ne peut que restreindre,
    // jamais élargir, l'assertion tient sous tout umask raisonnable.
    expect(infos.mode & 0o777).toBe(0o600);
  });

  it("contenu binaire (Buffer) supporté", async () => {
    workspaceRoot = await makeWorkspace();
    const payload = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42]);
    await writeWorkspaceFile({ workspaceRoot, relativePath: "media.bin", content: payload });
    const content = await readWorkspaceFile({ workspaceRoot, relativePath: "media.bin" });
    expect(content).toEqual(payload);
  });

  it("refus de traverse : ../ et chemins absolus rejetés (barrière inchangée)", async () => {
    workspaceRoot = await makeWorkspace();
    await expect(
      writeWorkspaceFile({ workspaceRoot, relativePath: "../evadé.txt", content: "x" }),
    ).rejects.toBeInstanceOf(UnsafeArchivePathError);
    await expect(
      writeWorkspaceFile({ workspaceRoot, relativePath: "/etc/passwd", content: "x" }),
    ).rejects.toBeInstanceOf(UnsafeArchivePathError);
    await expect(
      writeWorkspaceFile({ workspaceRoot, relativePath: "a/../../évadé", content: "x" }),
    ).rejects.toBeInstanceOf(UnsafeArchivePathError);
  });
});
