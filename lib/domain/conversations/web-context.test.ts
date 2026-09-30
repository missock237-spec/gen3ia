import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Étape 13 du plan 20 — liens fournis par l'utilisateur : les pages collées
 * dans la conversation sont RÉELLEMENT récupérées et injectées au modèle.
 * Contrats verrouillés :
 *  1. extraction pure : dédup, ponctuation finale exclue, plafond à 2 ;
 *  2. garde : pas de double récupération quand l'URL est déjà routée vers
 *     l'appel d'API direct (web.api) ;
 *  3. récupération RÉELLE via l'outil sécurisé web.open (jamais un fetch nu) ;
 *  4. honnêteté : échec individuel explicite dans le bloc — jamais inventé ;
 *  5. bloc vide quand il n'y a aucune URL.
 */

vi.mock("@/lib/tools/executor", () => ({ executeTool: vi.fn() }));

import { executeTool } from "@/lib/tools/executor";
import {
  extractUserUrls,
  loadWebPageContext,
  shouldFetchUrlContext,
  WEB_CONTEXT_MAX_URLS,
} from "./web-context";

const mockExecute = vi.mocked(executeTool);

afterEach(() => {
  vi.clearAllMocks();
});

describe("extractUserUrls", () => {
  it("extrait les URLs, retire la ponctuation finale et déduplique", () => {
    const urls = extractUserUrls("Lis https://exemple.com/article. puis https://exemple.com/article, et https://autre.fr");
    expect(urls).toEqual(["https://exemple.com/article", "https://autre.fr"]);
  });

  it("plafonne à WEB_CONTEXT_MAX_URLS", () => {
    const message = Array.from({ length: 5 }, (_, i) => `https://site${i}.fr/page`).join(" ");
    expect(extractUserUrls(message)).toHaveLength(WEB_CONTEXT_MAX_URLS);
  });

  it("retourne vide sans URL", () => {
    expect(extractUserUrls("Aucun lien ici, juste du texte.")).toEqual([]);
  });
});

describe("shouldFetchUrlContext", () => {
  it("true quand une URL n'est pas déjà routée vers web.api", () => {
    expect(shouldFetchUrlContext("Résume https://exemple.com/a")).toBe(true);
  });

  it("false sans URL ou quand la seule URL est le chemin web.api direct", () => {
    expect(shouldFetchUrlContext("Sans lien")).toBe(false);
    expect(shouldFetchUrlContext("Appelle l'API https://api.exemple.com/v1/users", ["https://api.exemple.com/v1/users"])).toBe(false);
  });
});
describe("loadWebPageContext", () => {
  it("récupère réellement la page via web.open et formate le bloc", async () => {
    mockExecute.mockResolvedValueOnce({
      success: true,
      output: { url: "https://exemple.com/a", text: "Titre de l'article.\nContenu réel de la page." },
    } as never);
    const context = await loadWebPageContext("Résume https://exemple.com/a", { userId: "u1" });
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "web.open",
      input: { url: "https://exemple.com/a", maxCharacters: 20_000 },
    }));
    expect(context).toContain("https://exemple.com/a");
    expect(context).toContain("(contenu récupéré)");
    expect(context).toContain("Contenu réel de la page.");
  });

  it("échec individuel explicite dans le bloc, les autres pages continuent", async () => {
    mockExecute
      .mockResolvedValueOnce({ success: false, error: "Web page returned 404." } as never)
      .mockResolvedValueOnce({ success: true, output: { text: "Deuxième page OK." } } as never);
    const context = await loadWebPageContext("Lis https://cassée.fr/x puis https://ok.fr/y", { userId: "u1" });
    expect(context).toContain("(récupération impossible : Web page returned 404.)");
    expect(context).toContain("Deuxième page OK.");
  });

  it("saute les URLs exclues (déjà routées vers web.api) et retourne vide sans rien", async () => {
    const context = await loadWebPageContext("Appelle https://api.exemple.com/v1", {
      userId: "u1",
      skipUrls: ["https://api.exemple.com/v1"],
    });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(context).toBe("");
  });
});
