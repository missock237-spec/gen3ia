import { FieldValue } from "@/lib/r2fs";

import { adminDb } from "@/lib/firebase/admin";
import { WALLET_CURRENCY } from "@/lib/billing/wallet";
import { createNotification } from "@/lib/notifications/repository";
import {
  developerPayoutStatsRef,
  getDeveloperPayoutStats,
  getPayoutDoc,
  listPayoutsByDeveloper,
  listPayoutsByStatus,
  payoutRef,
  sumDeveloperNetEarnings,
  type DeveloperPayoutStatsDoc,
  type PayoutDoc,
} from "./repository";

/**
 * Retraits (payouts) des revenus développeurs.
 *
 * Modèle de cohérence : le GAGNÉ (sum de developerRevenue, append-only) est
 * lu par agrégation Firestore ; l'ENGAGÉ (payouts demandés non rejetés) est
 * la seule écriture mutable, portée par un document `developerPayoutStats`
 * muté en transaction. Deux demandes concurrentes se sérialisent sur ce
 * document — l'engagement est atomique, un développeur ne peut jamais
 * demander plus que son disponible. La valeur agrégée peut être légèrement
 * périmée, mais les entrées de revenus ne pouvant QUE croître (append-only),
 * une lecture périmée sous-estime le disponible : conservateur par
 * construction, jamais de sur-paiement.
 *
 * Cycle de vie : requested → approved → paid ; requested/approved →
 * rejected (l'engagement est libéré dans la même transaction que le
 * rejet). Chaque transition notifie le développeur.
 */

/** Montant minimal de retrait (en unités mineures) — 5 000 XAF par défaut. */
export const MIN_PAYOUT_AMOUNT_MINOR = Number(process.env.EXTENSION_MIN_PAYOUT_MINOR ?? 500_000);

export const PAYOUT_METHODS = ["mtn_momo", "orange_money", "bank_transfer"] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export const PAYOUT_METHOD_LABELS: Record<PayoutMethod, string> = {
  mtn_momo: "MTN Mobile Money",
  orange_money: "Orange Money",
  bank_transfer: "Virement bancaire",
};

export interface PayoutMethodDetail {
  accountName: string;
  accountNumber: string;
  bankName?: string | null;
  country: string;
}

export class PayoutError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "PayoutError";
  }
}

/** Nettoie une chaîne saisie pour un mandat de paiement (bornes strictes). */
export function sanitizePayoutField(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!text) throw new PayoutError("Champs de moyen de paiement requis.");
  if (text.length > maxLength) throw new PayoutError(`Champ trop long (max ${maxLength} caractères).`);
  // Imprimables sans caractères de contrôle (mandat lisible par un opérateur).
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new PayoutError("Caractères de contrôle interdits.");
  return text;
}

export function sanitizePayoutMethodDetail(input: unknown): PayoutMethodDetail {
  if (!input || typeof input !== "object") throw new PayoutError("Détails du moyen de paiement requis.");
  const raw = input as Record<string, unknown>;
  const accountName = sanitizePayoutField(raw.accountName, 120);
  const accountNumber = sanitizePayoutField(raw.accountNumber, 60);
  // Code pays : exactement 2 lettres (ISO 3166-1 alpha-2) — JAMAIS tronqué
  // silencieusement : un mandat vers le mauvais pays est une perte sèche.
  const country = typeof raw.country === "string" ? raw.country.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(country)) throw new PayoutError("Code pays invalide (ISO 3166-1 alpha-2).");
  const bankName = raw.bankName == null || raw.bankName === "" ? null : sanitizePayoutField(raw.bankName, 120);
  return { accountName, accountNumber, bankName, country };
}

/** Montant demandé : entier strictement positif, au-dessus du minimum. */
export function validatePayoutAmount(amountMinor: unknown, minMinor = MIN_PAYOUT_AMOUNT_MINOR): number {
  const value = Number(amountMinor);
  if (!Number.isSafeInteger(value) || value <= 0) throw new PayoutError("Le montant doit être un entier en unités mineures.");
  if (value < minMinor) {
    throw new PayoutError(`Le retrait minimum est de ${(minMinor / 100).toLocaleString("fr-FR")} ${WALLET_CURRENCY}.`);
  }
  return value;
}

export interface PayoutBalance {
  earnedMinor: number;
  committedMinor: number;
  availableMinor: number;
  currency: string;
  minPayoutMinor: number;
  payoutCount: number;
}

/** Solde disponible = gagné (agrégat) − engagé (stats transactionnelles). */
export async function getDeveloperPayoutBalance(developerId: string, currency = WALLET_CURRENCY): Promise<PayoutBalance> {
  const [earnedMinor, stats] = await Promise.all([
    sumDeveloperNetEarnings(developerId, currency),
    getDeveloperPayoutStats(developerId),
  ]);
  const committedMinor = Math.max(0, Number(stats?.committedMinor ?? 0));
  return {
    earnedMinor,
    committedMinor,
    availableMinor: earnedMinor - committedMinor,
    currency,
    minPayoutMinor: MIN_PAYOUT_AMOUNT_MINOR,
    payoutCount: Number(stats?.payoutCount ?? 0),
  };
}

/**
 * Demande de retrait : validation → transaction (engagement + création du
 * mandat) → notification. L'engagement et le mandat sont committés dans la
 * MÊME transaction Firestore : jamais d'engagement fantôme sans mandat, ni
 * de mandat sans engagement.
 */
export async function requestDeveloperPayout(params: {
  developerId: string;
  amountMinor: unknown;
  method: unknown;
  methodDetail: unknown;
  developerNote?: unknown;
}): Promise<PayoutDoc> {
  const currency = WALLET_CURRENCY;
  const amountMinor = validatePayoutAmount(params.amountMinor);
  const method = String(params.method ?? "") as PayoutMethod;
  if (!PAYOUT_METHODS.includes(method)) {
    throw new PayoutError(`Moyen de paiement invalide (choix : ${PAYOUT_METHODS.join(", ")}).`);
  }
  const methodDetail = sanitizePayoutMethodDetail(params.methodDetail);
  const developerNote =
    typeof params.developerNote === "string" && params.developerNote.trim()
      ? params.developerNote.trim().slice(0, 500)
      : null;

  const balance = await getDeveloperPayoutBalance(params.developerId, currency);
  if (amountMinor > balance.availableMinor) {
    throw new PayoutError(
      `Solde insuffisant : disponible ${(balance.availableMinor / 100).toLocaleString("fr-FR")} ${currency}.`,
    );
  }

  const statsRef = developerPayoutStatsRef(params.developerId);
  const payoutRefForCreate = payoutRef(payoutDocId());
  const timestamp = Date.now();

  const payout = await adminDb.runTransaction(async (tx) => {
    const statsSnap = await tx.get(statsRef);
    const statsData = statsSnap.exists ? (statsSnap.data() as DeveloperPayoutStatsDoc) : null;
    const committedMinor = Math.max(0, Number(statsData?.committedMinor ?? 0));
    const availableMinor = balance.earnedMinor - committedMinor;
    if (amountMinor > availableMinor) {
      throw new PayoutError(
        `Solde insuffisant : disponible ${(Math.max(0, availableMinor) / 100).toLocaleString("fr-FR")} ${currency}.`,
      );
    }
    tx.set(
      statsRef,
      {
        developerId: params.developerId,
        payoutCount: Number(statsData?.payoutCount ?? 0) + 1,
        committedMinor: committedMinor + amountMinor,
        currency,
        lastPayoutAt: timestamp,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    const doc: PayoutDoc = {
      id: payoutRefForCreate.id,
      developerId: params.developerId,
      amountMinor,
      currency,
      method,
      methodDetail,
      status: "requested",
      developerNote,
      adminNote: null,
      providerRef: null,
      requestedAt: timestamp,
      decidedAt: null,
      paidAt: null,
      updatedAt: timestamp,
    };
    tx.create(payoutRefForCreate, doc);
    return doc;
  });

  await createNotification({
    userId: params.developerId,
    type: "info",
    title: "Demande de retrait enregistrée",
    body: `Votre demande de ${(amountMinor / 100).toLocaleString("fr-FR")} ${currency} (${PAYOUT_METHOD_LABELS[method]}) est en file de traitement.`,
  }).catch(() => undefined);

  return payout;
}

function payoutDocId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `payout_${Date.now().toString(36)}${random}`;
}

/** Transitions autorisées du cycle de vie — pur, testé unitairement. */
export function payoutDecisionTransition(
  current: PayoutDoc["status"],
  decision: "approve" | "reject" | "mark_paid",
): PayoutDoc["status"] | null {
  if (decision === "approve") return current === "requested" ? "approved" : null;
  if (decision === "reject") return current === "requested" || current === "approved" ? "rejected" : null;
  return current === "approved" ? "paid" : null;
}

/**
 * Décision admin sur un mandat. Le rejet LIBÈRE l'engagement dans la même
 * transaction que le changement de statut ; le paiement exige une référence
 * fournisseur traçable (ID transaction Mobile Money / virement).
 */
export async function decideDeveloperPayout(params: {
  payoutId: string;
  decision: "approve" | "reject" | "mark_paid";
  adminNote?: unknown;
  providerRef?: unknown;
}): Promise<PayoutDoc> {
  const payout = await getPayoutDoc(params.payoutId);
  if (!payout) throw new PayoutError("Mandat de retrait introuvable.", 404);
  const nextStatus = payoutDecisionTransition(payout.status, params.decision);
  if (!nextStatus) {
    throw new PayoutError(`Transition impossible : un mandat « ${payout.status} » ne peut pas devenir « ${params.decision} ».`);
  }
  const adminNote =
    typeof params.adminNote === "string" && params.adminNote.trim() ? params.adminNote.trim().slice(0, 500) : null;

  if (params.decision === "mark_paid") {
    const providerRef = typeof params.providerRef === "string" ? params.providerRef.trim() : "";
    if (!providerRef) throw new PayoutError("Une référence fournisseur est requise pour marquer un retrait payé.");
    if (providerRef.length > 200) throw new PayoutError("Référence fournisseur trop longue.");
    const timestamp = Date.now();
    await payoutRef(payout.id).update({
      status: "paid",
      adminNote,
      providerRef,
      decidedAt: timestamp,
      paidAt: timestamp,
      updatedAt: timestamp,
    });
  } else if (params.decision === "reject") {
    const timestamp = Date.now();
    await adminDb.runTransaction(async (tx) => {
      const statsRef = developerPayoutStatsRef(payout.developerId);
      const statsSnap = await tx.get(statsRef);
      const committedMinor = Math.max(0, Number(statsSnap.exists ? (statsSnap.data() as DeveloperPayoutStatsDoc).committedMinor : 0));
      tx.set(
        statsRef,
        {
          developerId: payout.developerId,
          committedMinor: committedMinor - payout.amountMinor,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      tx.update(payoutRef(payout.id), {
        status: "rejected",
        adminNote,
        decidedAt: timestamp,
        updatedAt: timestamp,
      });
    });
  } else {
    const timestamp = Date.now();
    await payoutRef(payout.id).update({
      status: "approved",
      adminNote,
      decidedAt: timestamp,
      updatedAt: timestamp,
    });
  }

  const titles: Record<typeof params.decision, string> = {
    approve: "Retrait approuvé",
    reject: "Retrait rejeté",
    mark_paid: "Retrait payé",
  };
  const bodies: Record<typeof params.decision, string> = {
    approve: `Votre demande de retrait de ${(payout.amountMinor / 100).toLocaleString("fr-FR")} ${payout.currency} est approuvée — paiement en cours.`,
    reject: `Votre demande de retrait de ${(payout.amountMinor / 100).toLocaleString("fr-FR")} ${payout.currency} a été rejetée${adminNote ? ` : ${adminNote}` : "."} Le montant est de retour dans votre disponible.`,
    mark_paid: `Votre retrait de ${(payout.amountMinor / 100).toLocaleString("fr-FR")} ${payout.currency} a été payé (réf. ${String(params.providerRef ?? "").slice(0, 40)}).`,
  };
  await createNotification({ userId: payout.developerId, type: "info", title: titles[params.decision], body: bodies[params.decision] }).catch(
    () => undefined,
  );

  const updated = await getPayoutDoc(payout.id);
  return updated as PayoutDoc;
}

export async function listDeveloperPayouts(developerId: string, limit = 50): Promise<PayoutDoc[]> {
  return listPayoutsByDeveloper(developerId, limit);
}

export async function listAdminPayoutQueue(limit = 100): Promise<PayoutDoc[]> {
  return listPayoutsByStatus(["requested", "approved"], limit);
}
