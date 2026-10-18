import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Le portillon s'appuie sur les primitives du portefeuille (réservation /
// règlement / libération) et sur la sélection de fournisseur pour estimer le
// pire cas : ces dépendances I/O sont simulées pour tester LA LOGIQUE.
vi.mock("./wallet", () => ({
  WALLET_CURRENCY: "XAF",
  getWallet: vi.fn(async () => ({ userId: "u", currency: "XAF", balanceMinor: 1_000_000, reservedMinor: 0, availableMinor: 1_000_000, updatedAt: 0, welcomeGranted: true, welcomeAmountMinor: 300_000 })),
  reserveFunds: vi.fn(async () => ({ userId: "u", currency: "XAF", balanceMinor: 1_000_000, reservedMinor: 100, availableMinor: 999_900, updatedAt: 0, welcomeGranted: true, welcomeAmountMinor: 300_000 })),
  settleReservation: vi.fn(async () => ({ userId: "u", currency: "XAF", balanceMinor: 999_900, reservedMinor: 0, availableMinor: 999_900, updatedAt: 0, welcomeGranted: true, welcomeAmountMinor: 300_000 })),
  releaseReservation: vi.fn(async () => ({ userId: "u", currency: "XAF", balanceMinor: 1_000_000, reservedMinor: 0, availableMinor: 1_000_000, updatedAt: 0, welcomeGranted: true, welcomeAmountMinor: 300_000 })),
}));
vi.mock("@/lib/ai/router", () => ({
  selectProvider: vi.fn(() => [{ provider: "gen3-snn", model: "gen3-snn-v1", reason: "test", score: 1 }]),
}));

import { getWallet, releaseReservation, reserveFunds, settleReservation } from "./wallet";
import { selectProvider } from "@/lib/ai/router";
import { runWithExecutionBilling, openExecutionBilling } from "./execution-gate";
import {
  recordExternalCostForBilling,
  recordLLMCallForBilling,
  SELF_BILLED_METADATA_KEY,
  SELF_BILLED_METADATA_VALUE,
  currentExecutionAccumulator,
} from "./execution-meter";
import { eurToXafRate } from "./cost-engine";

import type { AIRequest, AIResponse } from "@/lib/ai/models";

const mockedReserveFunds = vi.mocked(reserveFunds);
const mockedSettle = vi.mocked(settleReservation);
const mockedRelease = vi.mocked(releaseReservation);
const mockedGetWallet = vi.mocked(getWallet);
const mockedSelectProvider = vi.mocked(selectProvider);

function fakeLLMCall(inputTokens = 1_000, outputTokens = 500, selfBilled = false): void {
  const request = {
    task: "chat",
    messages: [{ role: "user", content: "question" }],
    ...(selfBilled ? { metadata: { [SELF_BILLED_METADATA_KEY]: SELF_BILLED_METADATA_VALUE } } : {}),
  } as unknown as AIRequest;
  const response = {
    provider: "gen3-snn",
    model: "gen3-snn-v1",
    text: "réponse",
    usage: { inputTokens, outputTokens },
    latencyMs: 100,
  } as unknown as AIResponse;
  recordLLMCallForBilling(request, response);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Réimplémentations explicites : clearAllMocks ne retire pas les
  // mockRejectedValue des tests précédents (fuite d'état entre tests).
  mockedReserveFunds.mockResolvedValue({} as never);
  mockedSettle.mockResolvedValue({} as never);
  mockedRelease.mockResolvedValue({} as never);
  mockedGetWallet.mockResolvedValue({ userId: "u", currency: "XAF", balanceMinor: 1_000_000, reservedMinor: 0, availableMinor: 1_000_000, updatedAt: 0, welcomeGranted: true, welcomeAmountMinor: 300_000 });
  mockedSelectProvider.mockReturnValue([{ provider: "gen3-snn", model: "gen3-snn-v1", reason: "test", score: 1 }]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runWithExecutionBilling — cycle réservation/exécution/règlement", () => {
  it("réserve AVANT d'exécuter puis règle au coût réel accumulé", async () => {
    const order: string[] = [];
    mockedReserveFunds.mockImplementation(async () => { order.push("reserve"); return {} as never; });
    mockedSettle.mockImplementation(async () => { order.push("settle"); return {} as never; });

    const { result, billing } = await runWithExecutionBilling({
      userId: "u",
      label: "test-exec",
      estimate: { task: "chat", inputTokens: 500, outputTokens: 1_000 },
      fn: async () => {
        order.push("fn");
        fakeLLMCall(2_000, 1_000);
        return "ok";
      },
    });

    expect(result).toBe("ok");
    // Ordre strict : la réservation précède l'exécution, le règlement la suit.
    expect(order).toEqual(["reserve", "fn", "settle"]);

    const reservedMinor = mockedReserveFunds.mock.calls[0]?.[0]?.amountMinor ?? 0;
    expect(reservedMinor).toBeGreaterThan(0);
    expect(billing.reservedMinor).toBe(reservedMinor);
    // Le coût réel (tokens à tarif NUL — moteur local) : la charge porte
    // l'overhead plateforme + la marge (minimum GEN3IA_MIN_EXECUTION_CHARGE_EUR).
    expect(billing.chargeMinor).toBeGreaterThan(0);
    expect(billing.llmCalls).toBe(1);
    expect(billing.inputTokens).toBe(2_000);
    expect(billing.outputTokens).toBe(1_000);
    expect(billing.currency).toBe("XAF");
    expect(billing.models).toContain("gen3-snn:gen3-snn-v1");
    // Le règlement reprend exactement le débit annoncé.
    expect(mockedSettle.mock.calls[0]?.[0]?.actualChargeMinor).toBe(billing.chargeMinor);
    expect(mockedSettle.mock.calls[0]?.[0]?.reservedMinor).toBe(reservedMinor);
    expect(mockedRelease).not.toHaveBeenCalled();
  });

  it("le coût externe + marge est facturé : charge > coût fournisseur brut", async () => {
    const { billing } = await runWithExecutionBilling({
      userId: "u",
      label: "test-margin",
      estimate: { task: "automation", externalToolCostEur: 0.5, toolCalls: 1 },
      fn: async () => {
        recordExternalCostForBilling({ eur: 0.5, label: "image-generation" });
        return "ok";
      },
    });
    // 0,50 € de coût externe → marge ~35 % appliquée → charge > externe.
    expect(billing.providerCostEur).toBeGreaterThanOrEqual(0.5);
    expect(billing.marginEur).toBeGreaterThan(0);
    expect(billing.chargeMinor).toBeGreaterThan(eurToXafRate() * 50); // > 0,50 XAF-minor
  });

  it("solde insuffisant → HttpError 402 AVANT toute exécution (fn jamais lancée)", async () => {
    mockedReserveFunds.mockRejectedValue(new Error("Insufficient wallet balance for this execution."));
    mockedGetWallet.mockResolvedValue({ availableMinor: 12_345 } as never);

    let executed = false;
    await expect(
      runWithExecutionBilling({
        userId: "u",
        label: "test-402",
        estimate: { task: "chat", inputTokens: 100, outputTokens: 100 },
        fn: async () => { executed = true; return "ok"; },
      }),
    ).rejects.toMatchObject({ status: 402, code: "PAYMENT_REQUIRED" });

    expect(executed).toBe(false);
    expect(mockedSettle).not.toHaveBeenCalled();
    expect(mockedRelease).not.toHaveBeenCalled();
  });

  it("échec de l'exécution → réservation LIBÉRÉE, jamais réglée", async () => {
    await expect(
      runWithExecutionBilling({
        userId: "u",
        label: "test-fail",
        estimate: { task: "chat", inputTokens: 100, outputTokens: 100 },
        fn: async () => { fakeLLMCall(500, 200); throw new Error("provider down"); },
      }),
    ).rejects.toThrow("provider down");

    expect(mockedRelease).toHaveBeenCalledTimes(1);
    const reservedMinor = mockedRelease.mock.calls[0]?.[0]?.reservedMinor ?? 0;
    expect(reservedMinor).toBe(mockedReserveFunds.mock.calls[0]?.[0]?.amountMinor);
    expect(mockedSettle).not.toHaveBeenCalled();
  });

  it("les appels self-billed (generateForUser) ne sont PAS comptés — pas de double facturation", async () => {
    const { billing } = await runWithExecutionBilling({
      userId: "u",
      label: "test-selfbilled",
      estimate: { task: "agent", inputTokens: 100, outputTokens: 100 },
      fn: async () => {
        fakeLLMCall(10_000, 5_000, true); // marqué self-billed → ignoré
        fakeLLMCall(1_000, 500, false); // compté
        return "ok";
      },
    });
    expect(billing.llmCalls).toBe(1);
    expect(billing.inputTokens).toBe(1_000);
  });

  it("le règlement est PLAFONNÉ à la réservation (débordement absorbé)", async () => {
    const { billing } = await runWithExecutionBilling({
      userId: "u",
      label: "test-cap",
      // Estimation minuscule : 1 token d'entrée/sortie.
      estimate: { task: "chat", inputTokens: 1, outputTokens: 1 },
      fn: async () => {
        // Consommation énorme par rapport à la réservation.
        fakeLLMCall(2_000_000, 1_000_000);
        fakeLLMCall(2_000_000, 1_000_000);
        return "ok";
      },
    });
    expect(billing.chargeMinor).toBe(billing.reservedMinor);
    expect(mockedSettle.mock.calls[0]?.[0]?.actualChargeMinor).toBe(billing.reservedMinor);
  });

  it("aucun appel LLM → règlement à 0 (exécution non facturée à tort)", async () => {
    const { billing } = await runWithExecutionBilling({
      userId: "u",
      label: "test-zero",
      estimate: { task: "chat", inputTokens: 100, outputTokens: 100 },
      fn: async () => "réponse déterministe sans LLM",
    });
    expect(billing.llmCalls).toBe(0);
    expect(billing.chargeMinor).toBe(0);
    expect(mockedSettle.mock.calls[0]?.[0]?.actualChargeMinor).toBe(0);
  });

  it("l'estimation du pire couvre le moteur unique (charge minimale)", async () => {
    const { billing } = await runWithExecutionBilling({
      userId: "u",
      label: "test-multi",
      estimate: { task: "chat", inputTokens: 1_000, outputTokens: 1_000 },
      fn: async () => "ok",
    });
    // Moteur neural unique (tarif nul) : la réserve couvre au minimum la
    // charge plancher (overhead + marge, ×RESERVE_MULTIPLIER).
    expect(billing.reservedMinor).toBeGreaterThanOrEqual(1);
  });

  it("la réservation est plafonnée (GEN3IA_MAX_EXECUTION_RESERVE_EUR) pour ne pas bloquer un solde entier", async () => {
    vi.stubEnv("GEN3IA_MAX_EXECUTION_RESERVE_EUR", "0.05");
    const { billing } = await runWithExecutionBilling({
      userId: "u",
      label: "test-plafond",
      estimate: { task: "agent", inputTokens: 1_000_000, outputTokens: 1_000_000, calls: 12, complexity: 5 },
      fn: async () => "ok",
    });
    // 0,05 € → 0,05 × 100 × 655,957 ≈ 3 280 minor.
    expect(billing.reservedMinor).toBeLessThanOrEqual(Math.ceil(0.05 * 100 * eurToXafRate()));
  });

  it("panne d'infrastructure du wallet → fail-OPEN : l'exécution continue, non facturée", async () => {
    mockedReserveFunds.mockRejectedValue(new Error("Firestore unavailable: connection reset"));
    let executed = false;
    const { result, billing } = await runWithExecutionBilling({
      userId: "u",
      label: "test-failopen",
      estimate: { task: "chat", inputTokens: 100, outputTokens: 100 },
      fn: async () => {
        executed = true;
        fakeLLMCall(1_000, 500);
        return "ok";
      },
    });
    expect(executed).toBe(true);
    expect(result).toBe("ok");
    // Le comptage a eu lieu (observabilité) mais rien n'est débité.
    expect(billing.llmCalls).toBe(1);
    expect(billing.chargeMinor).toBe(0);
    expect(mockedSettle).not.toHaveBeenCalled();
  });
});

describe("openExecutionBilling — session à complétion différée (flux)", () => {
  it("réserve à l'ouverture, compte pendant run(), règle au settle()", async () => {
    const session = await openExecutionBilling({
      userId: "u",
      label: "stream-turn",
      estimate: { task: "agent", inputTokens: 1_000, outputTokens: 1_000, calls: 2 },
    });
    expect(mockedReserveFunds).toHaveBeenCalledTimes(1);

    const out = await session.run(async () => {
      expect(currentExecutionAccumulator()?.label).toBe("stream-turn");
      fakeLLMCall(1_500, 700);
      return "flux fait";
    });
    expect(out).toBe("flux fait");

    const summary = await session.settle();
    expect(mockedSettle).toHaveBeenCalledTimes(1);
    expect(summary.chargeMinor).toBeGreaterThan(0);
    expect(summary.llmCalls).toBe(1);
    expect(summary.reservedMinor).toBe(mockedReserveFunds.mock.calls[0]?.[0]?.amountMinor);

    // Idempotence : un second settle/release ne rejoue rien.
    await session.settle();
    await session.release();
    expect(mockedSettle).toHaveBeenCalledTimes(1);
    expect(mockedRelease).not.toHaveBeenCalled();
  });

  it("release() libère sans règlement (échec de tour)", async () => {
    const session = await openExecutionBilling({
      userId: "u",
      label: "stream-fail",
      estimate: { task: "agent", inputTokens: 500, outputTokens: 500 },
    });
    await session.run(async () => {
      fakeLLMCall(400, 200);
      throw new Error("moteur en panne");
    }).catch(() => undefined);

    await session.release();
    expect(mockedRelease).toHaveBeenCalledTimes(1);
    expect(mockedSettle).not.toHaveBeenCalled();

    await session.settle(); // idempotent : déjà libéré
    expect(mockedSettle).not.toHaveBeenCalled();
  });

  it("solde insuffisant à l'ouverture → 402 avant tout travail", async () => {
    mockedReserveFunds.mockRejectedValue(new Error("AI agents are stopped because the wallet balance is 0. Recharge your Gen3ia wallet to resume all agents."));
    await expect(
      openExecutionBilling({ userId: "u", label: "stream-402", estimate: { task: "agent", inputTokens: 100, outputTokens: 100 } }),
    ).rejects.toMatchObject({ status: 402, code: "PAYMENT_REQUIRED" });
  });
});
