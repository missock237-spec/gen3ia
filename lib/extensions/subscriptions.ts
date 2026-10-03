import { FieldValue } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";
import { reserveFunds, settleReservation, WALLET_CURRENCY } from "@/lib/billing/wallet";
import { createNotification } from "@/lib/notifications/repository";
import type { PricingInfo } from "./pricing";
import { subscriptionExpiry } from "./pricing";
import {
  addDeveloperRevenue,
  createExtensionPurchase,
  createLicense,
  getExtension,
  getExtensionPurchase,
  listSubscriptionEntitlements,
  markPurchasePaid,
  type EntitlementDoc,
} from "./repository";

/**
 * Renouvellement automatique des abonnements d'extensions.
 *
 * Un abonnement (source « subscription », autoRenew actif) est débité du
 * wallet du client dans une FENÊTRE D'AVANCE (RENEWAL_LEAD_MS) avant son
 * terme : le cron tournant une fois par jour (plan Hobby), la fenêtre
 * garantit zéro interruption de service. Au terme :
 *  - wallet financé  : débit idempotent PAR PÉRIODE (ledger wallet, référence
 *    dérivée du terme courant), achat d'audit à ID déterministe, part
 *    développeur enregistrée, abonnement prolongé d'un intervalle complet,
 *    nouvelle licence, notification ;
 *  - wallet insuffisant : l'abonnement entre en grâce (7 jours au-delà du
 *    terme, l'usage est déjà bloqué par l'expiration) puis passe « expired »
 *    définitivement si rien ne rentre ; notifications avec anti-spam.
 *
 * Idempotence à TOUTES les étapes : le débit wallet et l'achat d'audit sont
 * dérivés du couple (entitlement, terme courant) — un crash entre deux
 * étapes converge au passage suivant sans double débit ni double comptage
 * de revenu (achat déjà payé → on ne fait que finir la prolongation).
 */

/** Fenêtre d'avance : le cron quotidien doit rattraper tout terme < 36 h. */
export const RENEWAL_LEAD_MS = 36 * 60 * 60 * 1000;
/** Grâce impayée au-delà du terme avant expiration définitive. */
export const SUBSCRIPTION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Notifications : pas moins de 48 h entre deux alertes de même cycle. */
export const RENEWAL_ALERT_SPACING_MS = 48 * 60 * 60 * 1000;
/** Budget par passage du cron ( throughput soutenu 25/jour, largement au-dessus de l'échelle actuelle). */
export const RENEWALS_PER_RUN = 25;

/** ID déterministe de l'achat d'audit pour le renouvellement d'une période. */
export function renewalPurchaseId(entitlementId: string, periodExpiryMs: number): string {
  return `renewal-${entitlementId}-${periodExpiryMs}`;
}

/** Référence wallet idempotente du débit d'une période. */
export function renewalWalletReference(entitlementId: string, periodExpiryMs: number): string {
  return `ext-renewal-${entitlementId}-${periodExpiryMs}`;
}

/** Un abonnement est dû quand son terme tombe dans la fenêtre d'avance. */
export function isRenewalDue(
  entitlement: Pick<EntitlementDoc, "status" | "autoRenew" | "expiresAt">,
  nowMs: number,
  leadMs = RENEWAL_LEAD_MS,
): boolean {
  if (entitlement.status !== "active") return false;
  if (entitlement.autoRenew === false) return false;
  if (typeof entitlement.expiresAt !== "number") return false;
  return entitlement.expiresAt <= nowMs + leadMs;
}

/** État de grâce selon le retard de paiement (impayé > terme). */
export function overdueState(overdueMs: number, graceMs = SUBSCRIPTION_GRACE_MS): "grace" | "expired" {
  return overdueMs >= graceMs ? "expired" : "grace";
}

/** Alerte autorisée ? (jamais plus d'une par cycle de RENEWAL_ALERT_SPACING_MS, expiration finale toujours annoncée). */
export function shouldSendRenewalAlert(
  lastAlertAt: number | null | undefined,
  nowMs: number,
  spacingMs = RENEWAL_ALERT_SPACING_MS,
): boolean {
  if (typeof lastAlertAt !== "number" || lastAlertAt <= 0) return true;
  return nowMs - lastAlertAt >= spacingMs;
}

export interface RenewalOutcome {
  entitlementId: string;
  extensionId: string;
  userId: string;
  status: "charged" | "grace" | "expired" | "skipped";
  reason?: string;
}

interface DueEntitlement extends EntitlementDoc {
  id: string;
}

function asDueEntitlement(doc: EntitlementDoc): DueEntitlement | null {
  if (!doc?.id || !doc.userId || !doc.extensionId) return null;
  return doc as DueEntitlement;
}

/**
 * Prolonge l'abonnement d'un intervalle complet depuis le terme courant
 * (ou depuis maintenant si déjà dépassé) — même règle que les achats
 * initiaux, pour un historique de terme sans trou ni chevauchement.
 */
function nextExpiryFor(pricing: PricingInfo, currentExpiryMs: number, nowMs: number): number | null {
  if (!pricing.interval) return null;
  return subscriptionExpiry(pricing.interval, Math.max(nowMs, currentExpiryMs));
}

async function notifySafe(userId: string, title: string, body: string): Promise<void> {
  await createNotification({ userId, type: "info", title, body }).catch(() => undefined);
}

async function recordDeveloperRevenueSafe(params: {
  developerId: string;
  extensionId: string;
  purchaseId: string;
  amountMinor: number;
  currency: string;
}): Promise<void> {
  try {
    await addDeveloperRevenue({
      developerId: params.developerId,
      extensionId: params.extensionId,
      purchaseId: params.purchaseId,
      grossAmountMinor: params.amountMinor,
      currency: params.currency,
    });
  } catch (error) {
    console.error("[extensions] revenu développeur (renouvellement) non enregistré:", error instanceof Error ? error.message : error);
  }
}

/** Prolongation + nettoyage de l'état d'échec après un débit réussi. */
async function extendEntitlementAfterCharge(params: {
  entitlement: DueEntitlement;
  expiresAt: number;
}): Promise<void> {
  await adminDb
    .collection("extensionEntitlements")
    .doc(params.entitlement.id)
    .update({
      expiresAt: params.expiresAt,
      status: "active",
      renewalState: "ok",
      renewalFailedAt: null,
      renewalNotice: null,
      lastRenewalAlertAt: null,
      renewalAlertCount: 0,
      updatedAt: FieldValue.serverTimestamp(),
    });
}

/** Marque l'échec de renouvellement (grâce) puis l'expiration définitive. */
async function markRenewalFailure(params: {
  entitlement: DueEntitlement;
  state: "grace" | "expired";
  nowMs: number;
  alert: boolean;
}): Promise<void> {
  const entitlementRef = adminDb.collection("extensionEntitlements").doc(params.entitlement.id);
  const previousCount = Number(params.entitlement.renewalAlertCount ?? 0);
  if (params.state === "expired") {
    await entitlementRef
      .update({
        status: "expired",
        autoRenew: false,
        renewalState: "failed",
        renewalFailedAt: params.nowMs,
        renewalNotice: "Abonnement expiré : renouvellement impossible (solde wallet insuffisant).",
        ...(params.alert ? { lastRenewalAlertAt: params.nowMs, renewalAlertCount: previousCount + 1 } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      })
      .catch(() => undefined);
    return;
  }
  await entitlementRef
    .update({
      renewalState: "failed",
      renewalFailedAt: params.nowMs,
      renewalNotice: "Renouvellement en attente : solde wallet insuffisant. Réapprovisionnez votre wallet pour conserver votre abonnement.",
      ...(params.alert ? { lastRenewalAlertAt: params.nowMs, renewalAlertCount: previousCount + 1 } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    })
    .catch(() => undefined);
}

async function renewOne(entitlement: DueEntitlement, nowMs: number): Promise<RenewalOutcome> {
  const base: RenewalOutcome = {
    entitlementId: entitlement.id,
    extensionId: entitlement.extensionId,
    userId: entitlement.userId,
    status: "skipped",
  };

  const extension = await getExtension(entitlement.extensionId);
  if (!extension || extension.deletedAt) {
    return { ...base, reason: "extension introuvable ou supprimée" };
  }
  const pricing = extension.pricing as PricingInfo;
  if (pricing.model !== "subscription" || !pricing.interval) {
    return { ...base, reason: "l'extension n'est plus en abonnement" };
  }
  const amountMinor = pricing.amountMinor ?? 0;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return { ...base, reason: "prix d'abonnement invalide" };
  }

  const currentExpiry = entitlement.expiresAt as number;
  const purchaseId = renewalPurchaseId(entitlement.id, currentExpiry);
  const walletReference = renewalWalletReference(entitlement.id, currentExpiry);

  // Convergence : un passage précédent a peut-être déjà débité et/ou payé.
  const existingPurchase = await getExtensionPurchase(purchaseId).catch(() => null);

  if (!existingPurchase) {
    try {
      await reserveFunds({
        userId: entitlement.userId,
        amountMinor,
        reference: walletReference,
        metadata: { kind: "extension_subscription_renewal", extensionId: extension.id, entitlementId: entitlement.id },
      });
      await settleReservation({
        userId: entitlement.userId,
        reference: walletReference,
        reservedMinor: amountMinor,
        actualChargeMinor: amountMinor,
        metadata: { kind: "extension_subscription_renewal", extensionId: extension.id },
      });
    } catch (error) {
      // Solde insuffisant (ou incident wallet) : grâce puis expiration.
      const overdue = nowMs - currentExpiry;
      const state = overdueState(overdue);
      // Expiration finale TOUJOURS annoncée ; alertes de grâce espacées.
      const alert = state === "expired" ? true : shouldSendRenewalAlert(entitlement.lastRenewalAlertAt, nowMs);
      await markRenewalFailure({ entitlement, state, nowMs, alert });
      if (alert) {
        await notifySafe(
          entitlement.userId,
          state === "expired" ? "Abonnement expiré" : "Renouvellement en attente",
          state === "expired"
            ? `Votre abonnement « ${extension.name} » a expiré faute de solde suffisant. Réabonnez-vous depuis la Marketplace.`
            : `Le renouvellement de « ${extension.name} » a échoué (solde insuffisant). Réapprovisionnez votre wallet sous ${Math.ceil((SUBSCRIPTION_GRACE_MS - overdue) / (24 * 60 * 60 * 1000))} jour(s) pour le conserver.`,
        );
      }
      return {
        ...base,
        status: state === "expired" ? "expired" : "grace",
        reason: error instanceof Error ? error.message : "wallet_error",
      };
    }
  }

  // Achat d'audit à ID déterministe : créé une seule fois, payé au même
  // identifiant — un re-passage le retrouve et ne re-compte pas le revenu.
  if (!existingPurchase) {
    try {
      await createExtensionPurchase({
        id: purchaseId,
        userId: entitlement.userId,
        extensionId: extension.id,
        provider: "wallet",
        amountMinor,
        currency: pricing.currency ?? WALLET_CURRENCY,
        kind: "subscription",
      });
    } catch (error) {
      // Déjà créé par un passage concurrent : acceptable (id déterministe).
      console.warn("[extensions] achat de renouvellement déjà présent:", purchaseId, error instanceof Error ? error.message : error);
    }
    await markPurchasePaid(purchaseId, `wallet:${walletReference}`);
    await recordDeveloperRevenueSafe({
      developerId: extension.developerId,
      extensionId: extension.id,
      purchaseId,
      amountMinor,
      currency: pricing.currency ?? WALLET_CURRENCY,
    });
  }

  const expiresAt = nextExpiryFor(pricing, currentExpiry, nowMs);
  if (expiresAt == null) {
    return { ...base, reason: "intervalle d'abonnement manquant" };
  }
  await extendEntitlementAfterCharge({ entitlement, expiresAt });
  await createLicense({
    purchaseId,
    userId: entitlement.userId,
    extensionId: extension.id,
    // Clé déterministe unique par (entitlement, période) — re-passage sans surprise.
    licenseKey: `g3lic_${currentExpiry.toString(36)}${entitlement.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40)}`,
    expiresAt,
  }).catch(() => undefined);
  await notifySafe(
    entitlement.userId,
    "Abonnement renouvelé",
    `Votre abonnement « ${extension.name} » a été reconduit pour un nouveau ${pricing.interval === "year" ? "an" : "mois"}.`,
  );
  return { ...base, status: "charged" };
}

export interface RenewalsReport {
  scanned: number;
  processed: number;
  charged: number;
  grace: number;
  expired: number;
  skipped: number;
  outcomes: RenewalOutcome[];
}

/**
 * Passage de renouvellement — appelé par le cron quotidien
 * (/api/cron/agent-schedules). Idempotent par période : voir en-tête.
 */
export async function renewDueExtensionSubscriptions(now = new Date(), limit = RENEWALS_PER_RUN): Promise<RenewalsReport> {
  const nowMs = now.getTime();
  const all = await listSubscriptionEntitlements();
  const due = all.filter((doc) => isRenewalDue(doc, nowMs) && asDueEntitlement(doc) !== null).slice(0, limit) as DueEntitlement[];

  const report: RenewalsReport = {
    scanned: all.length,
    processed: 0,
    charged: 0,
    grace: 0,
    expired: 0,
    skipped: 0,
    outcomes: [],
  };

  for (const entitlement of due) {
    report.processed += 1;
    const outcome = await renewOne(entitlement, nowMs).catch((error): RenewalOutcome => {
      console.error("[extensions] renouvellement", entitlement.id, error instanceof Error ? error.message : error);
      return {
        entitlementId: entitlement.id,
        extensionId: entitlement.extensionId,
        userId: entitlement.userId,
        status: "skipped",
        reason: error instanceof Error ? error.message : "erreur",
      };
    });
    if (outcome.status === "charged") report.charged += 1;
    else if (outcome.status === "grace") report.grace += 1;
    else if (outcome.status === "expired") report.expired += 1;
    else report.skipped += 1;
    report.outcomes.push(outcome);
  }

  return report;
}
