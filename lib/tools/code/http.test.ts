import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Outil `web.http` — requête HTTP sortante GET/POST/HEAD.
 *
 * Stratégie de test SANS réseau :
 *  - la garde SSRF RÉELLE du dépôt (lib/security/url-safety) est conservée
 *    pour les refus LITTÉRAUX (localhost, 127.0.0.1, 10.x, 172.16–31.x,
 *    192.168.x, 169.254.x, [::1], 0.0.0.0, ftp://, identifiants intégrés) :
 *    ces refus se produisent AVANT toute résolution DNS ou appel réseau ;
 *  - `assertPublicHttpUrl` est mocké par une garde locale FIDÈLE (mêmes
 *    refus littéraux, sans DNS) uniquement pour permettre les chemins de
 *    succès/échec HTTP sur des hôtes factices ; `fetch` est entièrement
 *    stubé — aucune vraie requête n'est jamais émise.
 */

vi.mock("@/lib/security/url-safety", async (importOriginal) => {
  const reel = await importOriginal<typeof import("@/lib/security/url-safety")>();
  return {
    ...reel,
    assertPublicHttpUrl: vi.fn(async (valeur: string) => {
      // Garde locale FIDÈLE aux refus littéraux de la vraie garde (sans DNS).
      const url = new URL(valeur);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) URLs are allowed.");
      if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed.");
      const hote = url.hostname.toLowerCase().replace(/\.$/, "");
      if (
        hote === "localhost" ||
        hote.endsWith(".localhost") ||
        /^(?:127|10|0)\./.test(hote) ||
        /^192\.168\./.test(hote) ||
        /^169\.254\./.test(hote) ||
        /^172\.(?:1[6-9]|2\d|3[01])\./.test(hote) ||
        hote === "[::1]" ||
        hote === "::1"
      ) {
        throw new Error("Access to private/local hosts is blocked.");
      }
      return url;
    }),
  };
});

import { assertPublicHttpUrl } from "@/lib/security/url-safety";

import { WebHttpErreur, outilWebHttp } from "./http";

const fetchMock = vi.fn();

beforeEach(() => {
  // resetAllMocks (et non clearAllMocks) : aucune file « Once » ne fuite entre tests.
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const CONTEXTE = { userId: "utilisateur-test", executionId: "exec-test" };

function entree(remplace: Record<string, unknown> = {}) {
  return outilWebHttp.inputSchema.parse({ url: "https://api.exemple.test/donnees", ...remplace });
}

function reponseTexte(corps: string, statut = 200, entetes: Record<string, string> = {}): Response {
  return new Response(corps, { status: statut, headers: { "content-type": "text/plain", ...entetes } });
}

describe("outil web.http — schéma d'entrée", () => {
  it("applique GET par défaut et borne les en-têtes", () => {
    const analyse = outilWebHttp.inputSchema.parse({ url: "https://api.exemple.test/" });
    expect(analyse.methode).toBe("GET");
    const onzeEnTetes = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`h${i}`, "v"]));
    expect(() => outilWebHttp.inputSchema.parse({ url: "https://api.exemple.test/", entetes: onzeEnTetes })).toThrow();
  });

  it("refuse un corps sans POST", () => {
    expect(() =>
      outilWebHttp.inputSchema.parse({ url: "https://api.exemple.test/", methode: "GET", corps: "{}" }),
    ).toThrow(/corps uniquement autorisé pour la méthode POST/);
  });
});

describe("outil web.http — garde SSRF (réelle, refus littéraux sans réseau)", () => {
  const ciblesBloquees = [
    "http://localhost:4000/secret",
    "http://127.0.0.1:8080/",
    "http://10.1.2.3/",
    "http://172.16.0.9/",
    "http://172.31.255.1/",
    "http://192.168.0.10/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://0.0.0.0/",
    "ftp://exemple.test/fichier",
    "https://utilisateur:motdepasse@exemple.test/",
  ];

  for (const cible of ciblesBloquees) {
    it(`bloque ${cible} avant tout fetch`, async () => {
      let message = "";
      try {
        await outilWebHttp.execute(entree({ url: cible }), CONTEXTE);
        expect.unreachable("la garde devait refuser cette URL");
      } catch (erreur) {
        message = erreur instanceof Error ? erreur.message : String(erreur);
      }
      expect(message).toMatch(/non autorisée|blocked|allowed/i);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(assertPublicHttpUrl).toHaveBeenCalled();
    });
  }
});

describe("outil web.http — GET réel (fetch mocké)", () => {
  it("restitue statut, corps, taille et latence d'une réponse 200", async () => {
    fetchMock.mockResolvedValueOnce(reponseTexte("bonjour du serveur"));
    const resultat = await outilWebHttp.execute(entree({}), CONTEXTE);
    expect(resultat.ok).toBe(true);
    expect(resultat.statut).toBe(200);
    expect(resultat.corps).toBe("bonjour du serveur");
    expect(resultat.tailleOctets).toBe("bonjour du serveur".length);
    expect(resultat.tronque).toBe(false);
    expect(resultat.latenceMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock.mock.calls[0]?.[0]).toBeInstanceOf(URL);
  });

  it("parse le JSON quand le content-type l'indique", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ liste: [1, 2] }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }),
    );
    const resultat = await outilWebHttp.execute(entree({}), CONTEXTE);
    expect(resultat.json).toEqual({ liste: [1, 2] });
  });

  it("restitue un statut non-2xx TEL QUEL (jamais d'invention)", async () => {
    fetchMock.mockResolvedValueOnce(reponseTexte("ressource absente", 404));
    const resultat = await outilWebHttp.execute(entree({}), CONTEXTE);
    expect(resultat.ok).toBe(false);
    expect(resultat.statut).toBe(404);
    expect(resultat.corps).toBe("ressource absente");
  });

  it("suit les redirections en revalidant la garde à chaque saut", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://cible.exemple.test/final", "content-type": "text/plain" } }),
      )
      .mockResolvedValueOnce(reponseTexte("apres redirection"));
    const resultat = await outilWebHttp.execute(entree({}), CONTEXTE);
    expect(resultat.urlFinale).toBe("https://cible.exemple.test/final");
    expect(resultat.corps).toBe("apres redirection");
    expect(assertPublicHttpUrl).toHaveBeenCalledTimes(2);
  });

  it("échoue honnêtement sur une boucle de redirections", async () => {
    for (let i = 0; i < 5; i += 1) {
      fetchMock.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: `https://api.exemple.test/boucle-${i + 1}` } }),
      );
    }
    await expect(outilWebHttp.execute(entree({}), CONTEXTE)).rejects.toThrow(WebHttpErreur);
  });

  it("échoue honnêtement sur une redirection vers un hôte interne", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/meta" } }),
    );
    await expect(outilWebHttp.execute(entree({}), CONTEXTE)).rejects.toThrow(/non autorisée|blocked/i);
  });
});

describe("outil web.http — POST et HEAD", () => {
  it("POST envoie le corps JSON et restitue la réponse", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ cree: true }), { status: 201, headers: { "content-type": "application/json" } }),
    );
    const resultat = await outilWebHttp.execute(
      entree({ methode: "POST", corps: { titre: "essai" }, entetes: { "X-Piste": "test" } }),
      CONTEXTE,
    );
    expect(resultat.statut).toBe(201);
    expect(resultat.json).toEqual({ cree: true });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ titre: "essai" }));
    expect((init.headers as Record<string, string>)["x-piste"]).toBe("test");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("HEAD ne lit aucun corps", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 200, headers: { "content-type": "text/html", "content-length": "12345" } }),
    );
    const resultat = await outilWebHttp.execute(entree({ methode: "HEAD" }), CONTEXTE);
    expect(resultat.ok).toBe(true);
    expect(resultat.corps).toBeUndefined();
    expect(resultat.tailleOctets).toBe(0);
    expect(resultat.tronque).toBe(false);
  });
});

describe("outil web.http — borne de taille 2 Mo", () => {
  it("coupe net au plafond et signale tronque honnêtement", async () => {
    const morceau = new Uint8Array(1_000_000).fill(97); // « a »
    const flux = new ReadableStream<Uint8Array>({
      start(controleur) {
        controleur.enqueue(morceau);
        controleur.enqueue(morceau);
        controleur.enqueue(morceau); // 3 Mo au total
        controleur.close();
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(flux, { status: 200, headers: { "content-type": "application/octet-stream" } }));
    const resultat = await outilWebHttp.execute(entree({}), CONTEXTE);
    expect(resultat.tailleOctets).toBe(2_000_000);
    expect(resultat.tronque).toBe(true);
    expect(resultat.ok).toBe(true);
  });

  it("ne tronque pas une réponse sous le plafond", async () => {
    fetchMock.mockResolvedValueOnce(reponseTexte("x".repeat(100_000)));
    const resultat = await outilWebHttp.execute(entree({}), CONTEXTE);
    expect(resultat.tronque).toBe(false);
    expect(resultat.tailleOctets).toBe(100_000);
  });
});
