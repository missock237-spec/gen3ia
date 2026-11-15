import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FACTURATION DE L'USAGE API PAR CLÉ `g3a_` (demande utilisateur n°9) —
 * contrat de la couche tarification + cycle financier :
 *
 *  1. Formule EXACTE en entiers (nano-euros → micro-euros → minor wallet) :
 *     0 token, 1 token, 1M tokens, arrondis déterministes ;
 *  2. Cycle réservation (estimation, 402 si solde insuffisant) → exécution →
 *     règlement au RÉEL mesuré → libération sur échec ;
 *  3. Transparence : tokens mesurés + montants exacts dans le résultat.
 *
 * Les primitives wallet sont simulées ici (le cycle FINANCIER RÉEL avec
 * ledger Firestore est couvert dans api-usage.wallet.test.ts).
 */

vi.mock("./wallet", () => ({
  WALLET_CURRENCY: "XAF",
  reserveFunds: vi.fn(),
  settleReservation: vi.fn(),
  releaseReservation: vi.fn(),
  getWallet: vi.fn(),
}));

import {
  API_INPUT_NANO_EUR_PER_TOKEN,
  API_OUTPUT_NANO_EUR_PER_TOKEN,
  API_TOKEN_INPUT_EUR_PER_MILLION,
  API_TOKEN_OUTPUT_EUR_PER_MILLION,
  computeApiTokenCharge,
  estimateApiRunReserveMinor,
  estimateTokensFromText,
  microEurToWalletMinor,
  runWithApiTokenBilling,
} from "./api-usage";
import { reserveFunds, settleReservation, releaseReservation } from "./wallet";
import { HttpError } from "@/lib/security/http-errors";

const mockedReserve = vi.mocked(reserveFunds);
const mockedSettle = vi.mocked(settleReservation);
const mockedRelease = vi.mocked(releaseReservation);

beforeEach(() => {
  vi.clearAllMocks();
  mockedReserve.mockResolvedValue({} as never);
  mockedSettle.mockResolvedValue({} as never);
  mockedRelease.mockResolvedValue({} as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("computeApiTokenCharge — formule exacte (entiers)", () => {
  it("tarifs officiels exposés : 1,00 €/1M entrant, 1,50 €/1M sortant", () => {
    expect(API_TOKEN_INPUT_EUR_PER_MILLION).toBe(1);
    expect(API_TOKEN_OUTPUT_EUR_PER_MILLION).toBe(1.5);
    expect(API_INPUT_NANO_EUR_PER_TOKEN).toBe(1000);
    expect(API_OUTPUT_NANO_EUR_PER_TOKEN).toBe(1500);
  });

  it("0 token → charge nulle (aucun débit possible)", () => {
    const charge = computeApiTokenCharge({ inputTokens: 0, outputTokens: 0 });
    expect(charge.totalNanoEur).toBe(0);
    expect(charge.chargeMicroEur).toBe(0);
    expect(charge.chargeMinor).toBe(0);
  });

  it("1 token entrant = 1000 nano€ = 1 micro€ (proratisation exacte par token)", () => {
    const charge = computeApiTokenCharge({ inputTokens: 1, outputTokens: 0 });
    expect(charge.inputNanoEur).toBe(1000);
    expect(charge.chargeMicroEur).toBe(1);
    // 1 micro€ = 655 957 nano-XAF → 0.0656 minor → arrondi supérieur = 1 minor.
    expect(charge.chargeMinor).toBe(1);
  });

  it("1 token sortant = 1500 nano€ = 2 micro€ (ceil de 1,5)", () => {
    const charge = computeApiTokenCharge({ inputTokens: 0, outputTokens: 1 });
    expect(charge.outputNanoEur).toBe(1500);
    expect(charge.chargeMicroEur).toBe(2);
  });

  it("1M tokens entrants = exactement 1,00 € → 65 596 minor XAF (ceil de 65 595,7)", () => {
    const charge = computeApiTokenCharge({ inputTokens: 1_000_000, outputTokens: 0 });
    expect(charge.chargeMicroEur).toBe(1_000_000);
    expect(charge.chargeMinor).toBe(65_596);
  });

  it("1M tokens sortants = exactement 1,50 € → 98 394 minor XAF (ceil de 98 393,55)", () => {
    const charge = computeApiTokenCharge({ inputTokens: 0, outputTokens: 1_000_000 });
    expect(charge.chargeMicroEur).toBe(1_500_000);
    expect(charge.chargeMinor).toBe(98_394);
  });

  it("arrondi déterministe : 3 entrants + 1 sortant = 4500 nano€ → ceil(4,5) = 5 micro€", () => {
    const charge = computeApiTokenCharge({ inputTokens: 3, outputTokens: 1 });
    expect(charge.totalNanoEur).toBe(4500);
    expect(charge.chargeMicroEur).toBe(5);
  });

  it("500k entrants + 500k sortants = 1,25 € → 1 250 000 micro€ (division exacte)", () => {
    const charge = computeApiTokenCharge({ inputTokens: 500_000, outputTokens: 500_000 });
    expect(charge.chargeMicroEur).toBe(1_250_000);
    expect(charge.chargeMinor).toBe(81_995); // ceil(81 994,625)
  });

  it("normalise les entrées invalides (négatif, NaN) à zéro — jamais de charge négative", () => {
    expect(computeApiTokenCharge({ inputTokens: -5, outputTokens: Number.NaN }).chargeMicroEur).toBe(0);
  });
});

describe("microEurToWalletMinor — conversion BigInt (aucun arrondi flottant)", () => {
  it("1 € (1M micro€) → 65 596 minor (ceil)", () => {
    expect(microEurToWalletMinor(1_000_000)).toBe(65_596);
  });

  it("0 et valeurs invalides → 0", () => {
    expect(microEurToWalletMinor(0)).toBe(0);
    expect(microEurToWalletMinor(-1)).toBe(0);
  });

  it("grands montants sans dépassement de précision (2^53 safe)", () => {
    // 10 000 € → 655 957 000 minor exactement (parité fixe, aucune perte).
    expect(microEurToWalletMinor(10_000 * 1_000_000)).toBe(655_957_000);
  });
});

describe("estimateTokensFromText / estimateApiRunReserveMinor — ESTIMATIONS documentées", () => {
  it("tokens ≈ caractères/4 (estimation affichée comme telle)", () => {
    expect(estimateTokensFromText("")).toBe(0);
    expect(estimateTokensFromText("12345678")).toBe(2);
    expect(estimateTokensFromText("123456789")).toBe(3);
  });

  it("la réservation est planchée (100 minor) et plafonnée (10 €), jamais excessive", () => {
    const small = estimateApiRunReserveMinor("x");
    expect(small).toBeGreaterThanOrEqual(100);
    const huge = estimateApiRunReserveMinor("a".repeat(100_000));
    expect(huge).toBeLessThanOrEqual(655_957_000); // cap 10 € en minor
  });
});

describe("runWithApiTokenBilling — cycle réservation/règlement", () => {
  it("réserve AVANT l'exécution puis règle au RÉEL mesuré (plafonné à la réservation)", async () => {
    const order: string[] = [];
    mockedReserve.mockImplementation(async () => {
      order.push("reserve");
      return {} as never;
    });
    mockedSettle.mockImplementation(async () => {
      order.push("settle");
      return {} as never;
    });

    const { result, usage } = await runWithApiTokenBilling({
      userId: "u1",
      apiKeyId: "hash1",
      apiKeyPrefix: "g3a_Ab12Cd",
      endpoint: "POST /api/v1/agents/{agentId}/run",
      objective: "Surveille le marché",
      executionId: "exec-1",
      fn: async () => {
        order.push("run");
        return { status: "completed" };
      },
      measure: () => ({ inputTokens: 12_000, outputTokens: 24_576 }),
    });

    expect(order).toEqual(["reserve", "run", "settle"]);
    expect(result).toEqual({ status: "completed" });
    // Réservation = tarifs officiels appliqués à l'estimation (12 000 in + 24 576 out attendus).
    expect(mockedReserve).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        reference: "api_exec-1",
        amountMinor: 3206, // 48 864 micro€ → 3206 minor XAF
        metadata: expect.objectContaining({ source: "api_usage", apiKeyPrefix: "g3a_Ab12Cd" }),
      }),
    );
    // Règlement au réel mesuré (mêmes tokens ici → même montant, sans clamp).
    expect(mockedSettle).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        reference: "api_exec-1",
        reservedMinor: 3206,
        actualChargeMinor: 3206,
        metadata: expect.objectContaining({
          inputTokens: "12000",
          outputTokens: "24576",
          chargeMicroEur: "48864",
          tariff: "1EUR_per_1M_input_1.5EUR_per_1M_output",
        }),
      }),
    );
    expect(usage.billed).toBe(true);
    expect(usage.debitedMinor).toBe(3206);
    expect(usage.charge.chargeMicroEur).toBe(48_864);
    expect(usage.measuredTokens).toEqual({ inputTokens: 12_000, outputTokens: 24_576 });
  });

  it("mesure > réservation : le clamp est exposé honnêtement (platformAbsorbedMinor)", async () => {
    const { usage } = await runWithApiTokenBilling({
      userId: "u1",
      apiKeyId: "hash1",
      apiKeyPrefix: "g3a_Ab12Cd",
      endpoint: "e",
      objective: "x",
      executionId: "exec-2",
      fn: async () => ({}),
      // 1M in + 1M out = 2 500 000 micro€ = 163 990 minor ≫ réservation estimée.
      measure: () => ({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    });
    expect(usage.charge.chargeMinor).toBe(163_990);
    expect(usage.debitedMinor).toBe(3206);
    expect(usage.platformAbsorbedMinor).toBe(163_990 - 3206);
    // Transparence : les tokens RÉELS restent rapportés.
    expect(usage.measuredTokens).toEqual({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
  });

  it("solde insuffisant à la réservation → HttpError 402 AVANT l'exécution", async () => {
    mockedReserve.mockRejectedValue(new Error("Insufficient wallet balance for this execution."));
    const fn = vi.fn(async () => ({ status: "completed" }));
    await expect(
      runWithApiTokenBilling({
        userId: "u1",
        apiKeyId: "hash1",
        apiKeyPrefix: "g3a_Ab12Cd",
        endpoint: "e",
        objective: "x",
        executionId: "exec-3",
        fn,
        measure: () => ({ inputTokens: 0, outputTokens: 0 }),
      }),
    ).rejects.toMatchObject({ status: 402 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("échec de l'exécution → réservation LIBÉRÉE (jamais payé pour un crash)", async () => {
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      runWithApiTokenBilling({
        userId: "u1",
        apiKeyId: "hash1",
        apiKeyPrefix: "g3a_Ab12Cd",
        endpoint: "e",
        objective: "x",
        executionId: "exec-4",
        fn,
        measure: () => ({ inputTokens: 0, outputTokens: 0 }),
      }),
    ).rejects.toThrow("boom");
    expect(mockedRelease).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", reference: "api_exec-4", reservedMinor: expect.any(Number) }),
    );
    expect(mockedSettle).not.toHaveBeenCalled();
  });

  it("exposition d'une HttpError levée DANS l'exécution (statut sémantique conservé)", async () => {
    const fn = vi.fn(async () => {
      throw new HttpError(429, "quota");
    });
    await expect(
      runWithApiTokenBilling({
        userId: "u1",
        apiKeyId: "hash1",
        apiKeyPrefix: "g3a_Ab12Cd",
        endpoint: "e",
        objective: "x",
        executionId: "exec-5",
        fn,
        measure: () => ({ inputTokens: 0, outputTokens: 0 }),
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(mockedRelease).toHaveBeenCalled();
  });

  it("MODE LIBRE (GEN3IA_BILLING_ENABLED=false) : aucune réservation, aucun débit, tarification au réel transparente", async () => {
    vi.stubEnv("GEN3IA_BILLING_ENABLED", "false");
    vi.resetModules();
    try {
      const { runWithApiTokenBilling: freeModeBilling } = await import("./api-usage");
      const { usage } = await freeModeBilling({
        userId: "u1",
        apiKeyId: "hash1",
        apiKeyPrefix: "g3a_Ab12Cd",
        endpoint: "e",
        objective: "x",
        executionId: "exec-free",
        fn: async () => ({ ok: true }),
        measure: () => ({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      });
      expect(usage.billingEnabled).toBe(false);
      expect(usage.billed).toBe(false);
      expect(usage.debitedMinor).toBe(0);
      expect(usage.reservedMinor).toBe(0);
      // Le comptage réel continue (transparence) même sans débit.
      expect(usage.charge.chargeMicroEur).toBe(2_500_000);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
