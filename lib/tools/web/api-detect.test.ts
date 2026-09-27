import { describe, expect, it } from "vitest";

import { extractApiUrlFromMessage, looksLikeDirectApiCall } from "@/lib/domain/conversations/engine";

describe("web.api — extraction d'URL d'API énoncée", () => {
  it("extrait l'URL d'une demande d'appel d'API", () => {
    const message = "Appelle cette API et dis-moi ce qu'elle contient : https://jsonplaceholder.typicode.com/users/1.";
    expect(extractApiUrlFromMessage(message)).toBe("https://jsonplaceholder.typicode.com/users/1");
  });

  it("retourne null sans URL", () => {
    expect(extractApiUrlFromMessage("Appelle mon API personnelle")).toBeNull();
  });

  it("nettoie la ponctuation finale", () => {
    expect(extractApiUrlFromMessage("consulte https://api.exemple.com/data.")).toBe("https://api.exemple.com/data");
  });
});

describe("web.api — intention d'appel direct", () => {
  const url = "https://jsonplaceholder.typicode.com/users/1";

  it("détecte un verbe d'appel + URL", () => {
    expect(looksLikeDirectApiCall("appelle cette API : " + url, url)).toBe(true);
  });

  it("détecte une hôte api.* même sans mot « API »", () => {
    expect(looksLikeDirectApiCall("récupère les données depuis https://api.github.com/zen", "https://api.github.com/zen")).toBe(true);
  });

  it("ne déclenche PAS pour un simple lien collé sans intention d'appel", () => {
    expect(looksLikeDirectApiCall("voici mon site https://exemple.com/page", "https://exemple.com/page")).toBe(false);
  });
});
