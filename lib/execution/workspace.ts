import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export interface ExecutionWorkspace {
  id: string;
  root: string;
}

/**
 * Racine DÉTERMINISTE d'un workspace : dérivée du hash de l'executionId
 * (Task 62 — scalabilité horizontale). Une racine prédictible permet à
 * TOUTE instance relançant le même chemin de se rattacher au répertoire
 * /tmp existant (les environnements d'exécution serverless conservent /tmp
 * entre invocations d'une même VM) — l'ancienne racine mkdtemp aléatoire
 * rendait tout rattachement impossible après un redémarrage.
 *
 * Le registre (workspace-registry) reste la source de vérité de la
 * PROPRIÉTÉ (owner/expiry) en Firestore ; le chemin, lui, est dérivé
 * localement à chaque instance — /tmp est volontairement éphémère et
 * instance-local, jamais partagé entre VM.
 */
export function workspaceRootFor(workspaceId: string): string {
  return path.join(os.tmpdir(), `gen3ia-ws-${workspaceId}`);
}

export async function createExecutionWorkspace(
  executionId: string
): Promise<ExecutionWorkspace> {
  const safeId =
    crypto
      .createHash("sha256")
      .update(executionId)
      .digest("hex")
      .slice(0, 24);

  const root = workspaceRootFor(safeId);

  // mkdir récursif idempotent (mode 0700) : reprend un répertoire existant
  // s'il y a déjà des fichiers (rattachement), le crée sinon — et refuse
  // silencieusement un concurrent qui l'aurait créé entre-temps (EEXIST).
  await fs.mkdir(root, { recursive: true, mode: 0o700 });

  return {
    id: safeId,
    root,
  };
}

export async function destroyExecutionWorkspace(
  workspace: ExecutionWorkspace
): Promise<void> {
  await fs.rm(
    workspace.root,
    {
      recursive: true,
      force: true,
    },
  );
}
