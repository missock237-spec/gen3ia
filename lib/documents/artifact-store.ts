import crypto from "node:crypto";
import fs from "node:fs/promises";

import {
  createR2DownloadUrl,
  deleteFromR2,
  isR2Configured,
  uploadToR2,
} from "@/lib/storage/r2";
import { createArtifactId, createArtifactStorageKey } from "./artifact";
import { assertArtifactOwner } from "./artifact-access";
import {
  createArtifactRecord,
  deleteArtifactRecord,
  getArtifactRecord,
} from "./artifact-repository";

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const ALLOWED_MIME = /^(?:text|image|audio|video|application)\/[a-z0-9.+-]+$/i;

function assertArtifactPayload(data: Buffer, mimeType: string): void {
  if (data.length > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds the 100 MiB limit");
  if (!ALLOWED_MIME.test(mimeType)) throw new Error("Unsupported artifact content type");
}

export interface StoreArtifactInput {
  ownerId: string;
  executionId: string;
  name: string;
  mimeType: string;
  data: Uint8Array | Buffer;
  expiresAt?: number;
}

/** Taille maximale d'un livrable stocké directement en base (base64 < 1 Mo/doc Firestore). */
const INLINE_MAX_BYTES = 700 * 1024;

export async function storeArtifactBuffer(input: StoreArtifactInput) {
  const data = Buffer.from(input.data);
  assertArtifactPayload(data, input.mimeType);
  const artifactId = createArtifactId();
  const storageKey = createArtifactStorageKey(input.ownerId, artifactId, input.name);
  const checksum = crypto.createHash("sha256").update(data).digest("hex");

  // Repli SANS R2 (credentials non configurés) : les petits livrables sont
  // stockés directement en base — la génération de documents reste réelle
  // et téléchargeable au lieu d'échouer sur la configuration de stockage.
  if (!isR2Configured()) {
    if (data.length > INLINE_MAX_BYTES) {
      throw new Error(
        `Le stockage fichiers (R2) n'est pas configuré et ce livrable dépasse ${Math.floor(INLINE_MAX_BYTES / 1024)} Ko. Renseignez R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY et R2_BUCKET dans Vercel.`,
      );
    }
    const artifact = {
      artifactId,
      ownerId: input.ownerId,
      executionId: input.executionId,
      name: input.name,
      mimeType: input.mimeType,
      size: data.length,
      storageKey: `inline/${artifactId}`,
      checksum,
      createdAt: Date.now(),
      inlineData: data.toString("base64"),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
    await createArtifactRecord(artifact);
    return artifact;
  }

  let uploadedKey: string | null = null;

  try {
    await uploadToR2(storageKey, data, input.mimeType);
    uploadedKey = storageKey;
    const artifact = {
      artifactId,
      ownerId: input.ownerId,
      executionId: input.executionId,
      name: input.name,
      mimeType: input.mimeType,
      size: data.length,
      storageKey,
      checksum,
      createdAt: Date.now(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
    await createArtifactRecord(artifact);
    return artifact;
  } catch (error) {
    if (uploadedKey) await deleteFromR2(uploadedKey).catch(() => undefined);
    throw error;
  }
}

export async function storeLocalArtifact(input: {
  ownerId: string;
  executionId: string;
  localPath: string;
  name: string;
  mimeType: string;
  expiresAt?: number;
}) {
  try {
    const data = await fs.readFile(input.localPath);
    return await storeArtifactBuffer({ ...input, data });
  } finally {
    await fs.rm(input.localPath, { force: true }).catch(() => undefined);
  }
}

export async function getArtifactDownloadUrl(artifactId: string, userId: string) {
  const artifact = await getArtifactRecord(artifactId);
  if (!artifact) throw new Error("Artifact not found");
  assertArtifactOwner(artifact, userId);
  if (artifact.expiresAt && artifact.expiresAt <= Date.now()) throw new Error("Artifact expired");
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 0 || artifact.size > MAX_ARTIFACT_BYTES) {
    throw new Error("Artifact exceeds the download size limit");
  }
  if (typeof artifact.mimeType !== "string" || !ALLOWED_MIME.test(artifact.mimeType)) {
    throw new Error("Artifact content type is not allowed");
  }
  // Livrable stocké en base (repli sans R2) : l'URL sert le contenu depuis
  // la route dédiée (authentifiée par cookie, propriétaire uniquement).
  if (artifact.inlineData) return `/api/files/artifacts/${artifactId}/inline`;
  return createR2DownloadUrl(artifact.storageKey, 300);
}

export async function removeArtifact(artifactId: string, userId: string) {
  const artifact = await getArtifactRecord(artifactId);
  if (!artifact) throw new Error("Artifact not found");
  assertArtifactOwner(artifact, userId);
  // Livrable inline (repli sans R2) : rien à supprimer côté stockage objet.
  if (!artifact.inlineData) {
    await deleteFromR2(artifact.storageKey);
  }
  await deleteArtifactRecord(artifactId);
}
