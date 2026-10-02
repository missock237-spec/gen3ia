import "server-only";

import fs from "node:fs/promises";

import { adminDb } from "@/lib/firebase/admin";

import type { ExecutionWorkspace } from "./workspace";
import { workspaceRootFor } from "./workspace";

/**
 * Registre des workspaces d'exécution (Task 62 — priorité #5, scalabilité
 * horizontale).
 *
 * AVANT : une Map en mémoire de processus → toute reprise de l'espace de
 * travail par une AUTRE instance serverless (ou après un cold start du
 * processus, ou entre deux tranches d'une mission QStash) échouait avec
 * « Workspace access denied » alors même que le propriétaire appelait —
 * briseur de correction en multi-instances, invisible en mono-instance
 * tiède. Les fichiers /tmp, eux, fuyaient aussi : removeWorkspace et
 * destroyExecutionWorkspace n'avaient AUCUN appelant.
 *
 * MAINTENANT : la PROPRIÉTÉ (ownerId, executionId, création, expiration)
 * vit dans Firestore (collection `executionWorkspaces`, TTL 24 h). Le
 * chemin /tmp reste instance-local ET déterministe (workspaceRootFor) :
 * la même VM peut se rattacher à un répertoire existant, une autre VM ne
 * peut PAS accéder aux fichiers d'une autre — l'appelant reçoit alors une
 * erreur de fichier honnête (ENOENT) plutôt qu'un refus d'accès trompeur.
 * C'est la dégradation gracieuse documentée : sans stockage objet partagé,
 * aucun montage cross-instance n'est correct ; le registre, lui, garantit
 * la propriété et l'anti-énumération partout.
 *
 * SÉCURITÉ : l'anti-énumération repose sur le check ownerId exact ; un
 * workspace expiré est traité comme inexistant (404 équivalent) avec
 * purge best-effort du répertoire local.
 */

const COLLECTION = "executionWorkspaces";

/** Durée de vie d'un workspace : 24 h (éphémère par conception). */
export const WORKSPACE_TTL_MS = 24 * 60 * 60 * 1000;

export interface WorkspaceRecord extends ExecutionWorkspace {
  ownerId: string;
  executionId: string;
  createdAtMs: number;
  expiresAtMs: number;
}

function docRef(workspaceId: string) {
  return adminDb.collection(COLLECTION).doc(workspaceId);
}

/** Écrit l'enregistrement de propriété (Firestore = source de vérité). */
export async function registerWorkspace(
  workspace: ExecutionWorkspace,
  ownerId: string,
  executionId: string,
): Promise<void> {
  const now = Date.now();
  await docRef(workspace.id).set({
    id: workspace.id,
    ownerId,
    executionId,
    createdAtMs: now,
    expiresAtMs: now + WORKSPACE_TTL_MS,
  });
}

/** Purge best-effort du répertoire LOCAL (jamais une erreur bloquante). */
async function purgeLocalDir(workspaceId: string): Promise<void> {
  await fs.rm(workspaceRootFor(workspaceId), { recursive: true, force: true }).catch(() => undefined);
}

export async function getWorkspace(
  workspaceId: string,
): Promise<WorkspaceRecord | null> {
  const snap = await docRef(workspaceId).get();
  const data = snap.data() as
    | (Omit<WorkspaceRecord, "root"> & { root?: never })
    | undefined;
  if (!data) return null;

  if (data.expiresAtMs <= Date.now()) {
    // Expiré : équivalent 404 + purge best-effort du répertoire local.
    await docRef(workspaceId).delete().catch(() => undefined);
    await purgeLocalDir(workspaceId);
    return null;
  }

  // Racine dérivée localement : /tmp est instance-local par conception.
  return { ...data, root: workspaceRootFor(data.id) };
}

export async function assertWorkspaceOwner(
  workspaceId: string,
  ownerId: string,
): Promise<WorkspaceRecord> {
  const workspace = await getWorkspace(workspaceId);

  if (!workspace || workspace.ownerId !== ownerId) {
    throw new Error("Workspace access denied");
  }

  return workspace;
}

/** Désenregistre (et purge le répertoire local si fourni). */
export async function removeWorkspace(
  workspaceId: string,
): Promise<void> {
  await docRef(workspaceId).delete().catch(() => undefined);
  await purgeLocalDir(workspaceId);
}
