import { NextResponse } from "next/server";

import { authenticateDeveloper } from "@/lib/extensions/developer-keys";
import { extensionApiError } from "@/lib/extensions/api";
import {
  getDeveloperPayoutBalance,
  listDeveloperPayouts,
  PAYOUT_METHODS,
  PAYOUT_METHOD_LABELS,
  requestDeveloperPayout,
} from "@/lib/extensions/payouts";

export const dynamic = "force-dynamic";

/**
 * Retraits de revenus du développeur connecté.
 * GET  /api/developer/payouts — solde (gagné / engagé / disponible) + historique.
 * POST /api/developer/payouts — demander un retrait.
 *      { amountMinor, method: "mtn_momo"|"orange_money"|"bank_transfer",
 *        methodDetail: { accountName, accountNumber, bankName?, country }, developerNote? }
 */
export async function GET(request: Request) {
  try {
    const developer = await authenticateDeveloper(request);
    const [balance, payouts] = await Promise.all([
      getDeveloperPayoutBalance(developer.userId),
      listDeveloperPayouts(developer.userId),
    ]);
    return NextResponse.json({
      balance,
      payouts,
      methods: PAYOUT_METHODS.map((method) => ({ id: method, label: PAYOUT_METHOD_LABELS[method] })),
    });
  } catch (error) {
    return extensionApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const developer = await authenticateDeveloper(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const payout = await requestDeveloperPayout({
      developerId: developer.userId,
      amountMinor: body.amountMinor,
      method: body.method,
      methodDetail: body.methodDetail,
      developerNote: body.developerNote,
    });
    return NextResponse.json({ payout }, { status: 201 });
  } catch (error) {
    return extensionApiError(error);
  }
}
