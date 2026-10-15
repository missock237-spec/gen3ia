/**
 * Plans de stockage permanent — Task 150.
 *
 * Chaque utilisateur dispose d'un quota de base de 1 Go à l'ouverture du
 * compte (plan « free »). Deux plans payants étendent le quota :
 *
 *   · storage-pro5  : 5 Go pour 2,5 €/mois  (250 unités mineures)
 *   · storage-pro10 : 10 Go pour 5 €/mois   (500 unités mineures)
 *
 * Le profil vit dans la collection `storagePlans/{userId}` et la facturation
 * passe par le portefeuille interne (lib/billing/wallet) avec une référence
 * DÉTERMINISTE par période (`storageplan_{planId}_{periodKey}`) : un double
 * appel de renouvellement ne peut jamais débiter deux fois le même mois.
 *
 * Renouvellement « lazy » : la échéance est vérifiée au moment où le profil
 * est lu (GET /api/storage/plan, chaque upload, chaque consultation) — aucun
 * cron externe n'est requis. Si le solde est insuffisant à l'échéance, le
 * compte retombe sur le plan free (1 Go) : les fichiers existants sont
 * CONSERVÉS (aucune destruction), seuls les nouveaux téléversements au-delà
 * du quota sont bloqués.
 */

import { FieldValue, Timestamp, type DocumentSnapshot } from "@/lib/r2fs";
import { adminDb } from "@/lib/firebase/admin";
import { getWallet, reserveFunds, settleReservation } from "@/lib/billing/wallet";

/** Quota du plan gratuit (unités SI — 1 Go = 1024³ octets). */
export const FREE_QUOTA_BYTES = 1024 ** 3;

export type StoragePlanId = "free" | "storage-pro5" | "storage-pro10";

export interface StoragePlanDefinition {
  id: StoragePlanId;
  label: string;
  quotaBytes: number;
  /** Prix mensuel en unités mineures (EUR × 100) — 0 pour le plan free. */
  priceMinor: number;
  priceLabel: string;
  highlight?: boolean;
}

/** Catalogue des plans — source unique de vérité affichée par l'UI. */
export const STORAGE_PLANS: readonly StoragePlanDefinition[] = [
  {
    id: "free",
    label: "Base",
    quotaBytes: FREE_QUOTA_BYTES,
    priceMinor: 0,
    priceLabel: "Inclus",
  },
  {
    id: "storage-pro5",
    label: "Stockage 5 Go",
    quotaBytes: 5 * 1024 ** 3,
    priceMinor: 250,
    priceLabel: "2,5 €/mois",
    highlight: true,
  },
  {
    id: "storage-pro10",
    label: "Stockage 10 Go",
    quotaBytes: 10 * 1024 ** 3,
    priceMinor: 500,
    priceLabel: "5 €/mois",
  },
] as const;

export function findStoragePlan(planId: string): StoragePlanDefinition | undefined {
  return STORAGE_PLANS.find((plan) => plan.id === planId);
}

/** Vue stable renvoyée par l'API — aucune valeur interne (références). */
export interface StorageProfile {
  plan: { id: StoragePlanId; label: string; quotaBytes: number; priceMinor: number; priceLabel: string };
  /** Prochaine échéance (ms epoch) — null pour le plan free. */
  renewalAt: number | null;
  /** Dernière erreur de renouvellement (solde insuffisant…), le cas échéant. */
  lastRenewalError: string | null;
  updatedAt: number;
}

const PLANS_COLLECTION = "storagePlans";
const PERIOD_DAYS = 30;
const PERIOD_MS = PERIOD_DAYS * 24 * 60 * 60 * 1000;

type PlanDoc = {
  userId: string;
  planId: StoragePlanId;
  renewalAt: Timestamp | Date | number | null;
  lastRenewalError: string | null;
  createdAt: Timestamp | Date | null;
  updatedAt: Timestamp | Date | null;
};

function toMillis(value: unknown): number {
  // Duck typing (même pattern que lib/billing/wallet.ts) : tolère les
  // Timestamps matériels comme les sentinelles de test.
  if (value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis();
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return 0;
}

function planDocRef(userId: string) {
  if (!userId?.trim()) throw new Error("Storage plan requires a userId.");
  return adminDb.collection(PLANS_COLLECTION).doc(userId);
}

function snapshotToProfile(snap: DocumentSnapshot): StorageProfile {
  const data = snap.data() as Partial<PlanDoc> | undefined;
  const plan = findStoragePlan(data?.planId ?? "free") ?? STORAGE_PLANS[0];
  const renewalAt = plan.priceMinor > 0 ? toMillis(data?.renewalAt) || null : null;
  return {
    plan: { id: plan.id, label: plan.label, quotaBytes: plan.quotaBytes, priceMinor: plan.priceMinor, priceLabel: plan.priceLabel },
    renewalAt,
    lastRenewalError: data?.lastRenewalError ?? null,
    updatedAt: toMillis(data?.updatedAt),
  };
}

/** Quota effectif d'un utilisateur, avec renouvellement lazy si échu. */
export async function getStorageProfile(userId: string): Promise<StorageProfile> {
  const snap = await planDocRef(userId).get();
  if (!snap.exists) return snapshotToProfile(snap);
  const profile = snapshotToProfile(snap);
  if (profile.plan.id === "free" || !profile.renewalAt) return profile;
  if (profile.renewalAt > Date.now()) return profile;

  // Échéance atteinte : tenter le renouvellement immédiat (lazy).
  const renewed = await renewStoragePlan(userId).catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : "Renouvellement impossible.",
  }));
  if (renewed.ok) {
    const refreshed = await planDocRef(userId).get();
    return snapshotToProfile(refreshed);
  }

  // Solde insuffisant (ou erreur de facturation) → retour au plan free.
  // Les fichiers existants sont conservés — seuls les uploads au-delà du
  // quota de base sont bloqués jusqu'à la prochaine mise à niveau.
  await planDocRef(userId).set(
    {
      planId: "free",
      renewalAt: null,
      lastRenewalError: renewed.error,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  const downgraded = await planDocRef(userId).get();
  return snapshotToProfile(downgraded);
}

/** Quota octets effectif (après renouvellement lazy éventuel). */
export async function getQuotaBytesForUser(userId: string): Promise<number> {
  const profile = await getStorageProfile(userId);
  return profile.plan.quotaBytes;
}

/** Clé de période stable (YYYY-MM) — référence de facturation idempotente. */
function currentPeriodKey(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function chargePlanMonth(userId: string, plan: StoragePlanDefinition, periodKey: string): Promise<void> {
  const reference = `storageplan_${plan.id}_${periodKey}`;
  await reserveFunds({ userId, amountMinor: plan.priceMinor, reference, metadata: { planId: plan.id, periodKey, kind: "storage_subscription" } });
  await settleReservation({ userId, reference, reservedMinor: plan.priceMinor, actualChargeMinor: plan.priceMinor, metadata: { planId: plan.id, periodKey, kind: "storage_subscription" } });
}

/** Tente de renouveler le plan courant pour la période en cours. */
async function renewStoragePlan(userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const snap = await planDocRef(userId).get();
  const data = snap.data() as Partial<PlanDoc> | undefined;
  const plan = findStoragePlan(data?.planId ?? "free");
  if (!plan || plan.priceMinor <= 0) return { ok: true };

  try {
    await chargePlanMonth(userId, plan, currentPeriodKey());
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Facturation du plan impossible." };
  }

  const base = toMillis(data?.renewalAt);
  const now = Date.now();
  // Prolongation ancrée sur l'ancienne échéance si elle est récente, sinon
  // sur l'instant présent (évite d'accumuler des mois de dette).
  const anchor = base > now - PERIOD_MS ? base : now;
  await planDocRef(userId).set(
    {
      planId: plan.id,
      renewalAt: Timestamp.fromMillis(anchor + PERIOD_MS),
      lastRenewalError: null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return { ok: true };
}

/**
 * Changement de plan : l'upgrade facture immédiatement le mois courant et
 * étend le quota à l'instant ; le downgrade (vers free ou un plan inférieur)
 * est gratuit et immédiat — les fichiers au-dessus du nouveau quota sont
 * conservés et l'utilisateur peut les supprimer depuis la page Stockage.
 */
export async function changeStoragePlan(userId: string, planId: StoragePlanId): Promise<StorageProfile> {
  const plan = findStoragePlan(planId);
  if (!plan) throw new Error("Plan de stockage inconnu.");
  if (plan.id === "storage-pro10" || plan.id === "storage-pro5") {
    // Upgrade (ou changement payant) : facturation du mois courant.
    await chargePlanMonth(userId, plan, currentPeriodKey());
  }

  await planDocRef(userId).set(
    {
      userId,
      planId: plan.id,
      renewalAt: plan.priceMinor > 0 ? Timestamp.fromMillis(Date.now() + PERIOD_MS) : null,
      lastRenewalError: null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  const snap = await planDocRef(userId).get();
  return snapshotToProfile(snap);
}

/** Aperçu d'achat pour l'UI : prix des plans + solde disponible. */
export async function describeStorageOffer(userId: string): Promise<{
  plans: ReadonlyArray<StoragePlanDefinition>;
  wallet: { currency: string; availableMinor: number };
}> {
  const wallet = await getWallet(userId);
  return { plans: STORAGE_PLANS, wallet: { currency: wallet.currency, availableMinor: wallet.availableMinor } };
}
