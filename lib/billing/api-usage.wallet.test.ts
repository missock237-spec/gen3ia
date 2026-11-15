import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FACTURATION API — CYCLE FINANCIER RÉEL (demande utilisateur n°9) :
 * runWithApiTokenBilling enchaîné sur les VRAIES primitives du wallet
 * (lib/billing/wallet.ts) au-dessus d'un adminDb factice en mémoire :
 *
 *  1. débit OK — réservation, règlement au réel mesuré, solde et ledger corrects ;
 *  2. solde insuffisant → HttpError 402 AVANT l'exécution, aucun écriture de règlement ;
 *  3. échec d'exécution → libération, aucun règlement ;
 *  4. ledger horodaté : uid, clé API, endpoint, tokens in/out, montant.
 */

const fake = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();

  function doc(path: string) {
    return {
      async get() {
        const data = store.get(path);
        return {
          exists: data !== undefined,
          data: () => data,
          get: (field: string) => (data as Record<string, unknown> | undefined)?.[field],
        };
      },
      async create(value: Record<string, unknown>) {
        if (store.has(path)) throw new Error("already-exists");
        store.set(path, { ...value });
      },
      async update(patch: Record<string, unknown>) {
        const current = store.get(path);
        if (!current) throw new Error("No document to update");
        store.set(path, { ...current, ...patch });
      },
      async set(patch: Record<string, unknown>, _opts?: { merge?: boolean }) {
        store.set(path, { ...(store.get(path) ?? {}), ...patch });
      },
    };
  }

  const adminDb = {
    collection: (name: string) => ({ doc: (id: string) => doc(`${name}/${id}`) }),
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn({
        get: (ref: { get(): Promise<unknown> }) => ref.get(),
        create: (ref: { create(value: unknown): Promise<unknown> }, value: unknown) => ref.create(value),
        set: (ref: { set(value: unknown, opts?: unknown): Promise<unknown> }, value: unknown, opts?: unknown) => ref.set(value, opts),
        update: (ref: { update(value: unknown): Promise<unknown> }, value: unknown) => ref.update(value),
      });
    },
  };

  return { store, adminDb };
});

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: fake.adminDb,
  getAdminApp: vi.fn(),
  getAdminDb: vi.fn(() => fake.adminDb),
}));

import { runWithApiTokenBilling } from "./api-usage";
import { getWallet } from "./wallet";

const WALLET_PATH = "userWallets/user-api-1";

function seedWallet(balanceMinor: number, extra: Record<string, unknown> = {}): void {
  fake.store.set(WALLET_PATH, {
    userId: "user-api-1",
    currency: "XAF",
    balanceMinor,
    reservedMinor: 0,
    welcomeGranted: true,
    welcomeAmountMinor: 300_000,
    // Cooldown d'alerte déjà consommé : aucun effet de bord de notification
    // dans les tests (le comportement d'alerte est couvert par low-balance.test.ts).
    lowBalanceNotifiedAtMs: Date.now(),
    ...extra,
  });
}

function ledgerDoc(reference: string): Record<string, unknown> | undefined {
  return fake.store.get(`walletLedger/${reference}`);
}

function billingParams(executionId: string) {
  return {
    userId: "user-api-1",
    apiKeyId: "keyhash-1",
    apiKeyPrefix: "g3a_Ab12Cd",
    endpoint: "POST /api/v1/agents/{agentId}/run",
    objective: "x",
    executionId,
    fn: async () => ({ status: "completed" }),
  } as const;
}

beforeEach(() => {
  fake.store.clear();
});

describe("runWithApiTokenBilling — cycle financier réel (wallet + ledger)", () => {
  it("débit au réel mesuré : solde décrémenté du montant exact, ledger réservation + règlement", async () => {
    seedWallet(1_000_000);
    // Mesure réelle choisie = estimation (12 000 in / 24 576 out) → aucun clamp.
    const { result, usage } = await runWithApiTokenBilling({
      ...billingParams("exec-fixed-1"),
      measure: () => ({ inputTokens: 12_000, outputTokens: 24_576 }),
    });
    expect(result).toEqual({ status: "completed" });
    expect(usage.billed).toBe(true);
    expect(usage.debitedMinor).toBe(3206);
    expect(usage.charge.chargeMinor).toBe(3206);

    const wallet = await getWallet("user-api-1");
    expect(wallet.balanceMinor).toBe(1_000_000 - 3206);
    expect(wallet.reservedMinor).toBe(0);
    expect(wallet.availableMinor).toBe(1_000_000 - 3206);

    // Ledger de réservation (estimation AVANT exécution).
    const reservation = ledgerDoc("reservation_api_exec-fixed-1");
    expect(reservation).toBeDefined();
    expect(reservation?.type).toBe("reservation");
    expect(reservation?.userId).toBe("user-api-1");
    expect(reservation?.amountMinor).toBe(3206);

    // Ledger de règlement (RÉEL mesuré, tarifs documentés).
    const settlement = ledgerDoc("settlement_api_exec-fixed-1");
    expect(settlement).toBeDefined();
    expect(settlement?.type).toBe("charge");
    expect(settlement?.amountMinor).toBe(3206);
    expect(settlement?.currency).toBe("XAF");
    const metadata = settlement?.metadata as Record<string, string>;
    expect(metadata.source).toBe("api_usage");
    expect(metadata.apiKeyId).toBe("keyhash-1");
    expect(metadata.apiKeyPrefix).toBe("g3a_Ab12Cd");
    expect(metadata.endpoint).toBe("POST /api/v1/agents/{agentId}/run");
    expect(metadata.inputTokens).toBe("12000");
    expect(metadata.outputTokens).toBe("24576");
    expect(metadata.chargeMicroEur).toBe("48864");
    expect(metadata.tariff).toBe("1EUR_per_1M_input_1.5EUR_per_1M_output");
  });

  it("0 token mesuré : aucun débit (charge nulle), règlement à 0 sans perte de réservation", async () => {
    seedWallet(500_000);
    const { usage } = await runWithApiTokenBilling({
      ...billingParams("exec-zero"),
      measure: () => ({ inputTokens: 0, outputTokens: 0 }),
    });
    expect(usage.charge.chargeMinor).toBe(0);
    expect(usage.debitedMinor).toBe(0);
    const wallet = await getWallet("user-api-1");
    expect(wallet.balanceMinor).toBe(500_000);
    expect(wallet.reservedMinor).toBe(0);
    const settlement = ledgerDoc("settlement_api_exec-zero");
    expect(settlement?.amountMinor).toBe(0);
  });

  it("solde insuffisant → HttpError 402 AVANT l'exécution, aucune écriture de règlement", async () => {
    seedWallet(100); // disponible 1,00 FCFA ≪ réservation estimée (32,06 FCFA)
    const fn = vi.fn(async () => ({ status: "completed" }));
    await expect(
      runWithApiTokenBilling({
        ...billingParams("exec-broke"),
        fn,
        measure: () => ({ inputTokens: 10, outputTokens: 10 }),
      }),
    ).rejects.toMatchObject({ status: 402, name: "HttpError" });
    expect(fn).not.toHaveBeenCalled();
    // Aucun ledger de réservation ni de règlement : rien n'a été débité.
    expect(ledgerDoc("reservation_api_exec-broke")).toBeUndefined();
    expect(ledgerDoc("settlement_api_exec-broke")).toBeUndefined();
    const wallet = await getWallet("user-api-1");
    expect(wallet.balanceMinor).toBe(100);
    expect(wallet.reservedMinor).toBe(0);
  });

  it("échec de l'exécution → réservation libérée, solde intact, aucun règlement", async () => {
    seedWallet(1_000_000);
    await expect(
      runWithApiTokenBilling({
        ...billingParams("exec-crash"),
        fn: async () => {
          throw new Error("moteur indisponible");
        },
        measure: () => ({ inputTokens: 99, outputTokens: 99 }),
      }),
    ).rejects.toThrow("moteur indisponible");
    const wallet = await getWallet("user-api-1");
    expect(wallet.balanceMinor).toBe(1_000_000);
    expect(wallet.reservedMinor).toBe(0);
    expect(ledgerDoc("release_api_exec-crash")).toBeDefined();
    expect(ledgerDoc("settlement_api_exec-crash")).toBeUndefined();
  });

  it("idempotence : rejouer le même executionId ne double-débite pas (ledger doc unique)", async () => {
    seedWallet(1_000_000);
    const params = {
      ...billingParams("exec-idem"),
      measure: () => ({ inputTokens: 12_000, outputTokens: 24_576 }),
    };
    await runWithApiTokenBilling(params);
    await runWithApiTokenBilling(params);
    const wallet = await getWallet("user-api-1");
    // Le second passage trouve le ledger déjà écrit (réservation idempotente)
    // : la réservation est ignorée, le règlement aussi → un seul débit.
    expect(wallet.balanceMinor).toBe(1_000_000 - 3206);
  });
});
