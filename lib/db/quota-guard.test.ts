import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests du disjoncteur quota Firestore (Task 95-b).
 *
 * Couverture : table de détection (codes gRPC/REST, messages, causes
 * imbriquées, objets non-Error, erreurs métier exclues), machine à états du
 * disjoncteur (seuil d'ouverture, cooldown logiciel/quotidien, sonde
 * half-open unique, refermeture sur succès, ré-ouverture sur échec de
 * sonde), réinitialisation de test.
 */

import {
  beginFirestoreProbe,
  getQuotaGuardStats,
  isFirestoreQuotaError,
  isFirestoreTransientError,
  noteFirestoreQuotaError,
  noteFirestoreStall,
  noteFirestoreSuccess,
  QUOTA_BREAKER_OPEN_THRESHOLD,
  QUOTA_COOLDOWN_HARD_MS,
  QUOTA_COOLDOWN_SOFT_MS,
  resetQuotaGuardForTests,
  shouldShortCircuitFirestore,
} from "./quota-guard";

function quotaError(message = "Quota exceeded for quota group 'default'.", extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { code: 8, ...extra });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetQuotaGuardForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isFirestoreQuotaError (table de détection)", () => {
  it.each([
    ["code gRPC 8 (nombre)", { code: 8, message: "gRPC fallait" }],
    ["code REST \"8\" (chaîne)", { code: "8", message: "rest" }],
    ["code RESOURCE_EXHAUSTED", { code: "RESOURCE_EXHAUSTED", message: "x" }],
    ["code quota-exceeded (tiret normalisé)", { code: "quota-exceeded", message: "x" }],
    ["message 'Quota exceeded for quota group'", new Error("Quota exceeded for quota group 'default'.")],
    ["message 'free daily read units'", new Error("Exceeded free daily read units")],
    ["message 'Too many requests'", new Error("Too many requests")],
    ["message 'rate limit'", new Error("rate limit reached for project")],
    ["message 'exhausted'", new Error("backend capacity exhausted")],
    ["HTTP 429 via status nombre", Object.assign(new Error("http error"), { status: 429 })],
    ["HTTP 429 via code chaîne", Object.assign(new Error("http error"), { code: "429" })],
    ["daily + limite", new Error("writes per day limit reached")],
    ["chaîne brute RESOURCE_EXHAUSTED", "RESOURCE_EXHAUSTED: Quota exceeded"],
  ])("détecte : %s", (_label, error) => {
    expect(isFirestoreQuotaError(error)).toBe(true);
  });

  it.each([
    ["gRPC 14 UNAVAILABLE", { code: 14, message: "service down" }],
    ["message UNAVAILABLE", new Error("The service is currently unavailable")],
    ["DEADLINE_EXCEEDED", { code: 4, message: "deadline exceeded" }],
    ["ETIMEDOUT réseau", Object.assign(new Error("socket hangup"), { code: "ETIMEDOUT" })],
  ])("quota:false ET transitoire:true pour %s", (_label, error) => {
    expect(isFirestoreQuotaError(error)).toBe(false);
    expect(isFirestoreTransientError(error)).toBe(true);
  });

  it.each([
    ["permission denied (métier)", new Error("Missing or insufficient permissions")],
    ["not found (métier)", { code: 5, message: "Document not found" }],
  ])("ne matche PAS les erreurs métier : %s", (_label, error) => {
    expect(isFirestoreQuotaError(error)).toBe(false);
    expect(isFirestoreTransientError(error)).toBe(false);
  });

  it("détecte le quota via la chaîne error.cause imbriquée", () => {
    const nested = Object.assign(new Error("cause profonde"), { code: 8 });
    const outer = new Error("appel Firestore échoué", { cause: nested });
    expect(isFirestoreQuotaError(outer)).toBe(true);
  });

  it("détecte le quota sur un objet non-Error", () => {
    expect(isFirestoreQuotaError({ code: "RESOURCE_EXHAUSTED", message: "quota group exhausted" })).toBe(true);
  });
});

describe("disjoncteur (machine à états)", () => {
  it("constantes du contrat", () => {
    expect(QUOTA_BREAKER_OPEN_THRESHOLD).toBe(3);
    expect(QUOTA_COOLDOWN_SOFT_MS).toBe(90_000);
    expect(QUOTA_COOLDOWN_HARD_MS).toBe(600_000);
  });

  it("état initial : fermé, aucun court-circuit", () => {
    const stats = getQuotaGuardStats();
    expect(stats.state).toBe("closed");
    expect(stats.consecutiveQuotaErrors).toBe(0);
    expect(stats.shortCircuits).toBe(0);
    expect(stats.hardQuota).toBe(false);
    expect(stats.openedAt).toBeNull();
    expect(stats.cooldownEndsAt).toBeNull();
    expect(shouldShortCircuitFirestore()).toBe(false);
  });

  it("2 erreurs consécutives : reste fermé (pas de court-circuit)", () => {
    noteFirestoreQuotaError(quotaError());
    noteFirestoreQuotaError(quotaError());
    expect(getQuotaGuardStats().state).toBe("closed");
    expect(shouldShortCircuitFirestore()).toBe(false);
  });

  it("3e erreur : OUVERT (short-circuit, hardQuota false, cooldown 90 s)", () => {
    noteFirestoreQuotaError(quotaError());
    noteFirestoreQuotaError(quotaError());
    noteFirestoreQuotaError(quotaError("Quota exceeded for quota group"));
    const stats = getQuotaGuardStats();
    expect(stats.state).toBe("open");
    expect(shouldShortCircuitFirestore()).toBe(true);
    expect(stats.hardQuota).toBe(false);
    expect(stats.consecutiveQuotaErrors).toBe(3);
    expect(stats.lastQuotaError).toContain("Quota exceeded");
    expect(stats.lastQuotaErrorAt).not.toBeNull();
    const cooldownMs = Date.parse(stats.cooldownEndsAt!) - Date.parse(stats.openedAt!);
    expect(cooldownMs).toBe(QUOTA_COOLDOWN_SOFT_MS);
  });

  it("après 90 s : half-open paresseux, sonde unique (true puis false)", () => {
    for (let index = 0; index < 3; index += 1) noteFirestoreQuotaError(quotaError());
    vi.advanceTimersByTime(QUOTA_COOLDOWN_SOFT_MS - 1);
    expect(getQuotaGuardStats().state).toBe("open");
    vi.advanceTimersByTime(1);
    expect(getQuotaGuardStats().state).toBe("half-open");
    expect(beginFirestoreProbe()).toBe(true);
    expect(beginFirestoreProbe()).toBe(false); // exactement UNE sonde
    expect(beginFirestoreProbe()).toBe(false);
  });

  it("sonde réussie → refermé + compteurs d'erreurs remis à zéro", () => {
    for (let index = 0; index < 3; index += 1) noteFirestoreQuotaError(quotaError());
    vi.advanceTimersByTime(QUOTA_COOLDOWN_SOFT_MS);
    expect(beginFirestoreProbe()).toBe(true);
    noteFirestoreSuccess();
    const stats = getQuotaGuardStats();
    expect(stats.state).toBe("closed");
    expect(stats.consecutiveQuotaErrors).toBe(0);
    expect(stats.openedAt).toBeNull();
    expect(stats.cooldownEndsAt).toBeNull();
    expect(stats.hardQuota).toBe(false);
    expect(shouldShortCircuitFirestore()).toBe(false);
  });

  it("sonde échouée → ré-ouverture avec cooldown FRAIS, shortCircuits préservé", () => {
    for (let index = 0; index < 3; index += 1) noteFirestoreQuotaError(quotaError());
    // Pendant l'ouverture, chaque demande de court-circuit est comptée.
    shouldShortCircuitFirestore();
    shouldShortCircuitFirestore();
    const shortCircuitsBefore = getQuotaGuardStats().shortCircuits;
    expect(shortCircuitsBefore).toBeGreaterThanOrEqual(2);

    vi.advanceTimersByTime(QUOTA_COOLDOWN_SOFT_MS);
    expect(beginFirestoreProbe()).toBe(true);
    noteFirestoreQuotaError(quotaError("quota à nouveau"));
    const stats = getQuotaGuardStats();
    expect(stats.state).toBe("open");
    expect(stats.shortCircuits).toBe(shortCircuitsBefore);
    const cooldownEnds = Date.parse(stats.cooldownEndsAt!);
    expect(cooldownEnds - Date.now()).toBe(QUOTA_COOLDOWN_SOFT_MS); // cooldown FRAIS

    vi.advanceTimersByTime(QUOTA_COOLDOWN_SOFT_MS - 1);
    expect(beginFirestoreProbe()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(beginFirestoreProbe()).toBe(true);
  });

  it("quota quotidien → hardQuota true + cooldown 600 s", () => {
    noteFirestoreQuotaError(new Error("You have exceeded your free daily read units"));
    noteFirestoreQuotaError(new Error("daily limit reached"));
    noteFirestoreQuotaError(new Error("writes per day exceeded"));
    const stats = getQuotaGuardStats();
    expect(stats.state).toBe("open");
    expect(stats.hardQuota).toBe(true);
    const cooldownMs = Date.parse(stats.cooldownEndsAt!) - Date.parse(stats.openedAt!);
    expect(cooldownMs).toBe(QUOTA_COOLDOWN_HARD_MS);
    // Le cooldown logiciel ne suffit pas : pas de sonde à 90 s.
    vi.advanceTimersByTime(QUOTA_COOLDOWN_SOFT_MS);
    expect(beginFirestoreProbe()).toBe(false);
    vi.advanceTimersByTime(QUOTA_COOLDOWN_HARD_MS - QUOTA_COOLDOWN_SOFT_MS);
    expect(beginFirestoreProbe()).toBe(true);
  });

  it("noteFirestoreSuccess en cours de route remet le compteur consécutif à zéro", () => {
    noteFirestoreQuotaError(quotaError());
    noteFirestoreQuotaError(quotaError());
    noteFirestoreSuccess();
    expect(getQuotaGuardStats().consecutiveQuotaErrors).toBe(0);
    // Deux nouvelles erreurs ne suffisent plus à ouvrir.
    noteFirestoreQuotaError(quotaError());
    noteFirestoreQuotaError(quotaError());
    expect(getQuotaGuardStats().state).toBe("closed");
  });

  it("message d'erreur tronqué à 300 caractères", () => {
    noteFirestoreQuotaError(quotaError("Q".repeat(500)));
    expect(getQuotaGuardStats().lastQuotaError).toHaveLength(300);
  });

  it("resetQuotaGuardForTests vide tout l'état", () => {
    for (let index = 0; index < 3; index += 1) noteFirestoreQuotaError(quotaError());
    shouldShortCircuitFirestore();
    resetQuotaGuardForTests();
    const stats = getQuotaGuardStats();
    expect(stats).toEqual({
      state: "closed",
      consecutiveQuotaErrors: 0,
      openedAt: null,
      lastQuotaErrorAt: null,
      lastQuotaError: null,
      shortCircuits: 0,
      stalls: 0,
      hardQuota: false,
      cooldownEndsAt: null,
    });
    expect(beginFirestoreProbe()).toBe(false);
  });
});

describe("noteFirestoreStall (Task 97 — écritures qui pendent sous quota épuisé)", () => {
  beforeEach(() => resetQuotaGuardForTests());

  it("UN SEUL stall ouvre immédiatement le disjoncteur (signal coûteux = preuve suffisante)", () => {
    noteFirestoreStall("create chatConversations/x: aucune réponse en 6000ms");
    const stats = getQuotaGuardStats();
    expect(stats.state).toBe("open");
    expect(stats.stalls).toBe(1);
    expect(stats.consecutiveQuotaErrors).toBe(1);
    expect(stats.lastQuotaError).toContain("stall:");
    expect(stats.lastQuotaError).toContain("aucune réponse");
    expect(stats.hardQuota).toBe(false);
  });

  it("le stall est classable quota par isFirestoreQuotaError (message synthétique)", () => {
    const synthetic = new Error("create x: aucune réponse en 6000ms (probablement quota Firestore épuisé — bascule vers le repli).");
    expect(isFirestoreQuotaError(synthetic)).toBe(true);
    expect(isFirestoreTransientError(synthetic)).toBe(false);
  });

  it("un succès après un stall referme le circuit et remet les compteurs", () => {
    noteFirestoreStall("get y: aucune réponse en 6000ms");
    expect(getQuotaGuardStats().state).toBe("open");
    noteFirestoreSuccess();
    const stats = getQuotaGuardStats();
    expect(stats.state).toBe("closed");
    expect(stats.consecutiveQuotaErrors).toBe(0);
    expect(stats.hardQuota).toBe(false);
  });
});
