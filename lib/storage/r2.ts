import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, HeadObjectCommand, ListObjectsV2Command, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Timeouts HTTP EXPLICITES (audit 10-10 — erreurs « <!DOCTYPE … is not valid
 * JSON ») : sans timeout, un R2 qui ne répond pas fait PENDRE la fonction
 * serverless jusqu'au kill Vercel, qui renvoie une page HTML d'erreur que le
 * client tente de parser en JSON. Chaque appel est désormais borné :
 *   - connexion TCP/TLS : 5 s ;
 *   - réponse (socket) : 20 s — largement au-dessus d'un R2 sain (< 1 s),
 *     assez bas pour échouer AVANT le maxDuration Vercel ;
 *   - 2 tentatives SDK (repli rapide sur erreur transitoire).
 * Les pannes deviennent des exceptions classifiées rapides (UserDataError /
 * FsError « unavailable ») au lieu de pages HTML.
 */
const R2_HTTP_HANDLER = new NodeHttpHandler({
  connectionTimeout: 5_000,
  socketTimeout: 20_000,
});

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
    requestHandler: R2_HTTP_HANDLER,
    maxAttempts: 2,
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
/* Écritures conditionnelles (migration R2 totale — moteur r2fs)        */
/* ------------------------------------------------------------------ */
/* Cloudflare R2 supporte les écritures conditionnelles S3 : un PUT      */
/* avec If-Match (ETag exact) ou If-None-Match: * échoue en 412          */
/* PreconditionFailed quand la condition n'est pas satisfaite. C'est la  */
/* brique d'atomicité qui remplace les transactions Firestore :          */
/* compare-and-swap par document, claim de mission, débit de wallet.     */

/**
 * Vrai si l'erreur signale l'échec d'une précondition d'écriture (412).
 * Classifie TOUTES les formes observées (SDK réel + mocks mémoire) :
 * nom/code "PreconditionFailed", statut HTTP 412, message portant 412 ou
 * "Precondition Failed".
 */
export function isR2PreconditionFailed(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidat = error as { name?: unknown; Code?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown }; message?: unknown };
  if (candidat.name === "PreconditionFailedException" || candidat.name === "PreconditionFailed") return true;
  if (candidat.Code === "PreconditionFailed" || candidat.code === "PreconditionFailed") return true;
  if (candidat.$metadata?.httpStatusCode === 412) return true;
  const message = typeof candidat.message === "string" ? candidat.message : "";
  return message.includes("412") || /precondition failed/i.test(message);
}

export interface R2ObjectWithEtag {
  data: Buffer;
  /** ETag S3 (entre guillemets, forme canonique renvoyée par R2). */
  etag: string;
}

/**
 * Télécharge un objet et renvoie son ETag (base du compare-and-swap).
 * Objet absent → null. Toute autre erreur propage. Même garde de taille
 * que downloadFromR2 (lecture bornée).
 */
export async function getObjectWithEtag(key: string, maxBytes = 100 * 1024 * 1024): Promise<R2ObjectWithEtag | null> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid R2 read limit");
  const { bucket } = getConfig();
  let response: { ETag?: string; ContentLength?: number; Body?: unknown };
  try {
    response = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    if (isR2NotFound(error)) return null;
    throw error;
  }
  if (!response.Body) throw new Error("R2 object has no body");
  const destroyBody = () => (response.Body as unknown as { destroy?: () => void }).destroy?.();
  if (typeof response.ContentLength === "number" && response.ContentLength > maxBytes) {
    destroyBody();
    throw new Error("R2 object exceeds configured read limit");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of response.Body as AsyncIterable<Uint8Array | Buffer | string>) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) {
        destroyBody();
        throw new Error("R2 object exceeds configured read limit");
      }
      chunks.push(bytes);
    }
  } finally {
    // Libère la connexion même en cas d'interruption de la boucle.
    destroyBody();
  }
  return {
    data: Buffer.concat(chunks, total),
    etag: typeof response.ETag === "string" ? response.ETag : "",
  };
}

/** Vrai si l'erreur signale une clé ABSENTE (NoSuchKey / NotFound / 404). */
function isR2NotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidat = error as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown }; message?: unknown };
  if (candidat.name === "NoSuchKey" || candidat.name === "NotFound") return true;
  if (candidat.Code === "NoSuchKey" || candidat.Code === "NotFound") return true;
  if (candidat.$metadata?.httpStatusCode === 404) return true;
  return typeof candidat.message === "string" && /no such key|not found/i.test(candidat.message);
}

export interface ConditionalPutResult {
  /** ETag du nouvel objet (base d'un futur If-Match). */
  etag: string;
}

/**
 * PUT conditionnel — cœur du compare-and-swap R2 :
 *  - `ifMatch` : l'écriture ne réussit que si l'objet actuel porte EXACTEMENT
 *    cette ETag (remplacement d'un document lu au préalable) ;
 *  - `ifNoneMatch: "*"` : l'écriture ne réussit que si l'objet N'EXISTE PAS
 *    (création atomique — append de ledger, claim initial) ;
 *  - ni l'un ni l'autre : écriture inconditionnelle (last-write-wins).
 *
 * Précondition non satisfaite → retour null (PAS d'exception) : le caller
 * décide (retry transactionnel, abandon, no-op). Les deux conditions sont
 * mutuellement exclusives (argument invalide sinon).
 */
export async function putObjectConditional(
  key: string,
  body: Uint8Array | Buffer,
  contentType: string,
  opts?: { ifMatch?: string; ifNoneMatch?: "*" },
): Promise<ConditionalPutResult | null> {
  if (opts?.ifMatch && opts.ifNoneMatch) {
    throw new Error("putObjectConditional: ifMatch et ifNoneMatch sont mutuellement exclusifs");
  }
  const { bucket } = getConfig();
  try {
    const response = await getClient().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: body.byteLength,
      ...(opts?.ifMatch ? { IfMatch: opts.ifMatch } : {}),
      ...(opts?.ifNoneMatch ? { IfNoneMatch: opts.ifNoneMatch } : {}),
    }));
    return { etag: typeof response.ETag === "string" ? response.ETag : "" };
  } catch (error) {
    if (isR2PreconditionFailed(error)) return null;
    throw error;
  }
}

/**
 * DELETE conditionnel : ne supprime que si l'objet porte l'ETag attendu.
 * Retourne true si supprimé, false si la précondition a échoué (l'objet a
 * changé sous nos pieds). Objet déjà absent → true (idempotent).
 */
export async function deleteObjectConditional(key: string, ifMatch: string): Promise<boolean> {
  const { bucket } = getConfig();
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key, ...(ifMatch ? { IfMatch: ifMatch } : {}) }));
    return true;
  } catch (error) {
    if (isR2PreconditionFailed(error)) return false;
    if (isR2NotFound(error)) return true;
    throw error;
  }
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
