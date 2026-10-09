import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests du garde Firestore des files (Task 110-d).
 *
 * Le garde applique aux touches Firestore brutes restantes la doctrine
 * éprouvée de lib/db/firestore-resilient :
 *  - disjoncteur ouvert → rejet IMMÉDIAT quota-classifié, `op` jamais appelé ;
 *  - deadline 6 s (stall) → disjoncteur OUVERT + rejet quota-classifié ;
 *  - succès → disjoncteur refermé ;
 *  - erreur quota réelle → notée au disjoncteur puis rejetée telle quelle ;
 *  - erreur transitoire/métier → rejetée SANS toucher au disjoncteur.
 */

const quotaError = () => Object.assign(new Error("Quota exceeded for quota group 'default'."), { code: 8 });

beforeEach(() => {
  vi.useFakeTimers();
  resetQuotaGuardForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

import {
  getQuotaGuardStats,
  isFirestoreQuotaError,
  noteFirestoreQuotaError,
  resetQuotaGuardForTests,
} from "@/lib/db/quota-guard";
import {
  FIRESTORE_GUARD_TIMEOUT_MS,
  firestoreBreakerError,
  runFirestoreGuarded,
} from "./firestore-guard";

describe("runFirestoreGuarded — disjoncteur", () => {
  it("disjoncteur ouvert → rejet immédiat quota-classifié, op JAMAIS exécuté", async () => {
    // Ouverture : 3 erreurs quota consécutives (seuil QUOTA_BREAKER_OPEN_THRESHOLD).
    noteFirestoreQuotaError(quotaError());
    noteFirestoreQuotaError(quotaError());
    noteFirestoreQuotaError(quotaError());
    expect(getQuotaGuardStats().state).toBe("open");

    const op = vi.fn(async () => "jamais");
    await expect(runFirestoreGuarded("test/ouvert", op)).rejects.toThrow("Firestore sous quota");
    expect(op).not.toHaveBeenCalled();
    // L'erreur du garde est bien quota-classifiée (chemins de reprise existants).
    await runFirestoreGuarded("test/ouvert", async () => "x").catch((error) => {
      expect(isFirestoreQuotaError(error)).toBe(true);
    });
  });

  it("erreur du garde : message portant « Firestore » et « quota » (503 + classification)", async () => {
    noteFirestoreQuotaError(quotaError());
    noteFirestoreQuotaError(quotaError());
    noteFirestoreQuotaError(quotaError());
    const error = await runFirestoreGuarded("test/message", async () => "x").catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("Firestore");
    expect(error.message).toContain("quota");
  });

  it("succès → disjoncteur refermé (sonde half-open consommée puis refermeture)", async () => {
    noteFirestoreQuotaError(quotaError());
    noteFirestoreQuotaError(quotaError());
    noteFirestoreQuotaError(quotaError());
    expect(getQuotaGuardStats().state).toBe("open");
    // Cooldown logiciel écoulé : le circuit passe half-open et laisse partir
    // l'unique sonde — le succès la referme.
    await vi.advanceTimersByTimeAsync(90_001);
    await expect(runFirestoreGuarded("test/succes", async () => 42)).resolves.toBe(42);
    expect(getQuotaGuardStats().state).toBe("closed");
  });
});

describe("runFirestoreGuarded — deadline anti-stall", () => {
  it("écriture qui ne répond JAMAIS → stall, disjoncteur ouvert, rejet quota-classifié au délai", async () => {
    const op = vi.fn(() => new Promise<string>(() => undefined)); // pend indéfiniment (quota quotidien, Task 97)
    const pending = runFirestoreGuarded("test/stall", op).then(
      () => "resolved" as const,
      (error: Error) => `rejected: ${error.message}` as const,
    );
    const outcome = await Promise.race([
      pending,
      vi.advanceTimersByTimeAsync(FIRESTORE_GUARD_TIMEOUT_MS + 500).then(() => "timeout" as const),
    ]);
    // Le garde ne pend PAS : il rejette au délai et ouvre le disjoncteur.
    expect(outcome).toMatch(/^rejected:/);
    expect(outcome).toContain("quota");
    expect(getQuotaGuardStats().state).toBe("open");
    expect(getQuotaGuardStats().stalls).toBe(1);
  });

  it("réponse dans le délai → résultat transmis, aucun stall", async () => {
    const op = vi.fn(async () => "ok");
    const pending = runFirestoreGuarded("test/lent-ok", op).then(
      () => "resolved" as const,
      (error: Error) => `rejected: ${error.message}` as const,
    );
    const outcome = await Promise.race([
      pending,
      vi.advanceTimersByTimeAsync(1_000).then(() => "timeout" as const),
    ]);
    expect(outcome).toBe("resolved");
    expect(getQuotaGuardStats().stalls).toBe(0);
  });
});

describe("runFirestoreGuarded — classification des erreurs", () => {
  it("erreur quota réelle → notée au disjoncteur puis rejetée telle quelle", async () => {
    const failure = quotaError();
    await expect(runFirestoreGuarded("test/quota", async () => { throw failure; })).rejects.toBe(failure);
    expect(getQuotaGuardStats().consecutiveQuotaErrors).toBe(1);
  });

  it("erreur transitoire/métier → rejetée SANS toucher au disjoncteur", async () => {
    await expect(runFirestoreGuarded("test/metier", async () => { throw new Error("Permission denied on document"); })).rejects.toThrow("Permission denied");
    await expect(runFirestoreGuarded("test/transitoire", async () => { throw new Error("UNAVAILABLE: backend down"); })).rejects.toThrow("UNAVAILABLE");
    const stats = getQuotaGuardStats();
    expect(stats.consecutiveQuotaErrors).toBe(0);
    expect(stats.state).toBe("closed");
  });
});

describe("firestoreBreakerError", () => {
  it("message quota-classifié (contrat de reprise des appelants)", () => {
    const error = firestoreBreakerError();
    expect(isFirestoreQuotaError(error)).toBe(true);
  });
});
