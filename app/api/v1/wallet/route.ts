import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { franchirPorteV1, ErrorAccesV1 } from "@/lib/api/v1/porte-v1";
import { getWallet } from "@/lib/billing/wallet";
import { errorStatus } from "@/lib/security/http-errors";

/**
 * GET /api/v1/wallet — état du PORTEFEUILLE du propriétaire de la clé.
 *
 * MODÈLE ÉCONOMIQUE (décision utilisateur, 2026-10-24) : l'API fonctionne au
 * portefeuille — PAS d'abonnement. Cet endpoint expose le solde réel, la
 * réserve en cours et le disponible, dans la devise du wallet (XAF, unités
 * mineures = centimes CFA). Aucun plan, aucun engagement : le développeur
 * recharge son portefeuille (Mobile Money / carte via Chariow) et paie au
 * réel ce qu'il consomme.
 */
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const porte = await franchirPorteV1(request, "wallet");
    const wallet = await getWallet(porte.identite.userId);

    return NextResponse.json(
      {
        wallet: {
          currency: wallet.currency,
          balanceMinor: wallet.balanceMinor,
          reservedMinor: wallet.reservedMinor,
          availableMinor: wallet.availableMinor,
          updatedAt: wallet.updatedAt,
        },
        mode: {
          billingEnabled: process.env.GEN3IA_BILLING_ENABLED === "true",
          note: process.env.GEN3IA_BILLING_ENABLED === "true"
            ? "Facturation au réel active (tokens mesurés : 1,00 €/1M entrant, 1,50 €/1M sortant)."
            : "Mode libre : aucune déduction n'est appliquée tant que la facturation n'est pas armée côté plateforme.",
        },
        requestId,
      },
      { status: 200, headers: { "x-request-id": requestId, ...porte.enTetesLimite } },
    );
  } catch (error) {
    if (error instanceof ErrorAccesV1) {
      return NextResponse.json(
        { error: error.message, requestId },
        { status: error.statut, headers: { "x-request-id": requestId, ...error.enTetes } },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur inconnue.", requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}
