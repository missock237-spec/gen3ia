import { describe, expect, it } from "vitest";

import { scoreAdCandidate, validateCampaignInput, type AdCampaignInput } from "./campaigns";

const validBase: AdCampaignInput = {
  ownerId: "admin-1",
  name: "Lancement Gen IA",
  objective: "traffic",
  status: "active",
  dailyBudgetMinor: 5000,
  currency: "XAF",
  bidStrategy: "balanced",
  targeting: { placements: ["settings", "workspace"] },
  creatives: [{ headline: "Accélérez vos projets avec Gen3ia", targetUrl: "https://gen3ia.online" }],
};

describe("validateCampaignInput — système publicitaire professionnel", () => {
  it("valide une campagne complète et normalise les champs", () => {
    const normalized = validateCampaignInput(validBase);
    expect(normalized.name).toBe("Lancement Gen IA");
    expect(normalized.currency).toBe("XAF");
    expect(normalized.targeting.placements).toEqual(["settings", "workspace"]);
  });

  it("rejette un nom trop court", () => {
    expect(() => validateCampaignInput({ ...validBase, name: "ab" })).toThrow(/entre 3 et 120/);
  });

  it("exige au moins un emplacement ciblé", () => {
    expect(() => validateCampaignInput({ ...validBase, targeting: { placements: [] } })).toThrow(/au moins un emplacement/);
  });

  it("exige au moins une création avec titre valide", () => {
    expect(() => validateCampaignInput({ ...validBase, creatives: [] })).toThrow(/au moins une création/);
    expect(() => validateCampaignInput({ ...validBase, creatives: [{ headline: "x", targetUrl: "https://gen3ia.online" }] })).toThrow(/3 à 160/);
  });

  it("valide l'URL de destination des créas", () => {
    expect(() => validateCampaignInput({ ...validBase, creatives: [{ headline: "Titre valide", targetUrl: "notaurl" }] })).toThrow(/URL valide/);
  });

  it("borne le plafond de fréquence", () => {
    expect(() => validateCampaignInput({ ...validBase, frequencyCapPerDay: 0 })).toThrow(/entre 1 et 100/);
    expect(() => validateCampaignInput({ ...validBase, frequencyCapPerDay: 101 })).toThrow(/entre 1 et 100/);
  });

  it("rejette une fenêtre de diffusion incohérente", () => {
    expect(() => validateCampaignInput({ ...validBase, startsAtMs: 2000, endsAtMs: 1000 })).toThrow(/postérieure/);
  });
});

describe("scoreAdCandidate — rotation pondérée PRO", () => {
  it("un CTR plus élevé donne un score supérieur (hors maximize_reach)", () => {
    const low = scoreAdCandidate({ priority: 0, ctr: 0.5, bidStrategy: "balanced" });
    const high = scoreAdCandidate({ priority: 0, ctr: 4, bidStrategy: "balanced" });
    expect(high).toBeGreaterThan(low);
  });

  it("maximize_reach neutralise le boost CTR (portée pure)", () => {
    expect(scoreAdCandidate({ priority: 10, ctr: 0, bidStrategy: "maximize_reach" }))
      .toBe(scoreAdCandidate({ priority: 10, ctr: 5, bidStrategy: "maximize_reach" }));
  });

  it("le score reste strictement positif (aucune annonce impossible à diffuser)", () => {
    expect(scoreAdCandidate({ priority: -1000, ctr: 0, bidStrategy: "maximize_ctr" })).toBeGreaterThan(0);
  });
});
