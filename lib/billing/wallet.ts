import { FieldValue, Timestamp } from "@/lib/r2fs";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { cooldownElapsed, fireLowBalanceAlert, isLowBalance, markLowBalanceNotified } from "./low-balance";

export const WALLET_CURRENCY = (process.env.GEN3IA_WALLET_CURRENCY ?? "XAF").toUpperCase();
const WALLET_COLLECTION = "userWallets";
const LEDGER_COLLECTION = "walletLedger";
// Must match the Chariow store currency (XAF). Amounts are stored in minor
// units (value x 100) across the billing stack, so 300000 = 3 000 FCFA.
const WELCOME_AMOUNT_MINOR = 300000;

export const WalletTransactionTypeSchema = z.enum([
  "topup",
  "reservation",
  "charge",
  "refund",
  "release",
  "adjustment",
  "welcome_grant",
]);
export type WalletTransactionType = z.infer<typeof WalletTransactionTypeSchema>;

export interface WalletSnapshot {
  userId: string;
  currency: string;
  balanceMinor: number;
  reservedMinor: number;
  availableMinor: number;
  updatedAt: number;
  welcomeGranted: boolean;
  welcomeAmountMinor: number;
}

function walletRef(userId: string) {
  if (!userId?.trim()) throw new Error("Wallet requires a userId.");
  return adminDb.collection(WALLET_COLLECTION).doc(userId);
}

function assertMinorAmount(amountMinor: number, allowZero = false) {
  if (!Number.isSafeInteger(amountMinor) || (allowZero ? amountMinor < 0 : amountMinor <= 0)) {
    throw new Error("Amount must be a valid integer in minor currency units.");
  }
}

function toMillis(value: unknown): number {
  if (value instanceof Timestamp) return value.toMillis();
  if (value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis();
  }
  return Date.now();
}

/**
 * Provision insuffisante / solde épuisé : même sémantique d'erreur qu'avant
 * (messages inchangés — l'UI et les tests s'y appuient) mais porteuse de la
 * décision d'alerte, pour que le catch puisse déclencher la notification de
 * solde critique AU moment où la mission s'arrête (audit facturation D).
 */
class InsufficientFundsError extends Error {
  constructor(
    message: string,
    readonly availableMinor: number,
    readonly shouldNotify: boolean,
  ) {
    super(message);
    this.name = "InsufficientFundsError";
  }
}

async function ensureWallet(userId: string): Promise<void> {
  const wallet = walletRef(userId);
  const welcomeLedger = adminDb.collection(LEDGER_COLLECTION).doc(`welcome_${userId}`);

  await adminDb.runTransaction(async (tx) => {
    const [walletSnap, welcomeSnap] = await Promise.all([tx.get(wallet), tx.get(welcomeLedger)]);
    if (walletSnap.exists) return;
    if (welcomeSnap.exists) throw new Error("Wallet initialization is inconsistent.");

    tx.create(wallet, {
      userId,
      currency: WALLET_CURRENCY,
      balanceMinor: WELCOME_AMOUNT_MINOR,
      reservedMinor: 0,
      welcomeGranted: true,
      welcomeAmountMinor: WELCOME_AMOUNT_MINOR,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(welcomeLedger, {
      userId,
      type: "welcome_grant",
      amountMinor: WELCOME_AMOUNT_MINOR,
      currency: WALLET_CURRENCY,
      provider: "gen3ia",
      reference: `welcome_${userId}`,
      metadata: { reason: "one-time welcome balance" },
      createdAt: FieldValue.serverTimestamp(),
    });
  });
}

export async function getWallet(userId: string): Promise<WalletSnapshot> {
  await ensureWallet(userId);
  const snap = await walletRef(userId).get();
  if (!snap.exists) throw new Error("Wallet could not be initialized.");
  const data = snap.data() ?? {};
  const balanceMinor = Number(data.balanceMinor ?? 0);
  const reservedMinor = Number(data.reservedMinor ?? 0);
  return {
    userId,
    currency: String(data.currency ?? WALLET_CURRENCY),
    balanceMinor,
    reservedMinor,
    availableMinor: Math.max(0, balanceMinor - reservedMinor),
    updatedAt: toMillis(data.updatedAt),
    welcomeGranted: Boolean(data.welcomeGranted),
    welcomeAmountMinor: Number(data.welcomeAmountMinor ?? WELCOME_AMOUNT_MINOR),
  };
}

export function assertWalletActive(wallet: WalletSnapshot): void {
  if (wallet.availableMinor <= 0) {
    throw new Error("AI agents are stopped because the wallet balance is 0. Recharge your Gen3ia wallet to resume all agents.");
  }
}

export async function assertUserWalletActive(userId: string): Promise<WalletSnapshot> {
  const wallet = await getWallet(userId);
  assertWalletActive(wallet);
  return wallet;
}

export async function applyTopup(params: {
  userId: string;
  amountMinor: number;
  currency: string;
  providerReference: string;
  metadata?: Record<string, string>;
}): Promise<WalletSnapshot> {
  assertMinorAmount(params.amountMinor);
  const currency = params.currency.toUpperCase();
  if (currency !== WALLET_CURRENCY) throw new Error(`Wallet currency mismatch: expected ${WALLET_CURRENCY}, received ${currency}.`);
  if (!params.providerReference.trim()) throw new Error("Provider reference is required.");

  const wallet = walletRef(params.userId);
  const ledger = adminDb.collection(LEDGER_COLLECTION).doc(`chariow_${params.providerReference}`);

  await adminDb.runTransaction(async (tx) => {
    const [walletSnap, ledgerSnap] = await Promise.all([tx.get(wallet), tx.get(ledger)]);
    if (ledgerSnap.exists) return;
    const current = walletSnap.exists ? Number(walletSnap.get("balanceMinor") ?? 0) : 0;
    tx.set(wallet, {
      userId: params.userId,
      currency: WALLET_CURRENCY,
      balanceMinor: current + params.amountMinor,
      reservedMinor: walletSnap.exists ? Number(walletSnap.get("reservedMinor") ?? 0) : 0,
      // Réarmement du cycle d'alerte : de l'argent entre réellement — la
      // prochaine descente sous le seuil re-notifiera immédiatement.
      lowBalanceNotifiedAtMs: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.create(ledger, {
      userId: params.userId,
      type: "topup",
      amountMinor: params.amountMinor,
      currency,
      provider: "chariow",
      providerReference: params.providerReference,
      metadata: params.metadata ?? {},
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  return getWallet(params.userId);
}

export async function reserveFunds(params: {
  userId: string;
  amountMinor: number;
  reference: string;
  metadata?: Record<string, string>;
}): Promise<WalletSnapshot> {
  assertMinorAmount(params.amountMinor);
  if (!params.reference.trim()) throw new Error("Reservation reference is required.");
  await ensureWallet(params.userId);
  const wallet = walletRef(params.userId);
  const ledger = adminDb.collection(LEDGER_COLLECTION).doc(`reservation_${params.reference}`);

  // Alerte solde critique (audit facturation D) : la DÉCISION (seuil +
  // cooldown) est prise dans la transaction — le drapeau
  // lowBalanceNotifiedAtMs est écrit dans le MÊME commit que la
  // réservation, donc deux exécutions concurrentes ne peuvent pas doubler
  // l'alerte. La DISPATCH part après le commit, fire-and-forget.
  try {
    const crossingMinor = await adminDb.runTransaction<number | null>(async (tx): Promise<number | null> => {
      const [walletSnap, ledgerSnap] = await Promise.all([tx.get(wallet), tx.get(ledger)]);
      if (ledgerSnap.exists) return null;
      const balance = Number(walletSnap.get("balanceMinor") ?? 0);
      const reserved = Number(walletSnap.get("reservedMinor") ?? 0);
      const available = balance - reserved;
      const notifyDue = cooldownElapsed(walletSnap.get("lowBalanceNotifiedAtMs"), Date.now());
      if (available < params.amountMinor) {
        throw new InsufficientFundsError(
          available <= 0
            ? "AI agents are stopped because the wallet balance is 0. Recharge your Gen3ia wallet to resume all agents."
            : "Insufficient wallet balance for this execution.",
          Math.max(0, available),
          isLowBalance(available) && notifyDue,
        );
      }
      const availableAfter = available - params.amountMinor;
      if (isLowBalance(availableAfter) && notifyDue) {
        tx.set(wallet, {
          userId: params.userId,
          currency: WALLET_CURRENCY,
          balanceMinor: balance,
          reservedMinor: reserved + params.amountMinor,
          lowBalanceNotifiedAtMs: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      } else {
        tx.set(wallet, {
          userId: params.userId,
          currency: WALLET_CURRENCY,
          balanceMinor: balance,
          reservedMinor: reserved + params.amountMinor,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      tx.create(ledger, {
        userId: params.userId,
        type: "reservation",
        amountMinor: params.amountMinor,
        currency: WALLET_CURRENCY,
        reference: params.reference,
        metadata: params.metadata ?? {},
        createdAt: FieldValue.serverTimestamp(),
      });
      return isLowBalance(availableAfter) && notifyDue ? availableAfter : null;
    });
    if (crossingMinor != null) {
      void fireLowBalanceAlert({ userId: params.userId, availableMinor: crossingMinor, currency: WALLET_CURRENCY }).catch(() => undefined);
    }
  } catch (error) {
    // Hard-stop : la mission vient d'échouer faute de fonds — c'est LE
    // moment d'alerter. Le drapeau ne peut pas être écrit dans la
    // transaction (elle a échoué) : écriture best-effort hors transaction.
    if (error instanceof InsufficientFundsError && error.shouldNotify) {
      void fireLowBalanceAlert({ userId: params.userId, availableMinor: error.availableMinor, currency: WALLET_CURRENCY }).catch(() => undefined);
      void markLowBalanceNotified(params.userId).catch(() => undefined);
    }
    throw error;
  }
  return getWallet(params.userId);
}

export async function settleReservation(params: {
  userId: string;
  reference: string;
  reservedMinor: number;
  actualChargeMinor: number;
  metadata?: Record<string, string>;
}): Promise<WalletSnapshot> {
  assertMinorAmount(params.reservedMinor);
  assertMinorAmount(params.actualChargeMinor, true);

  // A reservation is a hard spending ceiling. Never allow settlement to consume
  // funds that were reserved by another concurrent execution.
  if (params.actualChargeMinor > params.reservedMinor) {
    throw new Error("Actual execution cost exceeds the reserved wallet amount; settlement is blocked to protect concurrent reservations.");
  }

  const wallet = walletRef(params.userId);
  const settlement = adminDb.collection(LEDGER_COLLECTION).doc(`settlement_${params.reference}`);

  const crossingMinor = await adminDb.runTransaction<number | null>(async (tx): Promise<number | null> => {
    const [walletSnap, settlementSnap] = await Promise.all([tx.get(wallet), tx.get(settlement)]);
    if (settlementSnap.exists) return null;
    if (!walletSnap.exists) throw new Error("Wallet not found.");
    const balance = Number(walletSnap.get("balanceMinor") ?? 0);
    const reserved = Number(walletSnap.get("reservedMinor") ?? 0);
    if (reserved < params.reservedMinor) throw new Error("Wallet reservation is inconsistent.");
    if (balance < params.actualChargeMinor) throw new Error("Wallet balance cannot cover actual execution cost.");
    const availableAfter = balance - params.actualChargeMinor - (reserved - params.reservedMinor);
    const notifyDue = cooldownElapsed(walletSnap.get("lowBalanceNotifiedAtMs"), Date.now());
    const alert = isLowBalance(availableAfter) && notifyDue;
    tx.update(wallet, {
      balanceMinor: balance - params.actualChargeMinor,
      reservedMinor: reserved - params.reservedMinor,
      ...(alert ? { lowBalanceNotifiedAtMs: FieldValue.serverTimestamp() } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(settlement, {
      userId: params.userId,
      type: "charge",
      amountMinor: params.actualChargeMinor,
      reservedMinor: params.reservedMinor,
      currency: WALLET_CURRENCY,
      reference: params.reference,
      metadata: params.metadata ?? {},
      createdAt: FieldValue.serverTimestamp(),
    });
    return alert ? availableAfter : null;
  });
  if (crossingMinor != null) {
    void fireLowBalanceAlert({ userId: params.userId, availableMinor: crossingMinor, currency: WALLET_CURRENCY }).catch(() => undefined);
  }
  return getWallet(params.userId);
}

export async function releaseReservation(params: {
  userId: string;
  reference: string;
  reservedMinor: number;
}): Promise<WalletSnapshot> {
  assertMinorAmount(params.reservedMinor);
  const wallet = walletRef(params.userId);
  const release = adminDb.collection(LEDGER_COLLECTION).doc(`release_${params.reference}`);
  await adminDb.runTransaction(async (tx) => {
    const [walletSnap, releaseSnap] = await Promise.all([tx.get(wallet), tx.get(release)]);
    if (releaseSnap.exists) return;
    if (!walletSnap.exists) throw new Error("Wallet not found.");
    const reserved = Number(walletSnap.get("reservedMinor") ?? 0);
    if (reserved < params.reservedMinor) throw new Error("Wallet reservation is inconsistent.");
    tx.update(wallet, { reservedMinor: reserved - params.reservedMinor, updatedAt: FieldValue.serverTimestamp() });
    tx.create(release, {
      userId: params.userId,
      type: "release",
      amountMinor: params.reservedMinor,
      currency: WALLET_CURRENCY,
      reference: params.reference,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  return getWallet(params.userId);
}
