import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SYSTÈME PUBLICITAIRE AVANCÉ :
 *  - ciblage par mots-clés ACTIF (campagne déclarée → contexte requis) ;
 *  - garde de budget quotidien RÉEL (CPM ; fail-closed sur panne) ;
 *  - anti-fraude : doc-ids déterministes (1 impression/user/jour,
 *    1 clic/user/heure), UUID uniquement pour l'anonyme.
 */

// Chaînable : where().where()…limit().get() — chaque appel renvoie l'API.
const queryGet = vi.fn();
function makeChain() {
  const api = {
    where: vi.fn(() => api),
    limit: vi.fn(() => api),
    get: vi.fn(() => queryGet()),
  };
  return api;
}
let chains: Array<{ docId: string | undefined; set: ReturnType<typeof vi.fn> }>;
const docSet = vi.fn(async () => undefined);

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => {
      const chain = makeChain();
      const entry = { docId: undefined as string | undefined, set: docSet };
      chains.push(entry);
      return {
        where: chain.where,
        limit: chain.limit,
        get: chain.get,
        doc: vi.fn((id: string) => {
          entry.docId = id;
          return { id, set: entry.set };
        }),
      };
    }),
  },
}));

import { isWithinDailyBudget, passesTargeting, type AdCampaign } from "./campaigns";
import { recordPlatformAdEvent } from "./platform-placement";

function campaign(overrides: Partial<AdCampaign> = {}): AdCampaign {
  return {
    id: "c1",
    ownerId: "admin-1",
    name: "Campagne test",
    objective: "traffic",
    status: "active",
    dailyBudgetMinor: 5_000,
    currency: "XAF",
    bidStrategy: "balanced",
    frequencyCapPerDay: 5,
    targeting: { placements: ["settings"], keywords: ["crm", "ventes"] },
    creatives: [{ headline: "H", targetUrl: "https://gen3ia.online" }],
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    ...overrides,
  } as unknown as AdCampaign;
}

beforeEach(() => {
  queryGet.mockReset();
  docSet.mockClear();
  chains = [];
});

describe("passesTargeting — mots-clés", () => {
  it("campagne sans mots-clés déclarés : servie dans tous les contextes (inchangé)", () => {
    expect(passesTargeting({
      campaign: campaign({ targeting: { placements: ["settings"] } }),
      placement: "settings",
      context: {},
    })).toBe(true);
  });

  it("campagne AVEC mots-clés : servie seulement si le contexte en fournit un", () => {
    const params = { campaign: campaign(), placement: "settings" };
    expect(passesTargeting({ ...params, context: {} })).toBe(false);
    expect(passesTargeting({ ...params, context: { keywords: ["comptabilité"] } })).toBe(false);
    expect(passesTargeting({ ...params, context: { keywords: ["CRM", "support"] } })).toBe(true);
    // Correspondance par inclusion (mot-clé contenu dans un token du contexte)
    expect(passesTargeting({ ...params, context: { keywords: ["meilleur-crm-2026"] } })).toBe(true);
  });
});

describe("isWithinDailyBudget — budget quotidien réel", () => {
  it("sous le budget : diffusion autorisée ; au-delà : bloquée", async () => {
    queryGet
      .mockResolvedValueOnce({ docs: [{ id: "ad-1" }] })
      .mockResolvedValue({ size: 9_000 }); // 9 000 imp × 500/1000 = 4 500 < 5 000
    expect(await isWithinDailyBudget(campaign())).toBe(true);

    queryGet
      .mockReset()
      .mockResolvedValueOnce({ docs: [{ id: "ad-1" }] })
      .mockResolvedValue({ size: 11_000 }); // 5 500 ≥ 5 000
    expect(await isWithinDailyBudget(campaign())).toBe(false);
  });

  it("sans budget journalier déclaré : pas de garde (aucune requête)", async () => {
    expect(await isWithinDailyBudget(campaign({ dailyBudgetMinor: 0 }))).toBe(true);
    expect(queryGet).not.toHaveBeenCalled();
  });

  it("panne de lecture : fail-closed (jamais de sur-diffusion facturée)", async () => {
    queryGet.mockRejectedValue(new Error("firestore down"));
    expect(await isWithinDailyBudget(campaign())).toBe(false);
  });
});

describe("recordPlatformAdEvent — anti-fraude", () => {
  it("impression authentifiée : doc-id DÉTERMINISTE cli/imp préfixé", async () => {
    await recordPlatformAdEvent({ adId: "ad-1", placement: "settings", type: "impression", userId: "u1" });
    expect(chains[0]?.docId).toMatch(/^imp_/);
  });

  it("deux clics du même utilisateur/annonce/heure → même doc (écrasement, pas double comptage)", async () => {
    await recordPlatformAdEvent({ adId: "ad-1", placement: "settings", type: "click", userId: "u1" });
    await recordPlatformAdEvent({ adId: "ad-1", placement: "settings", type: "click", userId: "u1" });
    const ids = chains.map((entry) => entry.docId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toMatch(/^cli_/);
  });

  it("clics sur deux annonces différentes → doc-ids distincts", async () => {
    await recordPlatformAdEvent({ adId: "ad-1", placement: "settings", type: "click", userId: "u1" });
    await recordPlatformAdEvent({ adId: "ad-2", placement: "settings", type: "click", userId: "u1" });
    const ids = chains.map((entry) => entry.docId);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("anonyme (sans userId) : doc-id aléatoire (UUID)", async () => {
    await recordPlatformAdEvent({ adId: "ad-1", placement: "settings", type: "impression" });
    expect(chains[0]?.docId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
