import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createExecutionWorkspace,
  destroyExecutionWorkspace,
  workspaceRootFor,
} from "./workspace";

const EXECUTION_IDS = ["exec-104d-a", "exec-104d-b"];

async function cleanup(): Promise<void> {
  await Promise.all(
    EXECUTION_IDS.map(async (executionId) => {
      const created = await createExecutionWorkspace(executionId).catch(() => null);
      if (created) await destroyExecutionWorkspace(created).catch(() => undefined);
    }),
  );
}

afterEach(cleanup);

describe("workspace d'exécution (racine /tmp déterministe — Task 62)", () => {
  it("workspaceRootFor : dérivation déterministe sous le tmpdir de l'instance", () => {
    expect(workspaceRootFor("abc123")).toBe(path.join(os.tmpdir(), "gen3ia-ws-abc123"));
    // Déterministe : la même instance relance le même chemin (rattachement).
    expect(workspaceRootFor("abc123")).toBe(workspaceRootFor("abc123"));
  });

  it("createExecutionWorkspace : répertoire 0700 réutilisable (rattachement sans perte)", async () => {
    const first = await createExecutionWorkspace(EXECUTION_IDS[0]!);
    expect(first.id).toHaveLength(24);
    expect(first.root).toBe(workspaceRootFor(first.id));

    const stat = await fs.stat(first.root);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);

    // Re-création (autre invocation, même VM) : les fichiers existants restent.
    await fs.writeFile(path.join(first.root, "etat.txt"), "état de la tranche 1", "utf8");
    const second = await createExecutionWorkspace(EXECUTION_IDS[0]!);
    expect(second.id).toBe(first.id);
    expect(await fs.readFile(path.join(second.root, "etat.txt"), "utf8")).toBe("état de la tranche 1");
  });

  it("destroyExecutionWorkspace : suppression récursive du répertoire local", async () => {
    const workspace = await createExecutionWorkspace(EXECUTION_IDS[1]!);
    await fs.writeFile(path.join(workspace.root, "fichier.txt"), "à détruire", "utf8");

    await destroyExecutionWorkspace(workspace);

    await expect(fs.stat(workspace.root)).rejects.toThrow();
  });
});
