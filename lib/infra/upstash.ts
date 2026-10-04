import "server-only";

import { Redis } from "@upstash/redis";

let redis: Redis | null = null;

export function getUpstashRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  if (!redis) redis = new Redis({ url, token });
  return redis;
}

export async function setJobProgress(
  jobId: string,
  progress: number,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const client = getUpstashRedis();
  if (!client) return;
  await client.set(
    `gen3ia:job:${jobId}`,
    { progress: Math.max(0, Math.min(100, progress)), status, ...extra, updatedAt: Date.now() },
    { ex: 60 * 60 * 24 },
  );
}

export async function getJobProgress<T = Record<string, unknown>>(jobId: string): Promise<T | null> {
  const client = getUpstashRedis();
  if (!client) return null;
  return (await client.get<T>(`gen3ia:job:${jobId}`)) ?? null;
}

export async function acquireLock(key: string, ttlSeconds = 60): Promise<boolean> {
  const client = getUpstashRedis();
  if (!client) return true;
  const result = await client.set(`gen3ia:lock:${key}`, "1", { nx: true, ex: ttlSeconds });
  return result === "OK";
}

export async function releaseLock(key: string): Promise<void> {
  const client = getUpstashRedis();
  if (!client) return;
  await client.del(`gen3ia:lock:${key}`);
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const client = getUpstashRedis();
  if (!client) return null;
  return (await client.get<T>(`gen3ia:cache:${key}`)) ?? null;
}

export async function cacheSet<T>(key: string, value: T, ttlSeconds = 300): Promise<void> {
  const client = getUpstashRedis();
  if (!client) return;
  await client.set(`gen3ia:cache:${key}`, value, { ex: ttlSeconds });
}
