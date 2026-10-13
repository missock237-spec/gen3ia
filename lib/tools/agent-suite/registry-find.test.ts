import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Outil agent « registry.find » — Live MCP Tool Finder (Task 140).
 *
 * Verrous :
 *  1. 100 % déterministe : AUCUN appel LLM (aucune dépendance à la voie de
 *     facturation) — recherche npm en direct, détails npm, vérification PyPI ;
 *  2. URLs exactes construites avec encodeURIComponent (recherche plafonnée
 *     min(25, limit*3), détails sur les `limit` premiers candidats) ;
 *  3. verdicts de fraîcheur déterministes : à jour / à surveiller /
 *     obsolète / déprécié — à éviter, calculés sur la date de publication
 *     de la version latest ;
 *  4. mode verifyOnly : contrôle du nom EXACT, sans recherche ;
 *  5. écosystème PyPI : vérification du nom exact (aucune API de recherche) ;
 *  6. détection serveur MCP (préfixe @modelcontextprotocol/ ou mots-clés
 *     mcp / model-context-protocol) ;
 *  7. échec réseau/5xx/corps trop volumineux → erreur FRANÇAISE explicite,
 *     jamais de résultat factice.
 *
 * Frontière mockée : fetch global (registres npm/PyPI).
 */

import { registryFindTool } from "./registry-find";

const fetchMock = vi.fn();

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("registry.find — recherche npm en direct", () => {
  it("recherche puis détaille les candidats : URLs exactes, champs mappés, verdict « à jour »", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          objects: [
            {
              package: {
                name: "mcp-kit",
                version: "0.9.0",
                description: "Kit MCP pour agents",
                keywords: ["mcp", "sdk"],
                links: { repository: "https://github.com/x/mcp-kit" },
                date: daysAgoIso(40),
              },
              score: { final: 0.42 },
            },
            {
              package: {
                name: "agent-utils",
                version: "2.0.0",
                description: "Utilitaires agents",
                keywords: ["agent"],
                links: {},
                date: daysAgoIso(20),
              },
              score: { final: 0.31 },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          "dist-tags": { latest: "1.2.3" },
          time: { "1.2.3": daysAgoIso(10) },
          versions: { "1.2.3": {} },
          description: "Kit MCP pour agents",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          "dist-tags": { latest: "2.1.0" },
          time: { "2.1.0": daysAgoIso(30) },
          versions: { "2.1.0": {} },
        }),
      );

    const result = await registryFindTool.execute({ query: "mcp kit" }, { userId: "user-1" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://registry.npmjs.org/-/v1/search?text=mcp%20kit&size=15",
    );
    expect(fetchMock.mock.calls[1][0]).toBe("https://registry.npmjs.org/mcp-kit");
    expect(fetchMock.mock.calls[2][0]).toBe("https://registry.npmjs.org/agent-utils");

    expect(result.ecosystem).toBe("auto");
    expect(result.verifyOnly).toBe(false);
    expect(result.results).toHaveLength(2);

    const first = result.results[0];
    expect(first).toMatchObject({
      name: "mcp-kit",
      ecosystem: "npm",
      exists: true,
      latestVersion: "1.2.3",
      deprecated: false,
      lastPublished: expect.any(String),
      ageDays: 10,
      description: "Kit MCP pour agents",
      keywords: ["mcp", "sdk"],
      isMcpServer: true,
      searchScore: 0.42,
      verdict: "à jour",
    });
    expect(result.results[1].name).toBe("agent-utils");
    expect(result.results[1].isMcpServer).toBe(false);
    // Recommandation déterministe : le plus frais non déprécié est nommé.
    expect(result.recommendation).toContain("« mcp-kit »");
    expect(result.recommendation).toContain("v1.2.3");
    expect(result.recommendation).toContain("serveur MCP");
  });

  it("verdicts de fraîcheur : obsolète (>730 j) et à surveiller (365–730 j)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          objects: [
            {
              package: { name: "old-lib", description: "Vieille lib", keywords: [] },
              score: { final: 0.5 },
            },
            {
              package: { name: "mid-lib", description: "Lib moyenne", keywords: [] },
              score: { final: 0.4 },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          "dist-tags": { latest: "0.1.0" },
          time: { "0.1.0": daysAgoIso(800) },
          versions: { "0.1.0": {} },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          "dist-tags": { latest: "3.0.0" },
          time: { "3.0.0": daysAgoIso(400) },
          versions: { "3.0.0": {} },
        }),
      );

    const result = await registryFindTool.execute({ query: "lib" }, { userId: "user-1" });

    expect(result.results[0].verdict).toBe("obsolète");
    expect(result.results[0].ageDays).toBe(800);
    expect(result.results[1].verdict).toBe("à surveiller");
    expect(result.results[1].ageDays).toBe(400);
    expect(result.recommendation).toContain("« mid-lib »");
  });

  it("paquet déprécié : signalé « déprécié — à éviter » avec message, et avertissement dans la recommandation", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          objects: [
            {
              package: { name: "request-promise", description: "Ancien client", keywords: [] },
              score: { final: 0.9 },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          "dist-tags": { latest: "4.2.6" },
          time: { "4.2.6": daysAgoIso(90) },
          versions: { "4.2.6": { deprecated: "request-promise has been deprecated use axios" } },
        }),
      )
      // auto + moins de 2 candidats npm → vérification PyPI du nom exact.
      .mockResolvedValueOnce(jsonResponse({ info: { version: "4.2.4", summary: "Ancien client" } }));

    const result = await registryFindTool.execute({ query: "request" }, { userId: "user-1" });

    expect(result.results[0]).toMatchObject({
      name: "request-promise",
      deprecated: true,
      deprecationMessage: "request-promise has been deprecated use axios",
      verdict: "déprécié — à éviter",
    });
    expect(result.recommendation).toContain("déprécié");
    expect(result.recommendation).toContain("« request-promise »");
    // Le repli PyPI a bien été interrogé (2 candidats npm < 2).
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toBe("https://pypi.org/pypi/request/json");
    expect(result.results[1]).toMatchObject({
      name: "request",
      ecosystem: "pypi",
      exists: true,
      latestVersion: "4.2.4",
      description: "Ancien client",
    });
  });
});

describe("registry.find — vérification exacte (verifyOnly)", () => {
  it("verifyOnly npm : UNE seule requête de détails sur le nom exact, aucune recherche", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        "dist-tags": { latest: "1.0.0" },
        time: { "1.0.0": daysAgoIso(5) },
        versions: { "1.0.0": {} },
      }),
    );

    const result = await registryFindTool.execute(
      { query: "zod", ecosystem: "npm", verifyOnly: true },
      { userId: "user-1" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://registry.npmjs.org/zod");
    expect(result.results[0]).toMatchObject({
      name: "zod",
      exists: true,
      latestVersion: "1.0.0",
      verdict: "à jour",
    });
  });

  it("verifyOnly npm introuvable (404) : exists=false, verdict « introuvable »", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Not found" }, 404));

    const result = await registryFindTool.execute(
      { query: "paquet-qui-nexiste-pas", ecosystem: "npm", verifyOnly: true },
      { userId: "user-1" },
    );

    expect(result.results[0]).toMatchObject({ exists: false, verdict: "introuvable" });
    expect(result.recommendation).toContain("Aucun paquet nommé");
  });
});

describe("registry.find — écosystème PyPI", () => {
  it("vérifie le nom exact sur PyPI (aucune API de recherche publique)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        info: {
          version: "1.4.0",
          summary: "Framework d'agents en Python",
          home_page: "https://example.com",
        },
      }),
    );

    const result = await registryFindTool.execute(
      { query: "fastapi-mcp", ecosystem: "pypi" },
      { userId: "user-1" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://pypi.org/pypi/fastapi-mcp/json");
    expect(result.results[0]).toMatchObject({
      name: "fastapi-mcp",
      ecosystem: "pypi",
      exists: true,
      latestVersion: "1.4.0",
      description: "Framework d'agents en Python",
      isMcpServer: false,
    });
    expect(result.recommendation).toContain("« fastapi-mcp »");
  });

  it("PyPI introuvable (404) : exists=false sans lever", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404));

    const result = await registryFindTool.execute(
      { query: "paquet-python-fantome", ecosystem: "pypi" },
      { userId: "user-1" },
    );

    expect(result.results[0]).toMatchObject({
      ecosystem: "pypi",
      exists: false,
      verdict: "introuvable",
    });
  });
});

describe("registry.find — détection serveur MCP", () => {
  it("détecte le préfixe @modelcontextprotocol/ et les mots-clés mcp/model-context-protocol", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          objects: [
            {
              package: { name: "@modelcontextprotocol/server-git", keywords: ["git"] },
              score: { final: 0.9 },
            },
            {
              package: { name: "my-mcp-bridge", keywords: ["Model-Context-Protocol", "bridge"] },
              score: { final: 0.8 },
            },
            {
              package: { name: "plain-lib", keywords: ["utils"] },
              score: { final: 0.7 },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ "dist-tags": { latest: "1.0.0" }, time: { "1.0.0": daysAgoIso(3) }, versions: { "1.0.0": {} } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ "dist-tags": { latest: "1.0.0" }, time: { "1.0.0": daysAgoIso(4) }, versions: { "1.0.0": {} } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ "dist-tags": { latest: "1.0.0" }, time: { "1.0.0": daysAgoIso(5) }, versions: { "1.0.0": {} } }),
      );

    const result = await registryFindTool.execute(
      { query: "mcp server", limit: 3 },
      { userId: "user-1" },
    );

    expect(result.results.map((item) => item.isMcpServer)).toEqual([true, true, false]);
  });
});

describe("registry.find — échecs réseau : erreurs françaises explicites", () => {
  it("échec réseau npm → « Registre npm inaccessible : … »", async () => {
    fetchMock.mockRejectedValueOnce(new Error("fetch failed"));

    await expect(
      registryFindTool.execute({ query: "express" }, { userId: "user-1" }),
    ).rejects.toThrow(/Registre npm inaccessible : fetch failed/);
  });

  it("HTTP 500 npm → erreur française, pas de résultat factice", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));

    await expect(
      registryFindTool.execute({ query: "express" }, { userId: "user-1" }),
    ).rejects.toThrow(/Registre npm inaccessible : statut HTTP 500/);
  });

  it("échec PyPI → « Registre PyPI inaccessible : … »", async () => {
    fetchMock.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"));

    await expect(
      registryFindTool.execute({ query: "requests", ecosystem: "pypi" }, { userId: "user-1" }),
    ).rejects.toThrow(/Registre PyPI inaccessible : getaddrinfo ENOTFOUND/);
  });

  it("corps de réponse dépassant 2 Mo → erreur française (plafond respecté)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("x".repeat(2 * 1024 * 1024 + 128), { status: 200 }));

    await expect(
      registryFindTool.execute({ query: "webpack" }, { userId: "user-1" }),
    ).rejects.toThrow(/trop volumineuse \(dépasse 2 Mo\)/);
  });
});
