import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 140 — Outil « browser.navigate » (Browser Anti-Bot Adaptive Navigator).
 *
 * Verrous :
 *  - rotation de User-Agents réalistes (un profil différent par tentative) ;
 *  - backoff exponentiel sur 429/503 (Retry-After honoré) ;
 *  - reprise sur 403 par changement d'agent, blocages honnêtes (403 final,
 *    401/402/407) JAMAIS de contenu inventé ;
 *  - détection de challenge sur le HTML brut (antiBotDetected + texte vide) ;
 *  - suivi manuel des redirections avec REVALIDATION SSRF à chaque saut.
 */

vi.mock("@/lib/security/url-safety", () => ({
  assertPublicHttpUrl: vi.fn(),
}));

import { assertPublicHttpUrl } from "@/lib/security/url-safety";

import { browserNavigateTool } from "./browser-navigate";

const mockedAssertUrl = vi.mocked(assertPublicHttpUrl);

const CONTEXT = { userId: "user-1", executionId: "exec-1" };

/** Le runtime (lib/tools/executor.ts) PARSE l'entrée via inputSchema avant execute — idem ici. */
function navInput(overrides: { url?: string; maxCharacters?: number; maxRetries?: number } = {}) {
  return browserNavigateTool.inputSchema.parse({ url: "https://exemple.com/page", ...overrides });
}

const UA_CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const UA_FIREFOX_MACOS = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0";
const UA_SAFARI_MACOS =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";

function page(html: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function statusPage(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

const fetchMock = vi.fn();

beforeEach(() => {
  // resetAllMocks (et non clearAllMocks) : aucune file d'implémentation « Once » ne doit fuiter entre tests.
  vi.resetAllMocks();
  mockedAssertUrl.mockImplementation(async (url: string) => new URL(url));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* Schéma d'entrée                                                    */
/* ------------------------------------------------------------------ */

describe("outil browser.navigate — schéma d'entrée", () => {
  it("applique les défauts (20000 caractères, 3 relances) et valide l'URL", () => {
    const parsed = browserNavigateTool.inputSchema.parse({ url: "https://exemple.com/page" });
    expect(parsed.maxCharacters).toBe(20_000);
    expect(parsed.maxRetries).toBe(3);
    expect(() => browserNavigateTool.inputSchema.parse({ url: "pas-une-url" })).toThrow();
  });

  it("refuse maxRetries > 4 et maxCharacters < 1000", () => {
    expect(() =>
      browserNavigateTool.inputSchema.parse({ url: "https://exemple.com", maxRetries: 5 }),
    ).toThrow();
    expect(() =>
      browserNavigateTool.inputSchema.parse({ url: "https://exemple.com", maxCharacters: 500 }),
    ).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Succès direct                                                       */
/* ------------------------------------------------------------------ */

describe("outil browser.navigate — succès direct", () => {
  it("récupère la page au premier essai avec le User-Agent Chrome 131 et les en-têtes navigateur", async () => {
    fetchMock.mockResolvedValueOnce(
      page("<html><body><h1>Accueil</h1><p>Contenu visible</p></body></html>"),
    );

    const result = await browserNavigateTool.execute(navInput({ url: "https://exemple.com/page" }), CONTEXT);

    expect(result.status).toBe(200);
    expect(result.blocked).toBe(false);
    expect(result.antiBotDetected).toBe(false);
    expect(result.text).toContain("Accueil");
    expect(result.text).toContain("Contenu visible");
    expect(result.finalStrategy).toBe("success");
    expect(result.attempts).toEqual([{ attempt: 0, status: 200, strategy: "initial" }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0];
    expect(target.toString()).toBe("https://exemple.com/page");
    expect(init.redirect).toBe("manual");
    expect(init.headers["User-Agent"]).toBe(UA_CHROME_WINDOWS);
    expect(init.headers["Accept"]).toBe("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    expect(init.headers["Accept-Language"]).toBe("fr-FR,fr;q=0.9,en;q=0.5");
    expect(init.headers["Sec-Fetch-Dest"]).toBe("document");
    expect(init.headers["Sec-Fetch-Mode"]).toBe("navigate");
    expect(init.headers["Sec-Fetch-Site"]).toBe("none");
    expect(init.headers["Sec-Fetch-User"]).toBe("?1");
  });

  it("tronque le texte extrait à maxCharacters", async () => {
    const longBody = "<p>" + "mot ".repeat(2_000) + "</p>";
    fetchMock.mockResolvedValueOnce(page(`<html><body>${longBody}</body></html>`));

    const result = await browserNavigateTool.execute(navInput({ url: "https://exemple.com/page", maxCharacters: 1_000 }), CONTEXT);
    expect(result.text.length).toBeLessThanOrEqual(1_000);
  });

  it("refuse un type de contenu non HTML/texte avec l'erreur française", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"a":1}', { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(browserNavigateTool.execute(navInput({ url: "https://exemple.com/api" }), CONTEXT)).rejects.toThrow(
      /Type de contenu non supporté : application\/json/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Backoff et rotation                                                 */
/* ------------------------------------------------------------------ */

describe("outil browser.navigate — backoff 429/503 et rotation 403", () => {
  it("429 puis 200 : backoff (Retry-After honoré) puis User-Agent différent", async () => {
    fetchMock
      .mockResolvedValueOnce(statusPage(429, { "retry-after": "0" }))
      .mockResolvedValueOnce(page("<html><body>OK après backoff</body></html>"));

    const result = await browserNavigateTool.execute(navInput({ url: "https://exemple.com/limite" }), CONTEXT);

    expect(result.text).toContain("OK après backoff");
    expect(result.finalStrategy).toBe("success");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[1].strategy).toBe("rate_limit_backoff");

    const uaFirst = fetchMock.mock.calls[0][1].headers["User-Agent"] as string;
    const uaSecond = fetchMock.mock.calls[1][1].headers["User-Agent"] as string;
    expect(uaFirst).toBe(UA_CHROME_WINDOWS);
    expect(uaSecond).not.toBe(uaFirst);
    expect(uaSecond).toBe(UA_FIREFOX_MACOS);
  });

  it("503 répété jusqu'à épuisement : blocage honnête, sans contenu inventé", async () => {
    fetchMock
      .mockResolvedValueOnce(statusPage(503, { "retry-after": "0" }))
      .mockResolvedValueOnce(statusPage(503, { "retry-after": "0" }));

    const result = await browserNavigateTool.execute(navInput({ url: "https://exemple.com/limite", maxRetries: 1 }), CONTEXT);

    expect(result.blocked).toBe(true);
    expect(result.text).toBe("");
    expect(result.reason).toContain("limite de débit du site atteinte (503)");
    expect(result.finalStrategy).toBe("rate_limited");
  });

  it("403 ×2 puis 200 : rotation d'agents jusqu'au succès", async () => {
    fetchMock
      .mockResolvedValueOnce(statusPage(403))
      .mockResolvedValueOnce(statusPage(403))
      .mockResolvedValueOnce(page("<html><body>Accès accordé</body></html>"));

    const result = await browserNavigateTool.execute(navInput({ url: "https://exemple.com/protégé" }), CONTEXT);

    expect(result.blocked).toBe(false);
    expect(result.text).toContain("Accès accordé");
    expect(result.finalStrategy).toBe("success");
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts[1].strategy).toBe("ua_rotation");
    expect(result.attempts[2].strategy).toBe("ua_rotation");
    const uas = fetchMock.mock.calls.map((call) => call[1].headers["User-Agent"]);
    expect(new Set(uas).size).toBe(3);
    expect(uas[1]).toBe(UA_FIREFOX_MACOS);
    expect(uas[2]).toBe(UA_SAFARI_MACOS);
  });

  it("403 final : blocage honnête malgré la rotation d'agents", async () => {
    fetchMock.mockResolvedValueOnce(statusPage(403)).mockResolvedValueOnce(statusPage(403));

    const result = await browserNavigateTool.execute(navInput({ url: "https://exemple.com/interdit", maxRetries: 1 }), CONTEXT);

    expect(result.blocked).toBe(true);
    expect(result.text).toBe("");
    expect(result.reason).toBe("accès refusé (403) malgré la rotation d'agents");
    expect(result.finalStrategy).toBe("blocked_403");
    expect(result.attempts).toHaveLength(2);
  });

  it("401 : blocage authentification/paiement, sans appel supplémentaire", async () => {
    fetchMock.mockResolvedValueOnce(statusPage(401));

    const result = await browserNavigateTool.execute(navInput({ url: "https://exemple.com/prive" }), CONTEXT);

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("authentification/paiement requise");
    expect(result.finalStrategy).toBe("auth_required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/* Détection de challenge (honnêteté : aucun contenu inventé)          */
/* ------------------------------------------------------------------ */

describe("outil browser.navigate — détection honnête des pages challenge", () => {
  it("page « Just a moment… » : antiBotDetected vrai, texte VIDE, aucun contenu inventé", async () => {
    fetchMock.mockResolvedValueOnce(
      page(
        "<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing exemple.com.</body></html>",
      ),
    );

    const result = await browserNavigateTool.execute(navInput({ url: "https://exemple.com/protégé" }), CONTEXT);

    expect(result.antiBotDetected).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.text).toBe("");
    expect(result.finalStrategy).toBe("challenge_detected");
    expect(result.status).toBe(200);
  });

  it("une page légitime contenant le mot captcha dans un long contenu n'est pas marquée au-delà de la fenêtre de détection", async () => {
    // Le marqueur au-delà des 4 premiers Ko n'est PAS détecté (fenêtre honnête).
    const padding = "<p>" + "x".repeat(5_000) + "</p>";
    fetchMock.mockResolvedValueOnce(
      page(`<html><body>${padding}<p>Nous parlons du mot captcha bien après le début de page.</p></body></html>`),
    );

    const result = await browserNavigateTool.execute(navInput({ url: "https://exemple.com/article" }), CONTEXT);
    expect(result.antiBotDetected).toBe(false);
    expect(result.text).toContain("captcha");
  });
});

/* ------------------------------------------------------------------ */
/* Redirections et garde SSRF                                          */
/* ------------------------------------------------------------------ */

describe("outil browser.navigate — redirections et revalidation SSRF", () => {
  it("suit une redirection relative (résolution + revalidation) jusqu'au contenu final", async () => {
    fetchMock
      .mockResolvedValueOnce(statusPage(302, { location: "/accueil-final" }))
      .mockResolvedValueOnce(page("<html><body>Page finale</body></html>"));

    const result = await browserNavigateTool.execute(navInput({ url: "https://exemple.com/vieux-chemin" }), CONTEXT);

    expect(result.url).toBe("https://exemple.com/accueil-final");
    expect(result.text).toContain("Page finale");
    expect(result.attempts[0].strategy).toBe("redirect_follow");
    expect(result.finalStrategy).toBe("success");
    // Chaque hop (initial + redirection) est revalidé par la garde SSRF.
    expect(mockedAssertUrl).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0].toString()).toBe("https://exemple.com/accueil-final");
  });

  it("refuse une redirection vers une IP privée : assertPublicHttpUrl bloque le hop", async () => {
    mockedAssertUrl
      .mockImplementationOnce(async (url: string) => new URL(url))
      .mockRejectedValueOnce(new Error("Access to private IP addresses is blocked."));

    fetchMock.mockResolvedValueOnce(statusPage(302, { location: "http://169.254.169.254/latest/meta-data" }));

    await expect(
      browserNavigateTool.execute(navInput({ url: "https://exemple.com/redir-piege" }), CONTEXT),
    ).rejects.toThrow(/private IP/);
    expect(mockedAssertUrl).toHaveBeenCalledTimes(2);
    // Un SEUL fetch : le hop piégé n'a jamais été effectué.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuse plus de 3 redirections successives", async () => {
    fetchMock
      .mockResolvedValueOnce(statusPage(302, { location: "/r1" }))
      .mockResolvedValueOnce(statusPage(302, { location: "/r2" }))
      .mockResolvedValueOnce(statusPage(302, { location: "/r3" }))
      .mockResolvedValueOnce(statusPage(302, { location: "/r4" }));

    await expect(
      browserNavigateTool.execute(navInput({ url: "https://exemple.com/boucle" }), CONTEXT),
    ).rejects.toThrow(/Trop de redirections successives/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("refuse une redirection sans destination", async () => {
    fetchMock.mockResolvedValueOnce(statusPage(302));
    await expect(browserNavigateTool.execute(navInput({ url: "https://exemple.com/sans-location" }), CONTEXT)).rejects.toThrow(
      /redirection sans destination/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Erreurs réseau                                                      */
/* ------------------------------------------------------------------ */

describe("outil browser.navigate — erreurs réseau", () => {
  it("erreur réseau : erreur française, aucune donnée inventée", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connect ETIMEDOUT"));
    await expect(browserNavigateTool.execute(navInput({ url: "https://exemple.com/down" }), CONTEXT)).rejects.toThrow(
      /Échec de la navigation vers https:\/\/exemple\.com\/down : connect ETIMEDOUT/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("statut HTTP autre (404) : erreur française explicite", async () => {
    fetchMock.mockResolvedValueOnce(statusPage(404));
    await expect(browserNavigateTool.execute(navInput({ url: "https://exemple.com/inconnu" }), CONTEXT)).rejects.toThrow(
      /statut HTTP 404/,
    );
  });
});
