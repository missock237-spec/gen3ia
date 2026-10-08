import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIVE_VOICE_MIN_BALANCE_MINOR,
  LiveVoiceBillingError,
  billCompositionUsage,
  billVoiceTurn,
  billSttUsage,
  difficultyComplexity,
  isInsufficientFundsError,
  resolveDifficulty,
} from "./cost";

/**
 * Tests du coût Live Voix (Task 110-a) : 3 niveaux de difficulté (simple /
 * standard / avance), multiplicateurs, répartition breakdown, skips
 * (quantité 0), solde insuffisant → LIVE_INSUFFICIENT_FUNDS.
 * billUsage est mocké (contrat lib/billing/media-meter : renvoie
 * { reference, chargeMinor, reserveMinor, … }).
 */

const billUsageMock = vi.fn();

vi.mock("@/lib/billing/media-meter", () => ({
  billUsage: (...args: unknown[]) => billUsageMock(...args),
}));

/** chargeMinor factice par kind : stt=5, tts=10, agent=20. */
function fakeCharge(kind: string): number {
  if (kind === "audio_transcription") return 5;
  if (kind === "tts") return 10;
  return 20;
}

beforeEach(() => {
  vi.clearAllMocks();
  billUsageMock.mockImplementation(async (params: { kind: string }) => ({
    reference: `usage_ref_${params.kind}`,
    chargeMinor: fakeCharge(params.kind),
    reserveMinor: fakeCharge(params.kind) * 2,
  }));
});

describe("resolveDifficulty — 3 tiers serveur", () => {
  it("SIMPLE : conversation courte sans intention outil", () => {
    expect(resolveDifficulty("Bonjour", "Bonjour, comment puis-je aider ?")).toBe("simple");
    expect(difficultyComplexity("simple")).toBe(1.0);
  });

  it("STANDARD : réponse de plus de 350 caractères", () => {
    const reponse = "x".repeat(351);
    expect(resolveDifficulty("une question", reponse)).toBe("standard");
    expect(difficultyComplexity("standard")).toBe(1.6);
  });

  it("AVANCÉ : réponse de plus de 900 caractères", () => {
    expect(resolveDifficulty("une question", "x".repeat(901))).toBe("avance");
  });

  it("AVANCÉ : intention outil détectée dans le transcript (détection déterministe)", () => {
    expect(resolveDifficulty("crée-moi une vidéo TikTok", "Je lance la production.")).toBe("avance");
    expect(resolveDifficulty("envoie un email à paul@exemple.fr", "C'est envoyé.")).toBe("avance");
    expect(difficultyComplexity("avance")).toBe(2.5);
  });
});

describe("billSttUsage — facturation audio_transcription", () => {
  it("facture les secondes d'audio et renvoie chargeMinor", async () => {
    const minor = await billSttUsage({ userId: "user-1", turnId: "turn-1", audioSeconds: 7.5 });
    expect(minor).toBe(5);
    expect(billUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        executionId: "turn-1",
        kind: "audio_transcription",
        quantity: 7.5,
      }),
    );
  });

  it("quantité 0 → skip (billUsage exige une quantité > 0)", async () => {
    const minor = await billSttUsage({ userId: "user-1", turnId: "turn-1", audioSeconds: 0 });
    expect(minor).toBe(0);
    expect(billUsageMock).not.toHaveBeenCalled();
  });
});

describe("billCompositionUsage — facturation tts + voice_agent", () => {
  it("facture les caractères synthétisés et la durée du tour (complexité par difficulté)", async () => {
    const { ttsMinor, agentMinor } = await billCompositionUsage({
      userId: "user-1",
      turnId: "turn-1",
      ttsChars: 420,
      turnDurationMs: 12_000,
      difficulty: "standard",
    });
    expect(ttsMinor).toBe(10);
    expect(agentMinor).toBe(20);
    const ttsCall = billUsageMock.mock.calls.find((call) => call[0].kind === "tts")![0];
    expect(ttsCall.quantity).toBe(420);
    const agentCall = billUsageMock.mock.calls.find((call) => call[0].kind === "voice_agent")![0];
    // 12 000 ms = 0.2 min (fractionnaire > 0), complexity = multiplicateur.
    expect(agentCall.quantity).toBeCloseTo(0.2, 6);
    expect(agentCall.complexity).toBe(1.6);
  });

  it("durée très courte → plancher 0.01 minute ; ttsChars 0 → tts skippé", async () => {
    const { ttsMinor, agentMinor } = await billCompositionUsage({
      userId: "user-1",
      turnId: "turn-1",
      ttsChars: 0,
      turnDurationMs: 120,
      difficulty: "simple",
    });
    expect(ttsMinor).toBe(0);
    expect(agentMinor).toBe(20);
    expect(billUsageMock).toHaveBeenCalledTimes(1);
    const agentCall = billUsageMock.mock.calls[0]![0];
    expect(agentCall.quantity).toBeGreaterThanOrEqual(0.01);
    expect(agentCall.complexity).toBe(1.0);
  });
});

describe("billVoiceTurn — tour complet", () => {
  it("somme les chargeMinor dans costMinor avec la répartition breakdown", async () => {
    const result = await billVoiceTurn({
      userId: "user-1",
      turnId: "turn-1",
      transcript: "Bonjour",
      reply: "Une réponse suffisamment longue pour être standard. " + "d".repeat(300),
      audioSeconds: 4,
      ttsChars: 311,
      turnDurationMs: 9_000,
    });
    expect(result.difficulty).toBe("standard");
    expect(result.breakdown).toEqual({ sttMinor: 5, ttsMinor: 10, agentMinor: 20 });
    expect(result.costMinor).toBe(35);
  });

  it("solde insuffisant → erreur marquée LIVE_INSUFFICIENT_FUNDS (isInsufficientFundsError)", async () => {
    billUsageMock.mockRejectedValue(new Error("Insufficient wallet balance for this operation."));
    try {
      await billVoiceTurn({
        userId: "user-1",
        turnId: "turn-1",
        transcript: "Bonjour",
        reply: "Réponse courte.",
        audioSeconds: 3,
        ttsChars: 40,
        turnDurationMs: 5_000,
      });
      expect.unreachable("la facturation aurait dû lever");
    } catch (error) {
      expect(error).toBeInstanceOf(LiveVoiceBillingError);
      expect((error as LiveVoiceBillingError).code).toBe("LIVE_INSUFFICIENT_FUNDS");
      expect(isInsufficientFundsError(error)).toBe(true);
    }
  });

  it("isInsufficientFundsError : reconnaissance de l'erreur brute wallet et des faux négatifs", () => {
    expect(isInsufficientFundsError(new Error("Insufficient wallet balance for this operation."))).toBe(true);
    expect(isInsufficientFundsError(Object.assign(new Error("nope"), { name: "InsufficientFundsError" }))).toBe(true);
    expect(isInsufficientFundsError(new Error("Network down"))).toBe(false);
    expect(isInsufficientFundsError(undefined)).toBe(false);
  });

  it("autre panne de facturation → erreur brute propagée (non marquée fonds insuffisants)", async () => {
    billUsageMock.mockRejectedValue(new Error("Ledger unavailable"));
    await expect(
      billSttUsage({ userId: "user-1", turnId: "turn-1", audioSeconds: 2 }),
    ).rejects.toThrow("Ledger unavailable");
  });
});

describe("LIVE_VOICE_MIN_BALANCE_MINOR", () => {
  it("seuil de solde par défaut : 50 minor", () => {
    expect(LIVE_VOICE_MIN_BALANCE_MINOR).toBe(50);
  });
});
