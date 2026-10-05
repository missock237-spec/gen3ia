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
const countGet = vi.fn(); // agrégations count() (CTR sans lecture de documents)
function makeChain() {
  const api = {
    where: vi.fn(() => api),
    limit: vi.fn(() => api),
    get: vi.fn(() => queryGet()),
    count: vi.fn(() => ({ get: () => countGet() })),
  };
  return api;
}
let chains: Array<{ docId: string | undefined; set: ReturnType<typeof vi.fn> }>;
const docSet = vi.fn(async () => undefined);
const docGet = vi.fn(); // lecture directe d'un document (campagne par id)

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
        count: chain.count,
        doc: vi.fn((id: string) => {
          entry.docId = id;
          return { id, set: entry.set, get: () => docGet() };
        }),
      };
    }),
  },
}));

import { isWithinDailyBudget, passesTargeting, type AdCampaign } from "./campaigns";
import { choosePlatformAd, recordPlatformAdEvent } from "./platform-placement";

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
  countGet.mockReset();
  docGet.mockReset();
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

describe("choosePlatformAd — CTR réel via agrégations count() (quota Firestore)", () => {
  /** Annonce liée à la campagne c1 (sans budget journalier : pas de garde). */
  function linkedAd() {
    return {
      docs: [{
        id: "ad-1",
        data: () => ({
          placement: "settings",
          format: "link",
          title: "Annonce campagne",
          advertiser: "Annonceur",
          targetUrl: "https://gen3ia.online",
          enabled: true,
          priority: 10,
          campaignId: "c1",
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        }),
      }],
    };
  }

  function campaignDoc() {
    return {
      exists: true,
      data: () => ({
        ownerId: "admin-1",
        name: "Campagne diffusion",
        objective: "traffic",
        status: "active",
        dailyBudgetMinor: 0, // pas de garde budget : isWithinDailyBudget ne lit rien
        currency: "XAF",
        bidStrategy: "balanced",
        targeting: { placements: ["settings"] },
        creatives: [{ headline: "H", targetUrl: "https://gen3ia.online" }],
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      }),
    };
  }

  it("2 agrégations count() (impression + clic) au lieu de la lecture du lot d'événements", async () => {
    queryGet.mockResolvedValueOnce(linkedAd()); // inventaire platformAds — seule lecture de documents
    docGet.mockResolvedValue(campaignDoc()); // campagne relue par id
    countGet
      .mockResolvedValueOnce({ data: () => ({ count: 20 }) }) // impressions
      .mockResolvedValueOnce({ data: () => ({ count: 5 }) }); // clics → CTR 25 %

    const ad = await choosePlatformAd("settings");

    expect(ad.id).toBe("ad-1"); // diffusée via le score CTR réel
    expect(countGet).toHaveBeenCalledTimes(2); // 2 agrégations, pas plus
    expect(queryGet).toHaveBeenCalledTimes(1); // AUCUN lot d'événements lu (plus de limit(2000).get())
  });

  it("aucune impression enregistrée : CTR 0, diffusion maintenue sans repli d'erreur", async () => {
    queryGet.mockResolvedValueOnce(linkedAd());
    docGet.mockResolvedValue(campaignDoc());
    countGet
      .mockResolvedValueOnce({ data: () => ({ count: 0 }) })
      .mockResolvedValueOnce({ data: () => ({ count: 0 }) });

    const ad = await choosePlatformAd("settings");

    expect(ad.id).toBe("ad-1");
    expect(countGet).toHaveBeenCalledTimes(2);
  });

  it("panne des agrégations : CTR 0 (dégradation silencieuse), diffusion non interrompue", async () => {
    queryGet.mockResolvedValueOnce(linkedAd());
    docGet.mockResolvedValue(campaignDoc());
    countGet.mockRejectedValue(new Error("firestore down"));

    const ad = await choosePlatformAd("settings");

    expect(ad.id).toBe("ad-1");
  });
});
