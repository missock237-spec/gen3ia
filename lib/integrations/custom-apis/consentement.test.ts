import { beforeEach, describe, expect, it, vi } from "vitest";

const { listCustomApisMock, getCustomApiMock, findCustomApiByNameMock } = vi.hoisted(() => ({
  listCustomApisMock: vi.fn(),
  getCustomApiMock: vi.fn(),
  findCustomApiByNameMock: vi.fn(),
}));

vi.mock("./repository", () => ({
  listCustomApis: listCustomApisMock,
  listEnabledCustomApis: listCustomApisMock,
  getCustomApi: getCustomApiMock,
  findCustomApiByName: findCustomApiByNameMock,
  MAX_CUSTOM_APIS: 25,
}));

import { executeCustomApiCall } from "./client";

/**
 * APIS EXTERNES — gen3 ne peut appeler QUE les API personnelles que
 * l'UTILISATEUR a enregistrées ET activées (le consentement est l'acte
 * d'enregistrement/activation, contrôlable et révocable depuis
 * Intégrations). Vérification du garde : sans API autorisée, l'appel
 * REFUSE avec la démarche exacte — jamais d'appel non autorisé.
 */
describe("custom_api.call — accès conditionné au consentement utilisateur", () => {
  beforeEach(() => {
    listCustomApisMock.mockReset().mockResolvedValue([]);
    getCustomApiMock.mockReset();
    findCustomApiByNameMock.mockReset();
  });

  it("aucune API enregistrée → refus avec la démarche d'autorisation", async () => {
    await expect(
      executeCustomApiCall("u1", { apiName: "ma-api", path: "/points" }),
    ).rejects.toThrow(/Aucune API personnelle n'est enregistrée/);
    expect(listCustomApisMock).toHaveBeenCalledWith("u1");
  });

  it("API enregistrée mais DÉSACTIVÉE → refus explicite (consentement révocable)", async () => {
    listCustomApisMock.mockResolvedValue([
      { id: "api-1", userId: "u1", name: "ma-api", enabled: false, baseUrl: "https://api.exemple.fr", auth: { type: "none" } },
    ]);
    findCustomApiByNameMock.mockResolvedValue(
      { id: "api-1", userId: "u1", name: "ma-api", enabled: false, baseUrl: "https://api.exemple.fr", auth: { type: "none" } },
    );
    await expect(
      executeCustomApiCall("u1", { apiName: "ma-api", path: "/points" }),
    ).rejects.toThrow(/est désactivée\. Activez-la depuis Intégrations/);
  });

  it("API d'un autre nom → refus listant uniquement les API AUTORISÉES du compte", async () => {
    listCustomApisMock.mockResolvedValue([
      { id: "api-1", userId: "u1", name: "meteo", enabled: true, baseUrl: "https://meteo.exemple.fr", auth: { type: "none" } },
    ]);
    await expect(
      executeCustomApiCall("u1", { apiName: "inconnue", path: "/" }),
    ).rejects.toThrow(/introuvable\. Vos API personnelles : « meteo »/);
  });
});
