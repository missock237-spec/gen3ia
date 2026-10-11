import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MARKETPLACE — SANDBOX D'ÉVALUATION D'EXTENSIONS (Task 132) :
 *  - startExtensionTrial : démarrage nominal (installation standard +
 *    marquage + plafonds figés), durées (défaut 48 h, env, explicite),
 *    double essai rejeté, version complète déjà installée, extension non
 *    approuvée, essai échu purgé puis remplaçable ;
 *  - assertTrialActive (pur) : expiration, plafonds, absences ;
 *  - recordTrialUsage : compteurs plafonnés, refus au plafond ;
 *  - expireTrials : purge fail-soft + idempotence + version complète
 *    achetée pendant l'essai conservée.
 *
 * Mocks adminDb selon le pattern agent-listings.test.ts / hire.test.ts.
 */

const mocks = vi.hoisted(() => {
  const makeDoc = () => ({ get: vi.fn(), set: vi.fn() });
  return {
    trialDoc: makeDoc(), // extensionTrials/{extensionId}__{userId}
    installationDoc: makeDoc(), // extensionInstallations/{extensionId}__{userId}
    queryGet: vi.fn(), // scan expireTrials
    runTransaction: vi.fn(),
    collection: vi.fn((name: string) => ({
      doc: vi.fn(() => (name === "extensionTrials" ? mocks.trialDoc : mocks.installationDoc)),
      where: vi.fn(() => ({ limit: vi.fn(() => ({ get: mocks.queryGet })) })),
    })),
    // lib/extensions/repository
    getExtension: vi.fn(),
    getInstallation: vi.fn(),
    getLatestApprovedVersion: vi.fn(),
    installExtension: vi.fn(),
    uninstallExtension: vi.fn(),
  };
});

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: mocks.collection,
    runTransaction: (...args: unknown[]) => mocks.runTransaction(...args),
  },
}));

vi.mock("@/lib/extensions/repository", () => ({
  getExtension: mocks.getExtension,
  getInstallation: mocks.getInstallation,
  getLatestApprovedVersion: mocks.getLatestApprovedVersion,
  installExtension: mocks.installExtension,
  uninstallExtension: mocks.uninstallExtension,
}));

import {
  DEFAULT_TRIAL_HOURS,
  TRIAL_MAX_EXECUTIONS,
  TRIAL_MAX_TOOL_CALLS,
  TrialError,
  assertTrialActive,
  expireTrials,
  recordTrialUsage,
  resolveTrialHours,
  startExtensionTrial,
  type ExtensionTrial,
} from "./sandbox";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function extensionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "ext-sante",
    name: "Extension Santé",
    description: "Une extension de test.",
    category: "productivity",
    tags: [],
    developerId: "dev-1",
    developerName: "Développeur",
    projectId: "proj-1",
    status: "approved",
    permissions: ["storage.read"],
    pricing: { model: "free" },
    latestVersion: "1.2.0",
    approvedVersion: "1.2.0",
    stats: { installs: 0, ratingSum: 0, ratingCount: 0, executions: 0 },
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

function approvedVersionFixture() {
  return {
    id: "ext-sante@1.2.0",
    extensionId: "ext-sante",
    version: "1.2.0",
    changelog: "",
    status: "approved",
    manifest: {
      id: "ext-sante",
      name: "Extension Santé",
      version: "1.2.0",
      author: "dev",
      description: "desc",
      category: "productivity",
      permissions: ["storage.read", "memory.read"],
      settings: [{ key: "langue", label: "Langue", type: "string", default: "fr" }],
      pricing: { model: "free" },
    },
    createdAt: 1,
  };
}

function trialFixture(overrides: Record<string, unknown> = {}): ExtensionTrial {
  const now = Date.now();
  return {
    id: "ext-sante__user-1",
    extensionId: "ext-sante",
    userId: "user-1",
    status: "active",
    trial: true,
    hours: 48,
    startedAt: now,
    trialExpiresAt: now + 48 * 3_600_000,
    usage: { toolCalls: 0, executions: 0 },
    limits: { maxToolCalls: TRIAL_MAX_TOOL_CALLS, maxExecutions: TRIAL_MAX_EXECUTIONS },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ExtensionTrial;
}

/** Transaction simulée : tx.get/tx.set délèguent aux docs mockés. */
function inTransaction() {
  mocks.runTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      get: (ref: { get: () => Promise<unknown> }) => ref.get(),
      set: (ref: { set: (...args: unknown[]) => unknown }, data: unknown, opts: unknown) =>
        ref.set(data, ...(opts === undefined ? [] : [opts])),
    }),
  );
}

beforeEach(() => {
  mocks.trialDoc.get.mockReset().mockResolvedValue({ exists: false, data: () => undefined });
  mocks.trialDoc.set.mockReset();
  mocks.installationDoc.get.mockReset();
  mocks.installationDoc.set.mockReset();
  mocks.queryGet.mockReset().mockResolvedValue({ docs: [] });
  mocks.runTransaction.mockReset();
  mocks.collection.mockClear();
  mocks.getExtension.mockReset().mockResolvedValue(extensionFixture());
  mocks.getInstallation.mockReset().mockResolvedValue(null);
  mocks.getLatestApprovedVersion.mockReset().mockResolvedValue(approvedVersionFixture());
  mocks.installExtension.mockReset().mockResolvedValue({ id: "ext-sante__user-1", status: "active" });
  mocks.uninstallExtension.mockReset().mockResolvedValue(undefined);
  delete process.env.EXTENSION_TRIAL_HOURS;
});

/* ------------------------------------------------------------------ */
/* resolveTrialHours (pur)                                             */
/* ------------------------------------------------------------------ */

describe("resolveTrialHours (pur)", () => {
  it("défaut : 48 heures", () => {
    expect(resolveTrialHours()).toBe(48);
    expect(DEFAULT_TRIAL_HOURS).toBe(48);
  });

  it("EXTENSION_TRIAL_HOURS respectée quand elle est valide", () => {
    process.env.EXTENSION_TRIAL_HOURS = "24";
    expect(resolveTrialHours()).toBe(24);
  });

  it("env invalide ou hors bornes → repli 48 h", () => {
    process.env.EXTENSION_TRIAL_HOURS = "abc";
    expect(resolveTrialHours()).toBe(48);
    process.env.EXTENSION_TRIAL_HOURS = "0";
    expect(resolveTrialHours()).toBe(48);
  });

  it("paramètre explicite prioritaire ; invalide → erreur claire", () => {
    expect(resolveTrialHours(2)).toBe(2);
    expect(() => resolveTrialHours(0)).toThrowError(TrialError);
    expect(() => resolveTrialHours(1.5)).toThrowError(/nombre entier d'heures/);
  });
});

/* ------------------------------------------------------------------ */
/* assertTrialActive (pur)                                             */
/* ------------------------------------------------------------------ */

describe("assertTrialActive (pur)", () => {
  it("essai valide → aucune erreur", () => {
    expect(() => assertTrialActive(trialFixture())).not.toThrow();
  });

  it("aucun essai → trial_missing", () => {
    expect(() => assertTrialActive(null)).toThrowError(/Aucune évaluation n'est en cours/);
    expect(() => assertTrialActive(null)).toThrowError(TrialError);
  });

  it("statut « expired » → trial_inactive", () => {
    const error = capture(() => assertTrialActive(trialFixture({ status: "expired" })));
    expect(error).toBeInstanceOf(TrialError);
    expect(error?.code).toBe("trial_inactive");
  });

  it("expiration par le temps → trial_expired (message honnête, version complète)", () => {
    const trial = trialFixture({ trialExpiresAt: Date.now() - 1 });
    const error = capture(() => assertTrialActive(trial));
    expect(error?.code).toBe("trial_expired");
    expect(error?.message).toMatch(/période d'évaluation est terminée.*version complète/s);
  });

  it("plafond d'appels d'outils atteint → trial_quota_tools", () => {
    const trial = trialFixture({ usage: { toolCalls: TRIAL_MAX_TOOL_CALLS, executions: 0 } });
    const error = capture(() => assertTrialActive(trial));
    expect(error?.code).toBe("trial_quota_tools");
    expect(error?.message).toContain(String(TRIAL_MAX_TOOL_CALLS));
  });

  it("plafond d'exécutions atteint → trial_quota_executions", () => {
    const trial = trialFixture({ usage: { toolCalls: 0, executions: TRIAL_MAX_EXECUTIONS } });
    const error = capture(() => assertTrialActive(trial));
    expect(error?.code).toBe("trial_quota_executions");
    expect(error?.message).toContain(String(TRIAL_MAX_EXECUTIONS));
  });

  it("statut HTTP recommandé porté par l'erreur typée", () => {
    expect(capture(() => assertTrialActive(null))?.status).toBe(404);
    expect(capture(() => assertTrialActive(trialFixture({ trialExpiresAt: 1 })))?.status).toBe(403);
  });
});

function capture(fn: () => void): TrialError | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error as TrialError;
  }
}

/* ------------------------------------------------------------------ */
/* startExtensionTrial                                                 */
/* ------------------------------------------------------------------ */

describe("startExtensionTrial (mocks adminDb + dépôt extensions)", () => {
  it("démarrage nominal : installation standard + marquage + essai plafonné", async () => {
    const avant = Date.now();
    const trial = await startExtensionTrial({ userId: "user-1", extensionId: "ext-sante" });

    // Installation via la MÉCANIQUE STANDARD (version approuvée, permissions
    // et réglages du manifest — même contrat que la route d'installation).
    expect(mocks.installExtension).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        version: "1.2.0",
        permissionsGranted: ["storage.read", "memory.read"],
        settings: { langue: "fr" },
      }),
    );

    // Marquage visible pour l'UI sur le document d'installation.
    expect(mocks.installationDoc.set).toHaveBeenCalledWith(
      expect.objectContaining({ trial: true }),
      { merge: true },
    );

    // Document d'essai : actif, compteurs à zéro, plafonds figés.
    expect(trial.status).toBe("active");
    expect(trial.trial).toBe(true);
    expect(trial.usage).toEqual({ toolCalls: 0, executions: 0 });
    expect(trial.limits).toEqual({ maxToolCalls: 50, maxExecutions: 20 });
    expect(mocks.trialDoc.set).toHaveBeenCalledWith(expect.objectContaining({ id: "ext-sante__user-1", status: "active" }));

    // Expiration par défaut : ~48 h (tolérance d'exécution).
    expect(trial.trialExpiresAt).toBeGreaterThanOrEqual(avant + 48 * 3_600_000 - 5_000);
    expect(trial.trialExpiresAt).toBeLessThanOrEqual(Date.now() + 48 * 3_600_000 + 5_000);
  });

  it("durée explicite respectée (2 h)", async () => {
    const avant = Date.now();
    const trial = await startExtensionTrial({ userId: "user-1", extensionId: "ext-sante", hours: 2 });
    expect(trial.hours).toBe(2);
    expect(trial.trialExpiresAt).toBeGreaterThanOrEqual(avant + 2 * 3_600_000 - 5_000);
    expect(trial.trialExpiresAt).toBeLessThanOrEqual(Date.now() + 2 * 3_600_000 + 5_000);
  });

  it("extension non approuvée → refus clair, aucune installation", async () => {
    mocks.getExtension.mockResolvedValue(extensionFixture({ status: "pending" }));
    await expect(startExtensionTrial({ userId: "user-1", extensionId: "ext-sante" })).rejects.toMatchObject({
      code: "trial_unavailable",
    });
    expect(mocks.installExtension).not.toHaveBeenCalled();
  });

  it("aucune version approuvée → refus clair", async () => {
    mocks.getLatestApprovedVersion.mockResolvedValue(null);
    await expect(startExtensionTrial({ userId: "user-1", extensionId: "ext-sante" })).rejects.toMatchObject({
      code: "trial_unavailable",
    });
  });

  it("double essai simultané rejeté (erreur claire, pas de nouvelle installation)", async () => {
    mocks.trialDoc.get.mockResolvedValue({ exists: true, data: () => trialFixture() });
    await expect(startExtensionTrial({ userId: "user-1", extensionId: "ext-sante" })).rejects.toMatchObject({
      code: "trial_conflict",
    });
    expect(mocks.installExtension).not.toHaveBeenCalled();
    expect(mocks.trialDoc.set).not.toHaveBeenCalled();
  });

  it("version complète déjà installée → refus honnête", async () => {
    mocks.getInstallation.mockResolvedValue({ id: "ext-sante__user-1", status: "active", trial: undefined });
    await expect(startExtensionTrial({ userId: "user-1", extensionId: "ext-sante" })).rejects.toMatchObject({
      code: "trial_conflict",
    });
    expect(mocks.installExtension).not.toHaveBeenCalled();
  });

  it("essai échu au moment de la relance : purgé puis remplacé", async () => {
    // Essai « actif » mais échu depuis 1 h + installation d'essai active.
    mocks.trialDoc.get.mockResolvedValue({
      exists: true,
      data: () => trialFixture({ status: "active", trialExpiresAt: Date.now() - 3_600_000 }),
    });
    mocks.getInstallation.mockResolvedValue({ id: "ext-sante__user-1", status: "active", trial: true });
    inTransaction();
    const trial = await startExtensionTrial({ userId: "user-1", extensionId: "ext-sante" });
    // L'ancien essai a été expiré (CAS) et l'installation d'évaluation désinstallée.
    expect(mocks.trialDoc.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "expired" }),
      { merge: true },
    );
    expect(mocks.uninstallExtension).toHaveBeenCalledWith("ext-sante", "user-1");
    // Le nouvel essai repart sur des compteurs à zéro.
    expect(trial.status).toBe("active");
    expect(trial.usage).toEqual({ toolCalls: 0, executions: 0 });
  });

  it("identifiants vides → erreur typée", async () => {
    await expect(startExtensionTrial({ userId: "  ", extensionId: "ext-sante" })).rejects.toMatchObject({
      code: "trial_invalid",
    });
    await expect(startExtensionTrial({ userId: "user-1", extensionId: "" })).rejects.toMatchObject({
      code: "trial_invalid",
    });
  });
});

/* ------------------------------------------------------------------ */
/* recordTrialUsage                                                    */
/* ------------------------------------------------------------------ */

describe("recordTrialUsage (compteurs plafonnés)", () => {
  it("aucun essai → null (installation complète : rien à compter)", async () => {
    mocks.trialDoc.get.mockResolvedValue({ exists: false, data: () => undefined });
    await expect(recordTrialUsage({ userId: "user-1", extensionId: "ext-sante", toolCalls: 3 })).resolves.toBeNull();
    expect(mocks.trialDoc.set).not.toHaveBeenCalled();
  });

  it("incrémente les compteurs dans les limites", async () => {
    mocks.trialDoc.get.mockResolvedValue({
      exists: true,
      data: () => trialFixture({ usage: { toolCalls: 10, executions: 4 } }),
    });
    inTransaction();
    const updated = await recordTrialUsage({ userId: "user-1", extensionId: "ext-sante", toolCalls: 5, executions: 2 });
    expect(updated?.usage).toEqual({ toolCalls: 15, executions: 6 });
    expect(mocks.trialDoc.set).toHaveBeenCalledWith(expect.objectContaining({ usage: { toolCalls: 15, executions: 6 } }));
  });

  it("PLAFOND : 49 appels + 5 → compteur bloqué à 50 (jamais dépassé)", async () => {
    mocks.trialDoc.get.mockResolvedValue({
      exists: true,
      data: () => trialFixture({ usage: { toolCalls: 49, executions: 3 } }),
    });
    inTransaction();
    const updated = await recordTrialUsage({ userId: "user-1", extensionId: "ext-sante", toolCalls: 5 });
    expect(updated?.usage.toolCalls).toBe(50);
    expect(updated?.usage.executions).toBe(3);
  });

  it("PLAFOND : 18 exécutions + 5 → compteur bloqué à 20", async () => {
    mocks.trialDoc.get.mockResolvedValue({
      exists: true,
      data: () => trialFixture({ usage: { toolCalls: 3, executions: 18 } }),
    });
    inTransaction();
    const updated = await recordTrialUsage({ userId: "user-1", extensionId: "ext-sante", executions: 5 });
    expect(updated?.usage.executions).toBe(20);
  });

  it("plafond déjà atteint → erreur typée AVANT toute écriture", async () => {
    mocks.trialDoc.get.mockResolvedValue({
      exists: true,
      data: () => trialFixture({ usage: { toolCalls: 50, executions: 0 } }),
    });
    await expect(recordTrialUsage({ userId: "user-1", extensionId: "ext-sante", toolCalls: 1 })).rejects.toMatchObject({
      code: "trial_quota_tools",
    });
    expect(mocks.trialDoc.set).not.toHaveBeenCalled();
  });

  it("essai expiré par le temps → refus honnête", async () => {
    mocks.trialDoc.get.mockResolvedValue({
      exists: true,
      data: () => trialFixture({ trialExpiresAt: Date.now() - 1 }),
    });
    await expect(recordTrialUsage({ userId: "user-1", extensionId: "ext-sante", executions: 1 })).rejects.toMatchObject({
      code: "trial_expired",
    });
  });

  it("delta nul → simple lecture, aucune écriture", async () => {
    mocks.trialDoc.get.mockResolvedValue({ exists: true, data: () => trialFixture() });
    const trial = await recordTrialUsage({ userId: "user-1", extensionId: "ext-sante" });
    expect(trial?.status).toBe("active");
    expect(mocks.trialDoc.set).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* expireTrials                                                        */
/* ------------------------------------------------------------------ */

describe("expireTrials (fail-soft + idempotence)", () => {
  function scanDocs(...trials: ExtensionTrial[]) {
    mocks.queryGet.mockResolvedValue({ docs: trials.map((trial) => ({ id: trial.id, data: () => trial })) });
  }

  it("expire uniquement les essais actifs échus et désinstalle l'installation d'essai", async () => {
    scanDocs(
      trialFixture({ id: "a__user-1", extensionId: "a" }), // actif et NON échu → ignoré
      trialFixture({ id: "b__user-1", extensionId: "b", status: "expired" }), // déjà terminal → ignoré
      trialFixture({ id: "c__user-1", extensionId: "c", trialExpiresAt: Date.now() - 1_000 }), // à expirer
    );
    // La transaction CAS relit le doc d'essai (renvoyer l'état actif).
    mocks.trialDoc.get.mockResolvedValue({ exists: true, data: () => trialFixture({ id: "c__user-1", extensionId: "c", trialExpiresAt: Date.now() - 1_000 }) });
    mocks.getInstallation.mockResolvedValue({ id: "c__user-1", status: "active", trial: true });
    inTransaction();

    const expired = await expireTrials("user-1");
    expect(expired).toBe(1);
    expect(mocks.trialDoc.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "expired" }),
      { merge: true },
    );
    expect(mocks.uninstallExtension).toHaveBeenCalledWith("c", "user-1");
  });

  it("version complète achetée PENDANT l'essai → conservée (pas de désinstallation)", async () => {
    scanDocs(trialFixture({ id: "c__user-1", extensionId: "c", trialExpiresAt: Date.now() - 1_000 }));
    mocks.trialDoc.get.mockResolvedValue({ exists: true, data: () => trialFixture({ id: "c__user-1", extensionId: "c", trialExpiresAt: Date.now() - 1_000 }) });
    mocks.getInstallation.mockResolvedValue({ id: "c__user-1", status: "active", trial: false });
    inTransaction();

    const expired = await expireTrials("user-1");
    expect(expired).toBe(1);
    expect(mocks.trialDoc.set).toHaveBeenCalledWith(expect.objectContaining({ status: "expired" }), { merge: true });
    expect(mocks.uninstallExtension).not.toHaveBeenCalled();
  });

  it("race défensive : un essai REMPLACÉ par un essai frais pendant la purge n'est pas expiré", async () => {
    scanDocs(trialFixture({ id: "c__user-1", extensionId: "c", trialExpiresAt: Date.now() - 1_000 }));
    // Entre le scan et la transaction CAS, le document a été remplacé par un
    // essai ACTIF non échu (relance concurrente) → l'expiration est refusée.
    mocks.trialDoc.get.mockResolvedValue({ exists: true, data: () => trialFixture({ id: "c__user-1", extensionId: "c" }) });
    inTransaction();

    const expired = await expireTrials("user-1");
    expect(expired).toBe(0);
    expect(mocks.trialDoc.set).not.toHaveBeenCalled();
    expect(mocks.uninstallExtension).not.toHaveBeenCalled();
  });

  it("idempotence : un second passage ne retraite rien", async () => {
    scanDocs(trialFixture({ id: "c__user-1", extensionId: "c", status: "expired" }));
    const expired = await expireTrials("user-1");
    expect(expired).toBe(0);
    expect(mocks.trialDoc.set).not.toHaveBeenCalled();
    expect(mocks.uninstallExtension).not.toHaveBeenCalled();
  });

  it("échec de scan → fail-soft : 0, aucune exception", async () => {
    mocks.queryGet.mockRejectedValue(new Error("Firestore indisponible"));
    await expect(expireTrials("user-1")).resolves.toBe(0);
  });

  it("échec de la désinstallation → essai quand même expiré, pas d'exception", async () => {
    scanDocs(trialFixture({ id: "c__user-1", extensionId: "c", trialExpiresAt: Date.now() - 1_000 }));
    mocks.trialDoc.get.mockResolvedValue({ exists: true, data: () => trialFixture({ id: "c__user-1", extensionId: "c", trialExpiresAt: Date.now() - 1_000 }) });
    mocks.getInstallation.mockResolvedValue({ id: "c__user-1", status: "active", trial: true });
    mocks.uninstallExtension.mockRejectedValue(new Error("R2 indisponible"));
    inTransaction();

    await expect(expireTrials("user-1")).resolves.toBe(1);
    expect(mocks.trialDoc.set).toHaveBeenCalledWith(expect.objectContaining({ status: "expired" }), { merge: true });
  });

  it("utilisateur vide → 0 (aucun appel)", async () => {
    await expect(expireTrials("  ")).resolves.toBe(0);
    expect(mocks.queryGet).not.toHaveBeenCalled();
  });
});
