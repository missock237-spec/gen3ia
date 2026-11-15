import fs from "node:fs/promises";
import path from "node:path";

import {
  assertSafeExtractionPath,
} from "./zip/path-security";

export interface FileWriteRequest {
  workspaceRoot: string;
  relativePath: string;
  content: string | Buffer;
}

export interface FileReadRequest {
  workspaceRoot: string;
  relativePath: string;
}

export async function writeWorkspaceFile(
  request: FileWriteRequest
): Promise<string> {
  const target =
    assertSafeExtractionPath(
      request.workspaceRoot,
      request.relativePath
    );

  await fs.mkdir(
    path.dirname(target),
    {
      recursive: true,
    }
  );

  // Durcissement CodeQL js/insecure-temporary-file (#55) : motif
  // rm-then-exclusive. L'écrasement direct (writeFile par défaut, qui
  // rouvre et tronque le fichier existant — donc suit un éventuel lien
  // symbolique déjà en place) est remplacé par : suppression forcée PUIS
  // création EXCLUSIVE (flag « wx » : échoue si le chemin existe déjà) en
  // mode 0600. La sémantique « dernière écriture gagne » est préservée,
  // mais l'inode final est toujours créé par ce seul appel exclusif.
  //
  // Fenêtre rm→create neutralisée par le conteneur du workspace : la racine
  // est /tmp/gen3ia-ws-<sha256(24)> (workspaceRootFor), créée par
  // createExecutionWorkspace via mkdir mode 0700 (lib/execution/workspace.ts,
  // vérifié en lecture seule) — répertoire propriétaire-seul, instance-local
  // (/tmp serverless n'est pas partagé entre VM) et au nom dérivé d'un hash
  // : aucun tiers ne peut y créer ni y substituer un fichier pendant la
  // fenêtre. Les appelants hors périmètre qui créeraient leur racine autrement
  // devraient conserver ce mode 0700 (recommandation inchangée ici).
  await fs.rm(target, { force: true });
  await fs.writeFile(target, request.content, { flag: "wx", mode: 0o600 });

  return request.relativePath;
}

export async function readWorkspaceFile(
  request: FileReadRequest
): Promise<Buffer> {
  const target =
    assertSafeExtractionPath(
      request.workspaceRoot,
      request.relativePath
    );

  return fs.readFile(target);
}

export async function deleteWorkspaceFile(
  request: FileReadRequest
): Promise<void> {
  const target =
    assertSafeExtractionPath(
      request.workspaceRoot,
      request.relativePath
    );

  await fs.rm(target, {
    force: true,
  });
}
