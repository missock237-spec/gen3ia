import "server-only";

import fs from "node:fs/promises";

import { adminDb } from "@/lib/firebase/admin";

import type { ExecutionWorkspace } from "./workspace";
import { workspaceRootFor } from "./workspace";
import {
  probeAndSnapshotWorkspaceIfChanged,
  rehydrateWorkspaceIfLocalMissing,
  snapshotWorkspaceSafe,
  type DurableSnapshotManifest,
} from "./workspace-durability";

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
 *
 * Task 104-d — DURABILITÉ (reprise inter-instance) : le registre porte
 * désormais AUSSI le manifeste de l'instantané R2 (UN SEUL champ
 * `durableSnapshot`, écrit en merge par workspace-durability.ts) :
 *  - REPRISE (getWorkspace) : répertoire /tmp absent + manifeste présent →
 *    restauration depuis R2 AVANT de rendre le workspace (sinon l'appelant
 *    retrouvait l'ENOENT documenté ci-dessus) ;
 *  - CHECKPOINT (registerWorkspace) : chaque enregistrement/usage déclenche
 *    un snapshot fire-and-forget SÉCURISÉ ; getWorkspace y ajoute une sonde
 *    locale de changement (R2 configuré uniquement — sans R2, comportement
 *    inchangé : aucun accès fs ajouté).
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
  // Merge (Task 104-d) : conserve le champ `durableSnapshot` écrit par les
  // checkpoints de durabilité — un set plein l'effacerait à chaque usage.
  await docRef(workspace.id).set(
    {
      id: workspace.id,
      ownerId,
      executionId,
      createdAtMs: now,
      expiresAtMs: now + WORKSPACE_TTL_MS,
    },
    { merge: true },
  );
  // CHECKPOINT durabilité (Task 104-d) : fire-and-forget SÉCURISÉ — borné
  // (8 s), coalescé, erreurs loggées, jamais bloquant pour l'appelant.
  // R2 non configuré → no-op immédiat (comportement actuel inchangé).
  void snapshotWorkspaceSafe(workspace.id);
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
    | (Omit<WorkspaceRecord, "root"> & {
        root?: never;
        durableSnapshot?: DurableSnapshotManifest;
      })
    | undefined;
  if (!data) return null;

  if (data.expiresAtMs <= Date.now()) {
    // Expiré : équivalent 404 + purge best-effort du répertoire local.
    await docRef(workspaceId).delete().catch(() => undefined);
    await purgeLocalDir(workspaceId);
    return null;
  }

  // Task 104-d — REPRISE INTER-INSTANCE : /tmp est instance-local ; si le
  // répertoire local est ABSENT alors qu'un manifeste durable existe, le
  // contenu est restauré depuis R2 AVANT de rendre le workspace (sinon
  // l'appelant retrouvait l'ENOENT documenté). Fail-soft : en cas d'échec,
  // le comportement historique (ENOENT honnête) est conservé.
  if (data.durableSnapshot) {
    await rehydrateWorkspaceIfLocalMissing(data.id, data.durableSnapshot).catch(() => undefined);
  }

  // Task 104-d — CHECKPOINT continu : sonde locale (readdir+stat plafonnés,
  // ~ms) ; au changement de contenu → snapshot R2 fire-and-forget. R2 non
  // configuré → no-op immédiat (zéro accès fs ajouté en production actuelle).
  await probeAndSnapshotWorkspaceIfChanged(data.id).catch(() => undefined);

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

/**
 * Désenregistre (et purge le répertoire local si fourni).
 *
 * Task 104-d : PAS de snapshot ici — le manifeste vit DANS le document de
 * registre, supprimé juste après : la copie deviendrait introuvable (objets
 * R2 orphelins). La purge du stockage durable suit donc la TTL du workspace.
 */
export async function removeWorkspace(
  workspaceId: string,
): Promise<void> {
  await docRef(workspaceId).delete().catch(() => undefined);
  await purgeLocalDir(workspaceId);
}
