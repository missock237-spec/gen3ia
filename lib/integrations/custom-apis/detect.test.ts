import { describe, expect, it } from "vitest";

import {
  detectApiProvisioning,
  extractApiName,
  extractApiUrl,
  extractApiUsageName,
  looksLikeApiUsageRequest,
} from "./detect";

describe("detectApiProvisioning — fourniture d'API dans le chat", () => {
  it("détecte « connecte cette API : url avec la clé »", () => {
    const detected = detectApiProvisioning(
      "Connecte cette API : https://api.exemple.com/v1 avec la clé abc123456",
    );
    expect(detected).not.toBeNull();
    expect(detected?.baseUrl).toBe("https://api.exemple.com/v1");
    expect(detected?.authType).toBe("bearer");
    expect(detected?.authValue).toBe("abc123456");
  });

  it("détecte un bearer explicite (Authorization: Bearer …)", () => {
    const detected = detectApiProvisioning(
      "voici mon api https://api.monservice.io et authorization: Bearer sk_live_987654321",
    );
    expect(detected).not.toBeNull();
    expect(detected?.authValue).toBe("sk_live_987654321");
    expect(detected?.name).toBe("api.monservice.io");
  });

  it("détecte une clé API nommée en en-tête X-API-Key", () => {
    const detected = detectApiProvisioning(
      "ajoute l'API https://data.exemple.org avec api-key: XYZ98765432",
    );
    expect(detected).not.toBeNull();
    expect(detected?.authType).toBe("header");
    expect(detected?.authHeader).toBe("X-API-Key");
    expect(detected?.authValue).toBe("XYZ98765432");
  });

  it("utilise le nom entre guillemets « … » si présent", () => {
    const detected = detectApiProvisioning(
      "Connecte « Météo Pro » : https://api.meteo.fr/v1 avec la clé abc12345678",
    );
    expect(detected?.name).toBe("Météo Pro");
  });

  it("rejette une simple URL sans mot « api » ni verbe de branchement", () => {
    expect(detectApiProvisioning("Regarde https://exemple.com/page et dis-moi ce que tu vois")).toBeNull();
  });

  it("rejette une URL interne ou locale", () => {
    expect(detectApiProvisioning("connecte cette api : http://localhost:3000 avec la clé abc12345678")).toBeNull();
    expect(detectApiProvisioning("connecte cette api : https://gen3ia.online/api avec la clé abc12345678")).toBeNull();
  });

  it("ne crée pas de connecteur pour une demande d'information", () => {
    expect(detectApiProvisioning("C'est quoi une API REST ?")).toBeNull();
  });
});

describe("extractApiUrl", () => {
  it("extrait la première URL publique plausible", () => {
    expect(extractApiUrl("Mon API : https://api.a.com/v1, merci")).toBe("https://api.a.com/v1");
  });
  it("rejette les IP privées", () => {
    expect(extractApiUrl("api sur http://192.168.1.10/x")).toBeNull();
  });
});

describe("extractApiName", () => {
  it("retombe sur le nom d'hôte", () => {
    expect(extractApiName("n'importe quoi", "https://api.monsite.fr/v2")).toBe("api.monsite.fr");
  });
});

describe("looksLikeApiUsageRequest + extractApiUsageName", () => {
  it("reconnaît une demande d'utilisation nommée", () => {
    const message = "Utilise l'API Météo Pro pour me donner la météo de Douala";
    expect(looksLikeApiUsageRequest(message)).toBe(true);
    expect(extractApiUsageName(message)).toBe("Météo Pro");
  });

  it("reconnaît une demande générique sans nom", () => {
    expect(looksLikeApiUsageRequest("appelle l'api pour récupérer les clients")).toBe(true);
    expect(extractApiUsageName("appelle l'api pour récupérer les clients")).toBeNull();
  });

  it("ne détecte pas une simple question", () => {
    expect(looksLikeApiUsageRequest("comment fonctionne une API ?")).toBe(false);
  });
});
