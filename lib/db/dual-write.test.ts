import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests du module de double-écriture Firestore ⇄ Supabase (Task 43, P2).
 *
 * Couverture : parsing du flag DUAL_WRITE_DOMAINS, gardes d'activation
 * (Supabase configuré, backend primaire), sémantique best-effort du miroir
 * (jamais de levée), accumulation des statistiques.
 */

const configMock = vi.hoisted(() => ({ configured: true }));
const backendMock = vi.hoisted(() => ({ supabase: false }));
const loggerMock = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("@/lib/supabase/config", () => ({
  isSupabaseAdminConfigured: () => configMock.configured,
  getSupabaseConfig: () => (configMock.configured ? { url: "u", anonKey: "a", serviceRoleKey: "s" } : null),
}));

vi.mock("@/lib/db/driver", () => ({
  isSupabaseBackend: () => backendMock.supabase,
}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { warn: loggerMock.warn },
}));

import {
  getDualWriteDomains,
  getDualWriteStats,
  isDualWriteEnabled,
  mirrorToSupabase,
  parseDualWriteDomains,
  resetDualWriteForTests,
} from "./dual-write";

describe("parseDualWriteDomains (flag CSV)", () => {
  it("défaut : ensemble vide quand la variable est absente ou vide", () => {
    expect(parseDualWriteDomains(undefined)).toEqual(new Set());
    expect(parseDualWriteDomains("")).toEqual(new Set());
    expect(parseDualWriteDomains("   ")).toEqual(new Set());
  });

  it("parse une liste CSV avec espaces et casse mixte", () => {
    expect(parseDualWriteDomains(" Notifications , ARTIFACTS , conversations ")).toEqual(
      new Set(["notifications", "artifacts", "conversations"]),
    );
  });

  it("ignore les entrées vides en excès (double virgule)", () => {
    expect(parseDualWriteDomains("notifications,,artifacts")).toEqual(new Set(["notifications", "artifacts"]));
  });

  it("filtre les domaines inconnus (typo = jamais inscrit silencieusement)", () => {
    expect(parseDualWriteDomains("notifications,notifiations,wallet")).toEqual(
      new Set(["notifications", "wallet"]),
    );
  });
});

describe("isDualWriteEnabled (gardes d'activation)", () => {
  beforeEach(() => {
    resetDualWriteForTests();
    configMock.configured = true;
    backendMock.supabase = false;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("désactivé par défaut (aucun domaine inscrit)", () => {
    vi.stubEnv("DUAL_WRITE_DOMAINS", undefined as unknown as string);
    expect(isDualWriteEnabled("notifications")).toBe(false);
  });

  it("activé quand le domaine est inscrit, Supabase configuré et Firestore primaire", () => {
    vi.stubEnv("DUAL_WRITE_DOMAINS", "notifications");
    expect(isDualWriteEnabled("notifications")).toBe(true);
    expect(isDualWriteEnabled("artifacts")).toBe(false);
  });

  it("désactivé quand Supabase n'est pas configuré (garde anti-échec)", () => {
    vi.stubEnv("DUAL_WRITE_DOMAINS", "notifications");
    configMock.configured = false;
    expect(isDualWriteEnabled("notifications")).toBe(false);
  });

  it("désactivé quand le backend primaire est déjà Supabase (pas de double écriture absurde)", () => {
    vi.stubEnv("DUAL_WRITE_DOMAINS", "notifications");
    backendMock.supabase = true;
    expect(isDualWriteEnabled("notifications")).toBe(false);
  });

  it("getDualWriteDomains reflète la variable (diagnostic sans secret)", () => {
    vi.stubEnv("DUAL_WRITE_DOMAINS", "notifications,wallet");
    expect(getDualWriteDomains()).toEqual(["notifications", "wallet"]);
  });
});

describe("mirrorToSupabase (best-effort + statistiques)", () => {
  beforeEach(() => {
    resetDualWriteForTests();
    configMock.configured = true;
    backendMock.supabase = false;
    loggerMock.warn.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skipped sans exécuter l'opération quand le domaine est inactif (coût nul)", async () => {
    vi.stubEnv("DUAL_WRITE_DOMAINS", undefined as unknown as string);
    let called = false;
    const outcome = await mirrorToSupabase("notifications", async () => {
      called = true;
    });
    expect(outcome.status).toBe("skipped");
    expect(called).toBe(false);
    expect(getDualWriteStats()["notifications"]).toBeUndefined();
  });

  it("ok : l'opération s'exécute et le compteur de succès monte", async () => {
    vi.stubEnv("DUAL_WRITE_DOMAINS", "notifications");
    const outcome = await mirrorToSupabase("notifications", async () => undefined);
    expect(outcome.status).toBe("ok");
    const stats = getDualWriteStats()["notifications"];
    expect(stats).toMatchObject({ attempted: 1, ok: 1, failed: 0 });
  });

  it("failed : une erreur de miroir est JAMAIS levée (journalisée + comptée)", async () => {
    vi.stubEnv("DUAL_WRITE_DOMAINS", "notifications");
    const outcome = await mirrorToSupabase("notifications", async () => {
      throw new Error("pg indisponible");
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("pg indisponible");
    const stats = getDualWriteStats()["notifications"];
    expect(stats).toMatchObject({ attempted: 1, ok: 0, failed: 1 });
    expect(stats.lastError).toContain("pg indisponible");
    expect(stats.lastErrorAt).toBeTruthy();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "notifications" }),
      "dual_write_mirror_failed",
    );
  });

  it("les statistiques s'accumulent par domaine indépendamment", async () => {
    vi.stubEnv("DUAL_WRITE_DOMAINS", "notifications,artifacts");
    await mirrorToSupabase("notifications", async () => undefined);
    await mirrorToSupabase("notifications", async () => undefined);
    await mirrorToSupabase("artifacts", async () => {
      throw new Error("x");
    });
    expect(getDualWriteStats()["notifications"]).toMatchObject({ attempted: 2, ok: 2 });
    expect(getDualWriteStats()["artifacts"]).toMatchObject({ attempted: 1, failed: 1 });
  });

  it("resetDualWriteForTests vide les compteurs et force la re-résolution de l'env", async () => {
    vi.stubEnv("DUAL_WRITE_DOMAINS", "notifications");
    await mirrorToSupabase("notifications", async () => undefined);
    resetDualWriteForTests();
    expect(getDualWriteStats()).toEqual({});
    // Le cache est purgé : les domaines sont relus depuis l'env (toujours
    // stubbé ici) — même valeur, mais re-parsée.
    expect(getDualWriteDomains()).toEqual(["notifications"]);
  });

  it("resetDualWriteForTests : sans env, les domaines repassent vides", async () => {
    vi.stubEnv("DUAL_WRITE_DOMAINS", "notifications");
    expect(getDualWriteDomains()).toEqual(["notifications"]);
    vi.stubEnv("DUAL_WRITE_DOMAINS", undefined as unknown as string);
    resetDualWriteForTests();
    expect(getDualWriteDomains()).toEqual([]);
  });
});
