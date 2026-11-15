import { describe, expect, it } from "vitest";

import { compareSemver, validateManifest } from "./manifest";

const VALID_MANIFEST = {
  id: "meteo-cameroun",
  name: "Météo Cameroun",
  version: "1.0.0",
  author: "dev-user-id",
  description: "Interroge un service météo public pour les agents Gen3ia.",
  category: "data",
  tags: ["meteo", "cm"],
  permissions: ["http.fetch:api.meteo.cm"],
  secrets: { api_key: { description: "Clé API météo" } },
  tools: [
    {
      id: "meteo-actuelle",
      name: "Météo actuelle",
      description: "Renvoie la météo actuelle d'une ville.",
      inputSchema: { ville: { type: "string", required: true, maxLength: 80 } },
      outputSchema: { temperature: { type: "number" } },
      endpoint: {
        method: "GET",
        url: "https://api.meteo.cm/v1/current?ville={{input.ville}}",
        headers: [{ name: "Authorization", value: "Bearer {{secret.api_key}}" }],
        timeoutMs: 8000,
      },
    },
  ],
  skills: [],
  workflows: [
    {
      id: "rapport-meteo",
      name: "Rapport météo",
      description: "Récupère la météo et la formate.",
      inputSchema: { ville: { type: "string", required: true } },
      steps: [{ toolId: "meteo-actuelle", input: { ville: "{{input.ville}}" } }],
    },
  ],
  settings: [],
  pricing: { model: "free", maxExecutionsPerDay: 100 },
};

describe("validation du manifest d'extension", () => {
  it("accepte un manifest valide", () => {
    const result = validateManifest(VALID_MANIFEST);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.id).toBe("meteo-cameroun");
  });

  it("rejette un id invalide et un version non-semver", () => {
    const result = validateManifest({ ...VALID_MANIFEST, id: "Bad_Id", version: "1.0" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.includes("id"))).toBe(true);
      expect(result.errors.some((error) => error.includes("semver"))).toBe(true);
    }
  });

  it("rejette une permission hors catalogue", () => {
    const result = validateManifest({ ...VALID_MANIFEST, permissions: ["db.root"] });
    expect(result.ok).toBe(false);
  });

  it("exige qu'un host d'endpoint soit couvert par une permission http.fetch", () => {
    const result = validateManifest({
      ...VALID_MANIFEST,
      permissions: ["http.fetch:autre-domaine.com"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.includes("http.fetch"))).toBe(true);
    }
  });

  it("rejette un workflow qui référence un tool inexistant", () => {
    const bad = JSON.parse(JSON.stringify(VALID_MANIFEST));
    bad.workflows[0].steps[0].toolId = "inconnu";
    const result = validateManifest(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((error) => error.includes("inconnu"))).toBe(true);
  });

  it("rejette un secret utilisé dans l'URL et un secret non déclaré en header", () => {
    const bad = JSON.parse(JSON.stringify(VALID_MANIFEST));
    bad.tools[0].endpoint.url = "https://api.meteo.cm/v1?key={{secret.api_key}}";
    const resultA = validateManifest(bad);
    expect(resultA.ok).toBe(false);

    const bad2 = JSON.parse(JSON.stringify(VALID_MANIFEST));
    bad2.tools[0].endpoint.headers = [{ name: "Authorization", value: "Bearer {{secret.inconnu}}" }];
    const resultB = validateManifest(bad2);
    expect(resultB.ok).toBe(false);
  });

  it("valide les règles de pricing par modèle", () => {
    const freeWithAmount = validateManifest({
      ...VALID_MANIFEST,
      pricing: { model: "free", amountMinor: 500 },
    });
    expect(freeWithAmount.ok).toBe(false);

    const oneTimeWithoutAmount = validateManifest({
      ...VALID_MANIFEST,
      pricing: { model: "one_time" },
    });
    expect(oneTimeWithoutAmount.ok).toBe(false);

    const subscriptionOk = validateManifest({
      ...VALID_MANIFEST,
      pricing: { model: "subscription", amountMinor: 300000, interval: "month" },
    });
    expect(subscriptionOk.ok).toBe(true);

    const subscriptionWithoutInterval = validateManifest({
      ...VALID_MANIFEST,
      pricing: { model: "subscription", amountMinor: 300000 },
    });
    expect(subscriptionWithoutInterval.ok).toBe(false);
  });

  it("compare les versions semver", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.1.0", "1.0.9")).toBeGreaterThan(0);
    expect(compareSemver("2.0.0", "10.0.0")).toBeLessThan(0);
  });
});
