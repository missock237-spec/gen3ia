import { randomUUID } from "node:crypto";
import { FieldValue } from "@/lib/r2fs";
import { adminDb } from "@/lib/firebase/admin";

const COLLECTION = "adsSpendBudgets";
const DEFAULT_DAILY_LIMIT_MINOR = 2_000;
const MAX_SERVER_DAILY_LIMIT_MINOR = 100_000_000;

function dailyLimitFromEnv(): number {
  const configured = Number(process.env.GEN3IA_MAX_DAILY_AD_SPEND_EUR_MINOR ?? DEFAULT_DAILY_LIMIT_MINOR);
  if (!Number.isSafeInteger(configured) || configured <= 0 || configured > MAX_SERVER_DAILY_LIMIT_MINOR) return DEFAULT_DAILY_LIMIT_MINOR;
  return configured;
}

function bucketId(userId: string, provider: string, accountId: string, date: string): string {
  return [userId, provider, accountId, date].map((part) => encodeURIComponent(part)).join("__");
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface AdsSpendReservation {
  reference: string;
  date: string;
  amountMinor: number;
  dailyLimitMinor: number;
}

export async function reserveAdsDailySpend(params: {
  userId: string;
  provider: string;
  accountId: string;
  amountMinor: number;
  requestedDailyLimitMinor?: number;
}): Promise<AdsSpendReservation> {
  if (!Number.isSafeInteger(params.amountMinor) || params.amountMinor <= 0) throw new Error("Invalid Ads spend reservation.");
  const hardLimit = dailyLimitFromEnv();
  const requested = params.requestedDailyLimitMinor ?? hardLimit;
  if (!Number.isSafeInteger(requested) || requested <= 0 || requested > hardLimit) throw new Error("Requested Ads daily limit exceeds the server safety ceiling.");
  if (params.amountMinor > requested) throw new Error("Ads action exceeds the declared daily spend limit.");

  const date = todayUtc();
  const id = bucketId(params.userId, params.provider, params.accountId, date);
  const ref = adminDb.collection(COLLECTION).doc(id);
  const reservationRef = `${id}_${randomUUID()}`;

  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? (snap.data() as Record<string, unknown>) : {};
    const reservedMinor = Number(data.reservedMinor ?? 0);
    const committedMinor = Number(data.committedMinor ?? 0);
    const total = reservedMinor + committedMinor + params.amountMinor;
    if (!Number.isSafeInteger(reservedMinor) || !Number.isSafeInteger(committedMinor) || total > requested) throw new Error("Ads daily spend limit would be exceeded.");

    const payload = {
      userId: params.userId,
      provider: params.provider,
      accountId: params.accountId,
      date,
      dailyLimitMinor: requested,
      reservedMinor: reservedMinor + params.amountMinor,
      committedMinor,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (snap.exists) tx.update(ref, payload);
    else tx.create(ref, payload);
  });

  return { reference: reservationRef, date, amountMinor: params.amountMinor, dailyLimitMinor: requested };
}

export async function commitAdsDailySpend(params: AdsSpendReservation & { userId: string; provider: string; accountId: string }): Promise<void> {
  const ref = adminDb.collection(COLLECTION).doc(bucketId(params.userId, params.provider, params.accountId, params.date));
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Ads spend reservation no longer exists.");
    const data = snap.data() as Record<string, unknown>;
    const reservedMinor = Number(data.reservedMinor ?? 0);
    const committedMinor = Number(data.committedMinor ?? 0);
    if (reservedMinor < params.amountMinor) throw new Error("Ads spend reservation is inconsistent.");
    tx.update(ref, {
      reservedMinor: reservedMinor - params.amountMinor,
      committedMinor: committedMinor + params.amountMinor,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

export async function releaseAdsDailySpend(params: AdsSpendReservation & { userId: string; provider: string; accountId: string }): Promise<void> {
  const ref = adminDb.collection(COLLECTION).doc(bucketId(params.userId, params.provider, params.accountId, params.date));
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const data = snap.data() as Record<string, unknown>;
    const reservedMinor = Number(data.reservedMinor ?? 0);
    tx.update(ref, {
      reservedMinor: Math.max(0, reservedMinor - params.amountMinor),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

export function getAdsDailyLimitMinor(): number {
  return dailyLimitFromEnv();
}
