import { getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { Timestamp } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";
import { settleChariowExtensionPurchase } from "@/lib/extensions/entitlements";
import { applyTopup, WALLET_CURRENCY, type WalletSnapshot } from "./wallet";

/**
 * Livraisons du webhook Chariow Pulse (Task 104-b — rejeu résilient).
 *
 * Avant cette tâche, le webhook refusait TOUT passage ultérieur d'un même
 * deliveryId (document créé au premier passage, jamais réutilisé) : une
 * livraison échouée puis re-délivrée par Chariow n'était jamais retraitée
 * (paiement non crédité), et une fonction serveur tuée pendant le traitement
 * laissait un document « processing » coincé pour toujours. Désormais :
 *
 * - `claimChariowDelivery` est la porte d'entrée TRANSACTIONNELLE : premier
 *   passage → create ; statut processed/ignored → doublon ; statut failed →
 *   reprise ; bail « processing » expiré (CHARIOW_LEASE_MS) → reprise ; bail
 *   frais → in-flight (un autre worker est dessus).
 * - `processChariowSale` porte la logique métier (déplacée telle quelle du
 *   route.ts) et dédoublonne par identifiant de VENTE (saleId) : deux
 *   deliveries différents portant la même vente ne répondent plus
 *   « credited:true » pour un simple no-op.
 * - La reprise reste PROTÉGÉE au niveau financier par l'idempotence du wallet
 *   (lib/billing/wallet.ts — LECTURE SEULE : le topup écrit le document de
 *   journal `chariow_${saleId}` et ne crédite jamais deux fois la même vente).
 *   Cette barrière reste la dernière ligne de défense contre un double
 *   crédit en cas de course entre deux workers.
 */

const DELIVERY_COLLECTION = "chariowPulseDeliveries";

/** Bail de processing : au-delà, la livraison est considérée morte (worker tué). */
export const CHARIOW_LEASE_MS = 10 * 60 * 1000;

/** Plafond du snapshot de charge utile stocké dans le document de livraison (~100 Ko). */
const MAX_PAYLOAD_SNAPSHOT_CHARS = 100_000;

/** Statuts terminaux : un nouveau passage avec le même deliveryId est un doublon pur. */
const TERMINAL_STATUSES = new Set(["processed", "ignored"]);

/** Statuts de vente Chariow créditable (contrat existant du webhook). */
const CREDITABLE_STATUSES = new Set(["completed", "settled"]);

export interface ChariowDeliveryClaim {
  action: "process" | "duplicate-processed" | "in-flight";
}

// Charge utile du webhook Chariow (successful.sale) — lue défensivement
// (String(...), Number.isFinite, != null) aux points d'usage.
export type ChariowWebhookPayload = {
  event?: string | null;
  customer?: { email?: unknown } | null;
  product?: { id?: unknown } | null;
  sale?: {
    id?: unknown;
    status?: unknown;
    amount?: { value?: unknown; currency?: unknown } | null;
    custom_metadata?: Record<string, unknown> | null;
  } | null;
};

/** Résultat discriminé du traitement d'une vente Chariow. */
export type ChariowProcessResult =
  | { kind: "extension_purchase"; granted: boolean }
  | { kind: "ignored" }
  | { kind: "user_not_found" }
  | { kind: "duplicate_sale" }
  | { kind: "credited"; wallet: WalletSnapshot }
  | { kind: "failed"; error: string };

/**
 * Snapshot SÉRIALISABLE de la charge utile, borné (~100 Ko) : la valeur est
 * passée par JSON.stringify → JSON.parse pour garantir un objet JSON pur
 * (les valeurs non sérialisables sont écartées, un BigInt fait replier sur
 * un snapshot vide — le retraitement échouera alors visiblement en
 * « payload incomplet » plutôt que de corrompre le document). Au-delà du
 * plafond, le snapshot est tronqué et marqué `__truncated` : un tel document
 * est signalé par le rapprochement mais jamais retraité (JSON incomplet).
 */
export function buildChariowPayloadSnapshot(payload: unknown): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(payload);
    if (serialized == null) return {};
    if (serialized.length > MAX_PAYLOAD_SNAPSHOT_CHARS) {
      return { __truncated: true, raw: serialized.slice(0, MAX_PAYLOAD_SNAPSHOT_CHARS) };
    }
    return JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Extrait le payload retraitable d'un document de livraison (null si absent/tronqué). */
export function storedChariowPayload(data: unknown): Record<string, unknown> | null {
  const payload = (data as { payload?: unknown } | null | undefined)?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if ((payload as { __truncated?: unknown }).__truncated === true) return null;
  return payload as Record<string, unknown>;
}

/**
 * receivedAt en millisecondes. Absent/illisible → Date.now() : la livraison
 * est considérée FRAICHE (jamais reprise automatiquement) — le conservatisme
 * prime : on ne re-traite pas un document qu'on ne sait pas dater.
 */
export function receivedAtToMillis(value: unknown): number {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis();
  }
  return Date.now();
}

/**
 * Claim transactionnel d'une livraison (exécuté dans la transaction Firestore
 * — un seul worker peut obtenir le traitement) :
 * - document absent → create « processing » (attempts:1, payload stocké pour
 *   le retraitement par le rapprochement admin) ;
 * - status processed/ignored → doublon (livraison déjà terminée) ;
 * - status failed → REPRISE (l'échec redevient traitable) ;
 * - status processing + bail expiré → REPRISE (worker mort) ;
 * - sinon → in-flight (traitement en cours, à ne pas toucher).
 */
export async function claimChariowDelivery(
  deliveryId: string,
  payloadSnapshot: Record<string, unknown>,
): Promise<ChariowDeliveryClaim> {
  const deliveryRef = adminDb.collection(DELIVERY_COLLECTION).doc(deliveryId);
  return adminDb.runTransaction(async (tx): Promise<ChariowDeliveryClaim> => {
    const snap = await tx.get(deliveryRef);
    if (!snap.exists) {
      tx.create(deliveryRef, {
        deliveryId,
        // Parité avec l'ancien document : l'événement vu par le webhook.
        event: typeof payloadSnapshot.event === "string" ? payloadSnapshot.event : null,
        receivedAt: new Date(),
        attempts: 1,
        status: "processing",
        payload: payloadSnapshot,
      });
      return { action: "process" };
    }

    const data = snap.data() ?? {};
    const status = String(data.status ?? "");
    if (TERMINAL_STATUSES.has(status)) return { action: "duplicate-processed" };

    const receivedAtMs = receivedAtToMillis(data.receivedAt);
    if (status === "failed" || Date.now() - receivedAtMs > CHARIOW_LEASE_MS) {
      // Reprise : échec précédent OU bail expiré. Le payload est rafraîchi à
      // la dernière charge utile reçue — cela répare aussi les documents
      // antérieurs à Task 104-b qui n'en stockaient pas.
      tx.update(deliveryRef, {
        status: "processing",
        attempts: Number(data.attempts ?? 1) + 1,
        reclaimedAt: new Date(),
        payload: payloadSnapshot,
      });
      return { action: "process" };
    }

    return { action: "in-flight" };
  });
}

function isTopupSale(payload: ChariowWebhookPayload): boolean {
  const configuredProductId = process.env.CHARIOW_TOPUP_PRODUCT_ID?.trim();
  if (configuredProductId && String(payload?.product?.id ?? "") === configuredProductId) return true;
  return String(payload?.sale?.custom_metadata?.gen3ia_product ?? "") === "wallet_topup";
}

function extensionSaleMetadata(payload: ChariowWebhookPayload) {
  const metadata: Record<string, unknown> = payload?.sale?.custom_metadata ?? {};
  return {
    product: String(metadata.gen3ia_product ?? ""),
    purchaseId: String(metadata.purchaseId ?? ""),
    userId: String(metadata.userId ?? ""),
    extensionId: String(metadata.extensionId ?? ""),
  };
}

/**
 * Dédoublonnage par VENTE : une même vente peut arriver sous des deliveryIds
 * différents (re-délivrance après échec de notre part côté Chariow). On
 * cherche une livraison déjà processed portant ce saleId — égalités simples
 * sur champs auto-indexés, limit 1 : aucun index composite (politique quota
 * Task 102). La livraison courante ne peut pas se trouver elle-même (elle est
 * « processing » pendant le traitement), la garde doc.id !== deliveryId est
 * conservée par défense.
 */
async function findProcessedDeliveryIdBySale(saleId: string, deliveryId: string): Promise<string | null> {
  const snapshot = await adminDb
    .collection(DELIVERY_COLLECTION)
    .where("saleId", "==", saleId)
    .where("status", "==", "processed")
    .limit(1)
    .get();
  const doc = snapshot.docs.find((candidate) => candidate.id !== deliveryId);
  return doc?.id ?? null;
}

/**
 * Traitement métier d'une vente Chariow (logique déplacée du route.ts, qui
 * n'est plus qu'un adaptateur HTTP). Ne lève JAMAIS pour un échec métier :
 * l'échec est marqué sur le document de livraison (status « failed », message
 * tronqué) et retourné discriminé — le document redevient alors reprisable
 * (re-délivrance Chariow ou rapprochement admin). Seule une panne
 * d'infrastructure (écriture d'échec impossible) peut encore lever.
 */
export async function processChariowSale(
  payload: ChariowWebhookPayload,
  deliveryId: string,
): Promise<ChariowProcessResult> {
  const deliveryRef = adminDb.collection(DELIVERY_COLLECTION).doc(deliveryId);
  try {
    // Dédoublonnage par vente AVANT tout crédit : si la vente a déjà été
    // créditée via une autre livraison, on clôture celle-ci sans no-op.
    const saleIdHint = String(payload?.sale?.id ?? "");
    if (saleIdHint) {
      const processedDeliveryId = await findProcessedDeliveryIdBySale(saleIdHint, deliveryId);
      if (processedDeliveryId) {
        await deliveryRef.update({
          status: "processed",
          reason: "duplicate_sale",
          saleId: saleIdHint,
          processedAt: new Date(),
        });
        return { kind: "duplicate_sale" };
      }
    }

    const meta = extensionSaleMetadata(payload);
    if (meta.product === "extension_purchase") {
      const saleId = String(payload?.sale?.id ?? "");
      const saleStatus = String(payload?.sale?.status ?? "completed").toLowerCase();
      const amountValue = Number(payload?.sale?.amount?.value);
      const currency = String(payload?.sale?.amount?.currency ?? "").toUpperCase();
      const productId = String(payload?.product?.id ?? "");

      if (!meta.purchaseId || !meta.userId || !meta.extensionId || !saleId) {
        throw new Error("Extension purchase payload is missing purchase, user, extension, or sale reference.");
      }
      if (!CREDITABLE_STATUSES.has(saleStatus)) {
        throw new Error(`Sale status ${saleStatus} is not creditable.`);
      }
      if (!Number.isFinite(amountValue) || amountValue <= 0) {
        throw new Error("Extension sale amount is invalid.");
      }
      if (!currency) throw new Error("Extension sale currency is missing.");
      if (!productId) throw new Error("Extension sale product id is missing.");

      const result = await settleChariowExtensionPurchase({
        purchaseId: meta.purchaseId,
        providerRef: `chariow:${saleId}`,
        saleId,
        productId,
        userId: meta.userId,
        extensionId: meta.extensionId,
        amountMinor: Math.round(amountValue * 100),
        currency,
        status: saleStatus,
      });

      await deliveryRef.update({
        status: "processed",
        kind: "extension_purchase",
        purchaseId: meta.purchaseId,
        userId: meta.userId,
        extensionId: meta.extensionId,
        saleId,
        productId,
        granted: result.granted,
        processedAt: new Date(),
      });
      return { kind: "extension_purchase", granted: result.granted };
    }

    if (!isTopupSale(payload)) {
      await deliveryRef.update({ status: "ignored", reason: "not_a_wallet_topup_sale", processedAt: new Date() });
      return { kind: "ignored" };
    }

    const customerEmail = String(payload.customer?.email ?? "").trim().toLowerCase();
    const amount = Number(payload.sale?.amount?.value);
    const currency = String(payload.sale?.amount?.currency ?? "").toUpperCase();
    const saleId = String(payload.sale?.id ?? "");
    const saleStatus = String(payload.sale?.status ?? "completed").toLowerCase();
    if (!customerEmail || !saleId || !Number.isFinite(amount) || amount <= 0) {
      throw new Error("Chariow successful sale payload is missing required wallet fields.");
    }
    if (!CREDITABLE_STATUSES.has(saleStatus)) {
      throw new Error(`Sale status ${saleStatus} is not creditable.`);
    }
    if (currency !== WALLET_CURRENCY) {
      throw new Error(`Top-up currency ${currency} does not match wallet currency ${WALLET_CURRENCY}.`);
    }

    let user;
    try {
      user = await getAuth(getApps()[0]!).getUserByEmail(customerEmail);
    } catch {
      await deliveryRef.update({
        status: "failed",
        reason: "firebase_user_not_found",
        customerEmail,
        saleId,
        failedAt: new Date(),
      });
      return { kind: "user_not_found" };
    }

    const amountMinor = Math.round(amount * 100);
    const wallet = await applyTopup({
      userId: user.uid,
      amountMinor,
      currency,
      providerReference: saleId,
      metadata: {
        customerEmail,
        productId: String(payload.product?.id ?? ""),
        source: "pulse_webhook",
      },
    });
    await deliveryRef.update({ status: "processed", userId: user.uid, saleId, amountMinor, processedAt: new Date() });
    return { kind: "credited", wallet };
  } catch (error) {
    // Échec métier : message tronqué sur le document (reprendre est sûr —
    // le wallet reste idempotent par chariow_${saleId}), résultat 500 côté
    // HTTP pour que Chariow re-tente la livraison.
    const message = error instanceof Error ? error.message : "Wallet credit failed";
    const truncated = message.slice(0, 1000);
    await deliveryRef
      .update({ status: "failed", error: truncated, failedAt: new Date() })
      .catch(() => undefined);
    return { kind: "failed", error: truncated };
  }
}
