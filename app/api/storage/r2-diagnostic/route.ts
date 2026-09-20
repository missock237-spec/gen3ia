import { NextRequest, NextResponse } from "next/server";
import {
  ListBucketsCommand,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { bootstrapBucketCors } from "@/lib/storage/permanent-user-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/storage/r2-diagnostic
 *
 * Diagnostic R2 bout-en-bout execute depuis le runtime de production.
 * Protege par le header x-diag-secret == process.env.R2_DIAG_SECRET.
 * Verifie : configuration, connectivite, listing des buckets, creation du
 * bucket applicatif et cycle put/get/delete.
 */
export async function GET(request: NextRequest) {
  const expected = process.env.R2_DIAG_SECRET;
  if (!expected || request.headers.get("x-diag-secret") !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET || "gen3ia-artifacts";

  const config = {
    R2_ACCOUNT_ID: Boolean(accountId),
    R2_ACCESS_KEY_ID: Boolean(accessKeyId),
    R2_SECRET_ACCESS_KEY: Boolean(secretAccessKey),
    R2_BUCKET: bucket,
  };

  const steps: Record<string, unknown> = { config };

  if (!accountId || !accessKeyId || !secretAccessKey) {
    return NextResponse.json(
      { ok: false, steps, error: "R2 configuration incomplete" },
      { status: 500 },
    );
  }

  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  // 1. Connectivite + listing
  let buckets: string[] = [];
  try {
    const resp = await s3.send(new ListBucketsCommand({}));
    buckets = (resp.Buckets ?? []).map((b) => b.Name ?? "");
    steps.listBuckets = { ok: true, buckets };
  } catch (error) {
    steps.listBuckets = {
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
    return NextResponse.json(
      { ok: false, steps, hint: "Echec ListBuckets : compte R2 non active ou credentials invalides." },
      { status: 502 },
    );
  }

  // 2. Creation du bucket applicatif si absent
  if (!buckets.includes(bucket)) {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      steps.createBucket = { ok: true, bucket };
    } catch (error) {
      steps.createBucket = {
        ok: false,
        bucket,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
      return NextResponse.json({ ok: false, steps }, { status: 502 });
    }
  } else {
    steps.createBucket = { ok: true, bucket, skipped: "already exists" };
  }

  // 3. Configuration CORS (televersement direct navigateur -> R2)
  const origin = process.env.APP_URL || "https://gen3ia.online";
  try {
    steps.cors = { ...(await bootstrapBucketCors([origin, "https://www.gen3ia.online", "http://localhost:3000"])), origins: [origin, "https://www.gen3ia.online", "http://localhost:3000"] };
  } catch (error) {
    steps.cors = { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    return NextResponse.json({ ok: false, steps }, { status: 502 });
  }

  // 4. Cycle put/get/delete
  const key = "_healthcheck/r2-diagnostic.txt";
  const payload = Buffer.from(`Gen3ia R2 diagnostic ${new Date().toISOString()}`);
  try {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: payload, ContentType: "text/plain" }));
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = Buffer.from(await obj.Body!.transformToByteArray());
    const roundTrip = body.equals(payload);
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    steps.roundTrip = { ok: roundTrip, bytes: payload.byteLength, cleanedUp: true };
  } catch (error) {
    steps.roundTrip = {
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
    return NextResponse.json({ ok: false, steps }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    steps,
    message: "R2 entierement operationnel (bucket, CORS, cycle put/get/delete) depuis la production.",
  });
}
