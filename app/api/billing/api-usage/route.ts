import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import { adminDb } from "@/lib/firebase/admin";
import { BILLING_ENABLED } from "@/lib/billing/billing-mode";
import {
  API_TOKEN_INPUT_EUR_PER_MILLION,
  API_TOKEN_OUTPUT_EUR_PER_MILLION,
  API_USAGE_FORMULA,
  API_USAGE_MEASUREMENT_NOTE,
} from "@/lib/billing/api-usage";
import { getWallet } from "@/lib/billing/wallet";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

/**
 * CONSOMMATION API + SOLDE (demande utilisateur n°9) — endpoint de la
 * famille facturation, authentifié session Firebase comme les autres
 * routes /api/billing/**.
 *
 *   GET /api/billing/api-usage
 *
 * Répond : solde du portefeuille, tarifs officiels des clés API (1,00 €/1M
 * entrant, 1,50 €/1M sortant), formule exacte et les DERNIÈRES écritures de
 * ledger liées à l'usage API par clé `g3a_` (réservations + règlements,
 * tokens entrants/sortants mesurés, montants). Honnêteté : la consommation
 * listée est celle du ledger réel — fenêtre limitée aux 100 dernières
 * écritures du compte (jamais présentée comme un total d'historique complet).
 */
export async function GET(request: Request) {
  try {
    const token = await verifyFirebaseRequest(request);
    const wallet = await getWallet(token.uid);

    const snapshot = await adminDb
      .collection("walletLedger")
      .where("userId", "==", token.uid)
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();

    type UsageEntry = {
      id: string;
      type: string;
      amountMinor: number;
      reference: string | null;
      apiKeyPrefix: string | null;
      endpoint: string | null;
      inputTokens: number;
      outputTokens: number;
      chargeMicroEur: number | null;
      platformAbsorbedMinor: number;
      createdAt: number;
    };

    const entries: UsageEntry[] = [];
    let totalsInputTokens = 0;
    let totalsOutputTokens = 0;
    let totalsDebitedMinor = 0;

    for (const doc of snapshot.docs) {
      const data = doc.data() as Record<string, unknown>;
      const metadata = (data.metadata && typeof data.metadata === "object" ? data.metadata : {}) as Record<string, unknown>;
      if (metadata.source !== "api_usage") continue;
      const inputTokens = Number(metadata.inputTokens ?? 0) || 0;
      const outputTokens = Number(metadata.outputTokens ?? 0) || 0;
      const amountMinor = Number(data.amountMinor ?? 0) || 0;
      const absorbed = Number(metadata.platformAbsorbedMinor ?? 0) || 0;
      totalsInputTokens += inputTokens;
      totalsOutputTokens += outputTokens;
      if (String(data.type ?? "") === "charge") totalsDebitedMinor += amountMinor;
      entries.push({
        id: doc.id,
        type: String(data.type ?? "unknown"),
        amountMinor,
        reference: data.reference ? String(data.reference).slice(0, 128) : null,
        apiKeyPrefix: metadata.apiKeyPrefix ? String(metadata.apiKeyPrefix).slice(0, 32) : null,
        endpoint: metadata.endpoint ? String(metadata.endpoint).slice(0, 128) : null,
        inputTokens,
        outputTokens,
        chargeMicroEur: metadata.chargeMicroEur != null ? Number(metadata.chargeMicroEur) || 0 : null,
        platformAbsorbedMinor: absorbed,
        createdAt:
          typeof (data.createdAt as { toMillis?: unknown } | null | undefined)?.toMillis === "function"
            ? (data.createdAt as { toMillis: () => number }).toMillis()
            : Date.now(),
      });
    }

    return Response.json({
      success: true,
      billingEnabled: BILLING_ENABLED,
      wallet,
      tariffs: {
        inputEurPerMillion: API_TOKEN_INPUT_EUR_PER_MILLION,
        outputEurPerMillion: API_TOKEN_OUTPUT_EUR_PER_MILLION,
        currency: "EUR",
        walletCurrency: wallet.currency,
      },
      formula: API_USAGE_FORMULA,
      measurementNote: API_USAGE_MEASUREMENT_NOTE,
      window: { ledgerEntriesScanned: snapshot.docs.length, limit: 100 },
      totals: {
        inputTokens: totalsInputTokens,
        outputTokens: totalsOutputTokens,
        debitedMinor: totalsDebitedMinor,
        note: "somme des écritures « api_usage » dans la fenêtre consultée (100 dernières écritures du compte) — pas un total d'historique complet",
      },
      entries,
    });
  } catch (error) {
    return Response.json(errorBody(error, "Could not load API usage"), { status: errorStatus(error, 400) });
  }
}
