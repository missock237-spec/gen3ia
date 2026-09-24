import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, HeadObjectCommand, ListObjectsV2Command, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function getConfig() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) throw new Error("R2 configuration is incomplete");
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

function getClient() {
  const { accountId, accessKeyId, secretAccessKey } = getConfig();
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export async function uploadToR2(key: string, body: Uint8Array | Buffer, contentType: string): Promise<void> {
  const { bucket } = getConfig();
  await getClient().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ContentLength: body.byteLength,
  }));
}

export async function putObject(options: {
  key: string;
  body: Uint8Array | Buffer;
  contentType: string;
  contentLength?: number;
}) {
  return uploadToR2(options.key, options.body, options.contentType);
}

/**
 * Downloads an R2 object without ever buffering more than maxBytes.
 * ContentLength is rejected before the network body is consumed when available;
 * streamed chunks are also bounded to protect against incorrect/missing metadata.
 */
export async function downloadFromR2(key: string, maxBytes = 100 * 1024 * 1024): Promise<Buffer> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid R2 read limit");

  const { bucket } = getConfig();
  const response = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error("R2 object has no body");
  const destroyBody = () => (response.Body as unknown as { destroy?: () => void }).destroy?.();
  if (typeof response.ContentLength === "number" && response.ContentLength > maxBytes) {
    destroyBody();
    throw new Error("R2 object exceeds configured read limit");
  }

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of response.Body as AsyncIterable<Uint8Array | Buffer | string>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      destroyBody();
      throw new Error("R2 object exceeds configured read limit");
    }
    chunks.push(bytes);
  }

  return Buffer.concat(chunks, total);
}

export async function deleteFromR2(key: string): Promise<void> {
  const { bucket } = getConfig();
  await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function deleteObject(key: string): Promise<void> {
  return deleteFromR2(key);
}

export async function createR2DownloadUrl(key: string, expiresIn = 300): Promise<string> {
  const { bucket } = getConfig();
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 3600) throw new Error("Invalid signed URL expiration");
  return getSignedUrl(getClient(), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}

export async function createDownloadUrl(key: string, expiresIn = 600): Promise<string> {
  return createR2DownloadUrl(key, expiresIn);
}

/* ------------------------------------------------------------------ */
/* Multipart (televersement direct navigateur -> R2)                   */
/* ------------------------------------------------------------------ */

export type MultipartPart = { partNumber: number; etag: string };

/** Ouvre un upload multipart et retourne son identifiant R2. */
export async function createMultipartUpload(key: string, contentType: string): Promise<string> {
  const { bucket } = getConfig();
  const response = await getClient().send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType || "application/octet-stream" }));
  if (!response.UploadId) throw new Error("R2 n'a pas retourne d'identifiant multipart.");
  return response.UploadId;
}

/** URL presignee (1 h) pour qu'un navigateur depose une piece directement chez R2. */
export async function presignPartUpload(key: string, uploadId: string, partNumber: number, expiresIn = 3600): Promise<string> {
  const { bucket } = getConfig();
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new Error("Numéro de partie invalide.");
  return getSignedUrl(getClient(), new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn });
}

/** Assemble definitivement l'objet a partir des pieces recues. */
export async function completeMultipartUpload(key: string, uploadId: string, parts: MultipartPart[]): Promise<{ sizeBytes: number; contentType: string }> {
  const { bucket } = getConfig();
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  await getClient().send(new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: sorted.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) },
  }));
  const head = await getClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  return { sizeBytes: Number(head.ContentLength ?? 0), contentType: String(head.ContentType ?? "application/octet-stream") };
}

/** Annule un upload multipart (les pieces deposees sont purgees par R2). */
export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  const { bucket } = getConfig();
  await getClient().send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
}

/** Liste les objets sous un prefixe (nom, taille, date). */
export async function listObjectsUnderPrefix(prefix: string, maxResults = 500): Promise<Array<{ key: string; sizeBytes: number; updatedAt: string }>> {
  const { bucket } = getConfig();
  const results: Array<{ key: string; sizeBytes: number; updatedAt: string }> = [];
  let continuationToken: string | undefined;
  do {
    const response = await getClient().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: Math.min(1000, Math.max(1, maxResults - results.length)), ContinuationToken: continuationToken }));
    for (const object of response.Contents ?? []) {
      if (!object.Key) continue;
      results.push({
        key: object.Key,
        sizeBytes: Number(object.Size ?? 0),
        updatedAt: object.LastModified ? object.LastModified.toISOString() : "",
      });
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken && results.length < maxResults);
  return results;
}

/** Configuration CORS du bucket (televersement direct navigateur). */
export async function ensureBucketCors(allowedOrigins: string[]): Promise<{ applied: boolean }> {
  const { bucket } = getConfig();
  await getClient().send(new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: [{
        AllowedOrigins: allowedOrigins,
        AllowedMethods: ["PUT", "GET", "HEAD"],
        AllowedHeaders: ["*"],
        ExposeHeaders: ["ETag"],
        MaxAgeSeconds: 3600,
      }],
    },
  }));
  return { applied: true };
}

/* ------------------------------------------------------------------ */
/* Sonde de santé R2 (healthcheck infra)                               */
/* ------------------------------------------------------------------ */

export interface R2HealthStatus {
  ok: boolean;
  /** Raison stable de l'indisponibilité : "not_configured" | "timeout" | "error". */
  reason?: string;
}

/** Indique si les variables d'environnement R2 sont complètes, sans lever d'exception. */
export function isR2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET,
  );
}

/**
 * Sonde légère du stockage R2 : une seule requête ListObjects (MaxKeys=1)
 * bornée par un timeout court. Objectif : rendre visible une panne
 * autrement invisible (audit 25-d : /api/health/infra renvoyait ok:true
 * sans jamais vérifier R2).
 *
 * Cette sonde ne lève JAMAIS d'exception : un healthcheck doit rester
 * consommable même quand le stockage est hors service. Les env absentes
 * sont un état explicite ({ ok: false, reason: "not_configured" }), pas
 * une erreur.
 */
export async function pingR2(timeoutMs = 3_000): Promise<R2HealthStatus> {
  if (!isR2Configured()) return { ok: false, reason: "not_configured" };
  try {
    const { bucket } = getConfig();
    await getClient().send(
      new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }),
      { abortSignal: AbortSignal.timeout(timeoutMs) },
    );
    return { ok: true };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (name === "AbortError" || name === "TimeoutError" || /timeout|timed out|abort/i.test(message)) {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "error" };
  }
}
