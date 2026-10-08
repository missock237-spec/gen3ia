import { describe, expect, it } from "vitest";

import { computeRenewalDecision } from "@/lib/live/voice/renewal-clock";

/** Repères d'une session standard : début t0, fin t0 + 10 min. */
const T0 = 1_700_000_000_000;
const SESSION_MS = 600_000;
const T30S = T0 + SESSION_MS - 30_000; // T-30 s
const FIN = T0 + SESSION_MS; // expiration exacte

describe("computeRenewalDecision", () => {
  it("ne fait rien hors de la fenêtre T-30 s", () => {
    expect(computeRenewalDecision({ startedAtMs: T0, nowMs: T0 + 1000, epoch: 1 })).toEqual({
      action: "none",
      remainingMs: 599_000,
    });
    expect(computeRenewalDecision({ startedAtMs: T0, nowMs: T30S - 1, epoch: 3 }).action).toBe("none");
  });

  it("déclenche un renouvellement exactement à T-30 s", () => {
    const decision = computeRenewalDecision({ startedAtMs: T0, nowMs: T30S, epoch: 1 });
    expect(decision.action).toBe("renew");
    expect(decision.remainingMs).toBe(30_000);
  });

  it("ne renouvelle qu'UNE SEULE fois par epoch (garde lastRenewAtMs)", () => {
    // Renouvellement réussi à T-30 s : les ticks suivants de la même epoch
    // ne doivent PLUS proposer un renew.
    const decision = computeRenewalDecision({
      startedAtMs: T0,
      nowMs: T30S + 1000,
      epoch: 1,
      lastRenewAtMs: T30S,
    });
    expect(decision.action).toBe("none");
    expect(decision.remainingMs).toBe(29_000);
  });

  it("réarme la garde à l'epoch suivante (horodatage antérieur au nouveau début)", () => {
    // Nouvelle epoch démarrée à T30S (renouvelée juste avant) : le dernier
    // renew (T30S) appartient à l'epoch précédente — un nouveau renew est
    // possible dès que la fenêtre T-30 s de la NOUVELLE epoch est atteinte.
    const nouveauDebut = T30S;
    expect(
      computeRenewalDecision({
        startedAtMs: nouveauDebut,
        nowMs: nouveauDebut + 1000,
        epoch: 2,
        lastRenewAtMs: T30S,
      }).action,
    ).toBe("none"); // hors fenêtre : reste 599 s
    const decision = computeRenewalDecision({
      startedAtMs: nouveauDebut,
      nowMs: nouveauDebut + SESSION_MS - 30_000,
      epoch: 2,
      lastRenewAtMs: T30S,
    });
    expect(decision.action).toBe("renew");
  });

  it("l'epoch finale ne se renouvelle plus (epoch >= maxEpochs → none)", () => {
    expect(
      computeRenewalDecision({ startedAtMs: T0, nowMs: T30S, epoch: 6, maxEpochs: 6 }).action,
    ).toBe("none");
  });

  it("expire à la fin de la durée, y compris sur l'epoch finale", () => {
    const decision = computeRenewalDecision({ startedAtMs: T0, nowMs: FIN, epoch: 6, maxEpochs: 6 });
    expect(decision).toEqual({ action: "expired", remainingMs: 0 });
    expect(computeRenewalDecision({ startedAtMs: T0, nowMs: FIN + 60_000, epoch: 2 }).action).toBe("expired");
  });

  it("clamp remainingMs à zéro (jamais négatif)", () => {
    const decision = computeRenewalDecision({ startedAtMs: T0, nowMs: FIN + 999_999, epoch: 1 });
    expect(decision.remainingMs).toBe(0);
  });

  it("respecte les options (sessionMs, renewLeadMs) et les défauts du contrat", () => {
    // Fenêtre personnalisée T-10 s.
    const courte = computeRenewalDecision({
      startedAtMs: T0,
      nowMs: T0 + 590_000,
      epoch: 1,
      renewLeadMs: 10_000,
    });
    expect(courte.action).toBe("renew");
    expect(courte.remainingMs).toBe(10_000);
    // Défauts : session 600 s, maxEpochs 6, fenêtre 30 s.
    expect(computeRenewalDecision({ startedAtMs: T0, nowMs: T30S, epoch: 5, maxEpochs: 6 }).action).toBe("renew");
  });
});
