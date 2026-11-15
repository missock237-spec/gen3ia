import { describe, expect, it } from "vitest";

import {
  buildExtensionRequest,
  renderStepInput,
  renderTemplate,
} from "./http-template";

const ENDPOINT = {
  method: "GET" as const,
  url: "https://api.exemple.com/v1/search?q={{input.query}}&page={{input.page}}",
  headers: [{ name: "Authorization", value: "Bearer {{secret.api_key}}" }],
  timeoutMs: 5000,
};

describe("génération de requêtes d'extensions (sandbox déclarative)", () => {
  it("interpole l'input encodé URL et injecte les secrets en header", () => {
    const request = buildExtensionRequest(
      "exemple.recherche",
      ENDPOINT,
      ["http.fetch:api.exemple.com"],
      ["http.fetch:api.exemple.com"],
      { input: { query: "marché immobilier douala", page: 2 }, secrets: { api_key: "sk-valeur" } },
    );
    expect(request.url).toBe("https://api.exemple.com/v1/search?q=march%C3%A9%20immobilier%20douala&page=2");
    expect(request.headers.Authorization).toBe("Bearer sk-valeur");
    expect(request.timeoutMs).toBe(5000);
    expect(request.body).toBeUndefined();
  });

  it("bloque un host privé même si la permission a été altérée", () => {
    expect(() =>
      buildExtensionRequest(
        "exemple.vol",
        { method: "GET", url: "http://169.254.169.254/latest/meta-data" },
        ["http.fetch:169.254.169.254"],
        ["http.fetch:169.254.169.254"],
        { input: {} },
      ),
    ).toThrow(/private host/);
  });

  it("bloque http non-sécurisé", () => {
    expect(() =>
      buildExtensionRequest(
        "exemple.http",
        { method: "GET", url: "http://api.exemple.com/x" },
        ["http.fetch:api.exemple.com"],
        ["http.fetch:api.exemple.com"],
        { input: {} },
      ),
    ).toThrow(/https/);
  });

  it("refuse un host non couvert par les permissions accordées (installation)", () => {
    expect(() =>
      buildExtensionRequest(
        "exemple.recherche",
        ENDPOINT,
        ["http.fetch:api.exemple.com"],
        ["http.fetch:autre.com"],
        { input: { query: "x", page: 1 }, secrets: { api_key: "k" } },
      ),
    ).toThrow(/Permission denied/);
  });

  it("échoue si un secret requis n'est pas configuré côté serveur", () => {
    expect(() =>
      buildExtensionRequest(
        "exemple.recherche",
        ENDPOINT,
        ["http.fetch:api.exemple.com"],
        ["http.fetch:api.exemple.com"],
        { input: { query: "x", page: 1 }, secrets: {} },
      ),
    ).toThrow(/secret "api_key"/);
  });

  it("rend un body template JSON valide", () => {
    const request = buildExtensionRequest(
      "exemple.creer",
      {
        method: "POST",
        url: "https://api.exemple.com/v1/items",
        bodyTemplate: '{"nom": "{{input.nom}}", "quantite": {{input.quantite}}}',
      },
      ["http.fetch:api.exemple.com"],
      ["http.fetch:api.exemple.com"],
      { input: { nom: "Café Robusta", quantite: 12 } },
    );
    expect(request.body).toBe('{"nom": "Café Robusta", "quantite": 12}');
    expect(request.headers["Content-Type"]).toBe("application/json");
  });

  it("rend les entrées de workflow avec référence exacte de résultat", () => {
    const rendered = renderStepInput(
      { ville: "{{input.ville}}", precedent: "{{input.step1.temperature}}" },
      { input: { ville: "Yaoundé", step1: { temperature: 27 } } },
    );
    expect(rendered).toEqual({ ville: "Yaoundé", precedent: 27 });
  });

  it("interpole les settings utilisateur avec repli sur la valeur par défaut", () => {
    const template = "langue={{setting.langue}}";
    expect(renderTemplate(template, { input: {}, settings: { langue: "fr" } })).toBe("langue=fr");
    expect(renderTemplate(template, { input: {} })).toBe("langue=");
  });
});
