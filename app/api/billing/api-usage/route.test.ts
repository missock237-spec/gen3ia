import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/billing/api-usage (demande utilisateur n°9) — contrat HTTP :
 * session obligatoire, solde + tarifs officiels + formule exacte, écritures
 * de ledger « api_usage » (clé API, endpoint, tokens in/out, montant) avec
 * filtre strict et fenêtre honnête (100 dernières écritures du compte).
 */

const verifyMock = vi.fn();
const getWalletMock = vi.fn();
const ledgerQuery = {
  where: vi.fn(),
  orderBy: vi.fn(),
  limit: vi.fn(),
  get: vi.fn(),
};

vi.mock("@/lib/auth/firebase", () => ({
  verifyFirebaseRequest: (...args: unknown[]) => verifyMock(...args),
}));

vi.mock("@/lib/billing/wallet", () => ({
  getWallet: (...args: unknown[]) => getWalletMock(...args),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ledgerQuery),
  },
}));

import { GET } from "./route";

const WALLET = {
  userId: "u-1",
  currency: "XAF",
  balanceMinor: 250_000,
  reservedMinor: 0,
  availableMinor: 250_000,
  updatedAt: 1,
  welcomeGranted: true,
  welcomeAmountMinor: 300_000,
};

function ledgerEntry(id: string, data: Record<string, unknown>) {
  return {
    id,
    data: () => ({ ...data, createdAt: { toMillis: () => 1_700_000_000_000 } }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyMock.mockResolvedValue({ uid: "u-1" });
  getWalletMock.mockResolvedValue(WALLET);
  ledgerQuery.where.mockReturnValue(ledgerQuery);
  ledgerQuery.orderBy.mockReturnValue(ledgerQuery);
  ledgerQuery.limit.mockReturnValue(ledgerQuery);
  ledgerQuery.get.mockResolvedValue({ docs: [] });
});

function request(): Request {
  return new Request("https://gen3ia.local/api/billing/api-usage", { method: "GET" });
}

describe("GET /api/billing/api-usage", () => {
  it("renvoie solde, tarifs officiels, formule et les écritures api_usage filtrées", async () => {
    ledgerQuery.get.mockResolvedValue({
      docs: [
        ledgerEntry("settlement_api_e1", {
          type: "charge",
          amountMinor: 113,
          currency: "XAF",
          reference: "api_e1",
          metadata: {
            source: "api_usage",
            apiKeyPrefix: "g3a_Ab12Cd",
            endpoint: "POST /api/v1/agents/{agentId}/run",
            inputTokens: "1200",
            outputTokens: "340",
            chargeMicroEur: "1710",
            platformAbsorbedMinor: "0",
          },
        }),
        // Écriture NON api_usage (recharge Chariow) : filtrée.
        ledgerEntry("chariow_ref", { type: "topup", amountMinor: 300000, metadata: {} }),
        // Réservation api_usage (pas un débit) : listée, hors total débité.
        ledgerEntry("reservation_api_e1", {
          type: "reservation",
          amountMinor: 3206,
          metadata: { source: "api_usage", apiKeyPrefix: "g3a_Ab12Cd", inputTokens: "0", outputTokens: "0" },
        }),
      ],
    });

    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.wallet.balanceMinor).toBe(250_000);
    expect(body.tariffs).toMatchObject({ inputEurPerMillion: 1, outputEurPerMillion: 1.5, currency: "EUR" });
    expect(body.formula).toMatch(/micro€ = ceil/);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toMatchObject({
      id: "settlement_api_e1",
      type: "charge",
      amountMinor: 113,
      apiKeyPrefix: "g3a_Ab12Cd",
      inputTokens: 1200,
      outputTokens: 340,
      chargeMicroEur: 1710,
    });
    expect(body.totals).toMatchObject({ inputTokens: 1200, outputTokens: 340, debitedMinor: 113 });
    expect(body.window).toEqual({ ledgerEntriesScanned: 3, limit: 100 });
  });

  it("401 quand la session Firebase est absente", async () => {
    verifyMock.mockRejectedValue(new Error("Authentification requise"));
    const response = await GET(request());
    expect(response.status).toBe(401);
  });
});
