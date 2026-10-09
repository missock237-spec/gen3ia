import { FieldValue } from "@/lib/r2fs";

import { adminDb } from "@/lib/firebase/admin";
import { getWallet, WALLET_CURRENCY } from "./wallet";

/**
 * LIEN FACTURATION ↔ RÉSULTAT (concept post-SaaS #2 « Outcome-as-a-Service »).
 *
 * Une mission portant un contrat de résultat qui se termine en ÉCHEC
 * (étapes en échec ou porte d'acceptation bloquante) n'est pas facturée
 * comme un succès : un avoir automatique couvre les frais réellement
 * engagés, dans la limite d'un plafond (env GEN3IA_OUTCOME_CREDIT_CAP_EUR,
 * défaut 5 EUR). Le crédit est IDÉMPOTENT (un seul document de journal par
 * exécution) et FAIL-SOFT (une panne de crédit ne masque jamais l'échec de
 * la mission elle-même).
 *
 * Frontière honnête : le crédit rembourse les FRAIS DE LA PLATEFORME, pas
 * une promesse commerciale (les remboursements contractuels hors plateforme
 * restent un processus humain). Les frais de tiers (SMS, appels, dépenses
 * publicitaires) restent dus — seuls les frais d'exécution portés par
 * l'état du runtime sont éligibles.
 */

const LEDGER_COLLECTION = "walletLedger";

function envEur(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Plafond d'avoir automatique par mission en échec (minor units, EUR). */
export function outcomeCreditCapMinor(): number {
  return Math.floor(envEur("GEN3IA_OUTCOME_CREDIT_CAP_EUR", 5) * 100);
}

export interface OutcomeCreditResult {
  /** true si un avoir a été écrit (jamais deux fois pour une exécution). */
  credited: boolean;
  amountMinor: number;
  reason?: string;
}

/**
 * Applique l'avoir « mission échouée sous contrat de résultat ».
 * `totalChargeMinor` = frais d'exécution réels portés par l'état runtime.
 * Ne lève JAMAIS (fail-soft) : un échec d'avoir est journalisé, pas propagé.
 */
export async function applyOutcomeCredit(params: {
  userId: string;
  executionId: string;
  /** Frais d'exécution réels (0/absent = rien à créditer). */
  totalChargeMinor?: number;
  /** Motif factuel journalisé (état de fin de mission). */
  missionStatus?: string;
}): Promise<OutcomeCreditResult> {
  try {
    const capMinor = outcomeCreditCapMinor();
    const chargeMinor = Number.isFinite(params.totalChargeMinor) && (params.totalChargeMinor ?? 0) > 0
      ? Math.floor(params.totalChargeMinor ?? 0)
      : 0;
    const amountMinor = Math.min(chargeMinor, capMinor);
    if (amountMinor <= 0) {
      return { credited: false, amountMinor: 0, reason: "Aucun frais éligible à l'avoir." };
    }

    const walletRef = adminDb.collection("userWallets").doc(params.userId);
    const ledgerRef = adminDb.collection(LEDGER_COLLECTION).doc(`outcome_${params.executionId}`);

    const written = await adminDb.runTransaction(async (tx): Promise<boolean> => {
      const [walletSnap, ledgerSnap] = await Promise.all([tx.get(walletRef), tx.get(ledgerRef)]);
      // Idempotence : un avoir outcome_credit existe déjà pour cette exécution.
      if (ledgerSnap.exists) return false;
      const current = walletSnap.exists ? Number(walletSnap.get("balanceMinor") ?? 0) : 0;
      tx.set(
        walletRef,
        {
          userId: params.userId,
          currency: WALLET_CURRENCY,
          balanceMinor: current + amountMinor,
          reservedMinor: walletSnap.exists ? Number(walletSnap.get("reservedMinor") ?? 0) : 0,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      tx.create(ledgerRef, {
        userId: params.userId,
        // Type du schéma wallet (WalletTransactionType) : un avoir de
        // résultat est un REMBOURSEMENT automatique — metadata.reason
        // porte la distinction avec les remboursements manuels.
        type: "refund",
        amountMinor,
        currency: WALLET_CURRENCY,
        provider: "gen3ia",
        providerReference: params.executionId,
        metadata: {
          executionId: params.executionId,
          ...(params.missionStatus ? { missionStatus: params.missionStatus.slice(0, 40) } : {}),
          reason: "mission_failed_outcome_contract",
        },
        createdAt: FieldValue.serverTimestamp(),
      });
      return true;
    });

    return written
      ? { credited: true, amountMinor }
      : { credited: false, amountMinor: 0, reason: "Avoir déjà accordé pour cette exécution (idempotence)." };
  } catch (error) {
    // Fail-soft : un avoir qui échoue ne change JAMAIS l'issue de la mission.
    console.error("[outcome-credits] avoir non appliqué (fail-soft):", error instanceof Error ? error.message : error);
    return { credited: false, amountMinor: 0, reason: "Crédit indisponible (erreur d'infrastructure)." };
  }
}

/**
 * Décision PURE d'avoir (testée sans Firestore) : un avoir n'est dû que si
 * un contrat de résultat était présent ET que la mission s'est terminée en
 * échec. « paused » / « cancelled » (arrêt utilisateur) ne déclenchent pas
 * d'avoir automatique — le travail peut être repris ou a été interrompu à
 * la demande de son propriétaire.
 */
export function shouldCreditOutcomeFailure(input: {
  contractPresent: boolean;
  missionStatus: "pending" | "running" | "completed" | "failed" | "cancelled" | "paused";
}): boolean {
  return input.contractPresent && input.missionStatus === "failed";
}

/** Solde courant du portefeuille (lecture légère pour les sondes). */
export async function getWalletBalanceMinor(userId: string): Promise<number> {
  const wallet = await getWallet(userId);
  return wallet.balanceMinor;
}
