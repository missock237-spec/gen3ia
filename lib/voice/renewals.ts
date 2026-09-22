/**
 * Renouvellement mensuel des numéros virtuels vendus.
 *
 * Un numéro acheté (source gen3ia) est facturé chaque mois au prix vendu
 * (fournisseur + 20 %). Au terme (nextRenewalAt) :
 *  - wallet financé  : débit mensuel (ledger idempotent par période) et
 *    prolongation de 30 jours ;
 *  - wallet insuffisant : le numéro passe en « pending » (grâce de 7 jours,
 *    relance possible) puis « released » si rien ne rentre sous 30 jours ;
 *    le numéro est relâché chez le fournisseur uniquement en fin de grâce
 *    — le client garde son numéro autant que possible.
 *
 * Déclenchement : cron /api/cron/agent-schedules (toutes les 5 minutes) —
 * la fonction est idempotent (claim via nextRenewalAt mis à jour en
 * transaction avant tout débit).
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";
import { reserveFunds, settleReservation, releaseReservation } from "@/lib/billing/wallet";
import { releaseAgentPhoneNumber } from "@/lib/integrations/twilio/numbers";

const COLLECTION = "agentPhoneNumbers";
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const HARD_RELEASE_MS = 30 * 24 * 60 * 60 * 1000;
const RENEWAL_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

interface RenewalOutcome {
  id: string;

  phoneNumber: string;

  status: "charged" | "grace" | "released" | "skipped";

  reason?: string;
}

export async function renewDueNumbers(now = new Date(), limit = 50): Promise<RenewalOutcome[]> {
  const outcomes: RenewalOutcome[] = [];
  const nowMs = now.getTime();

  const snapshot = await adminDb
    .collection(COLLECTION)
    .where("status", "==", "active")
    .where("source", "==", "gen3ia")
    .limit(limit)
    .get();

  for (const doc of snapshot.docs) {
    const data = doc.data() as {
      ownerId?: string;
      phoneNumber?: string;
      monthlyChargeMinor?: number;
      nextRenewalAt?: Timestamp;
      releasedAt?: unknown;
    };
    const nextRenewalAt = data.nextRenewalAt?.toMillis?.() ?? 0;
    if (!nextRenewalAt || nextRenewalAt > nowMs) {
      continue; // pas encore dû (ou record historique sans renouvellement)
    }
    const ownerId = String(data.ownerId ?? "");
    const monthlyChargeMinor = Number(data.monthlyChargeMinor ?? 0);
    if (!ownerId || !Number.isSafeInteger(monthlyChargeMinor) || monthlyChargeMinor <= 0) {
      outcomes.push({ id: doc.id, phoneNumber: String(data.phoneNumber ?? ""), status: "skipped", reason: "record incomplet" });
      continue;
    }

    const reference = `phone-renewal-${doc.id}-${nextRenewalAt}`;
    try {
      // Débit mensuel idempotent : reserveFunds échoue (exception) si le
      // solde est insuffisant → grâce.
      await reserveFunds({
        userId: ownerId,
        amountMinor: monthlyChargeMinor,
        reference,
        metadata: { product: "gen3ia_phone_number_renewal", phoneNumber: data.phoneNumber ?? "" },
      });
      await settleReservation({
        userId: ownerId,
        reference,
        reservedMinor: monthlyChargeMinor,
        actualChargeMinor: monthlyChargeMinor,
        metadata: { product: "gen3ia_phone_number_renewal" },
      });
      await doc.ref.update({
        nextRenewalAt: Timestamp.fromMillis(nextRenewalAt + RENEWAL_PERIOD_MS),
        updatedAt: FieldValue.serverTimestamp(),
      });
      outcomes.push({ id: doc.id, phoneNumber: String(data.phoneNumber ?? ""), status: "charged" });
    } catch {
      // Wallet insuffisant : grâce 7 jours puis libération à 30 jours.
      const overdueMs = nowMs - nextRenewalAt;
      if (overdueMs >= HARD_RELEASE_MS) {
        try {
          await releaseAgentPhoneNumber(ownerId, doc.id);
          outcomes.push({ id: doc.id, phoneNumber: String(data.phoneNumber ?? ""), status: "released", reason: "impayé 30 jours" });
        } catch (releaseError) {
          outcomes.push({
            id: doc.id,
            phoneNumber: String(data.phoneNumber ?? ""),
            status: "skipped",
            reason: `libération impossible: ${releaseError instanceof Error ? releaseError.message : "erreur"}`,
          });
        }
      } else {
        await doc.ref
          .update({
            status: overdueMs >= GRACE_PERIOD_MS ? "pending" : "active",
            renewalNotice: `Paiement du renouvellement en attente (${Math.ceil(overdueMs / (24 * 60 * 60 * 1000))} j)`,
            updatedAt: FieldValue.serverTimestamp(),
          })
          .catch(() => undefined);
        outcomes.push({ id: doc.id, phoneNumber: String(data.phoneNumber ?? ""), status: "grace", reason: "solde insuffisant" });
      }
    }
  }

  return outcomes;
}

/**
 * Rattrapage des numéros en « pending » (grâce) dont le propriétaire a
 * rechargé son wallet : reprend le cycle de facturation normal.
 */
export async function reactivateNumbersInGrace(now = new Date(), limit = 25): Promise<RenewalOutcome[]> {
  const outcomes: RenewalOutcome[] = [];
  const snapshot = await adminDb
    .collection(COLLECTION)
    .where("status", "==", "pending")
    .where("source", "==", "gen3ia")
    .limit(limit)
    .get();

  for (const doc of snapshot.docs) {
    const data = doc.data() as { monthlyChargeMinor?: number; ownerId?: string; updatedAt?: Timestamp };
    const updatedAt = data.updatedAt?.toMillis?.() ?? 0;
    const monthlyChargeMinor = Number(data.monthlyChargeMinor ?? 0);
    const ownerId = String(data.ownerId ?? "");
    if (!ownerId || monthlyChargeMinor <= 0 || !updatedAt) continue;

    const reference = `phone-renewal-${doc.id}-${updatedAt}`;
    try {
      await reserveFunds({
        userId: ownerId,
        amountMinor: monthlyChargeMinor,
        reference,
        metadata: { product: "gen3ia_phone_number_renewal", reactivate: "true" },
      });
      await settleReservation({
        userId: ownerId,
        reference,
        reservedMinor: monthlyChargeMinor,
        actualChargeMinor: monthlyChargeMinor,
        metadata: { product: "gen3ia_phone_number_renewal" },
      });
      await doc.ref.update({
        status: "active",
        nextRenewalAt: Timestamp.fromMillis(now.getTime() + RENEWAL_PERIOD_MS),
        renewalNotice: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      outcomes.push({ id: doc.id, phoneNumber: String(doc.data().phoneNumber ?? ""), status: "charged", reason: "réactivation" });
    } catch {
      // Toujours insuffisant : on retentera au prochain passage.
    }
  }
  return outcomes;
}
