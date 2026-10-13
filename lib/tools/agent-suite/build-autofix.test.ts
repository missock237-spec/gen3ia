import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Outil agent « build.autofix » — Autonomous Error-to-Fix Pipeline (Task 140).
 *
 * Verrous :
 *  1. garde d'environnement : GITHUB_TOKEN absent → erreur FRANÇAISE
 *     immédiate, AUCUN appel réseau ;
 *  2. extraction déterministe des erreurs (TypeScript/webpack/Node/ENOENT/
 *     Python/générique), dédupliquée et plafonnée — aucun motif reconnu →
 *     erreur française explicite (pas d'invention) ;
 *  3. lecture GitHub réelle (dépôt validé, default_branch quand la branche
 *     n'est PAS fournie, contenu base64 décodé) ;
 *  4. correctifs LLM FACTURÉS au nom de l'utilisateur (task coding,
 *     maxTokens 3500) et DÉFENSIFS : oldSnippet inexistant verbatim →
 *     correctif ÉCARTÉ avec raison, AUCUNE pull request ;
 *  5. chemin nominal : branche dédiée créée, commit PUT contents par
 *     correctif (message tronqué 72 caractères, sha suivi), pull request
 *     française complète (erreur analysée / cause racine / correctifs).
 *
 * Frontières mockées : voie de facturation LLM + fetch global (REST GitHub).
 */

const generateForUserMock = vi.fn();
vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: (...args: unknown[]) => generateForUserMock(...args),
}));

import { buildAutofixTool } from "./build-autofix";

const fetchMock = vi.fn();

interface RecordedCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

const ghCalls: RecordedCall[] = [];

interface RouteResult {
  status?: number;
  body: unknown;
}

function installGithubRouter(route: (url: string, method: string) => RouteResult | undefined) {
  ghCalls.length = 0;
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = ((init?.method as string | undefined) ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    ghCalls.push({ url, method, body });
    const matched = route(url, method);
    if (!matched) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(JSON.stringify(matched.body), { status: matched.status ?? 200 });
  });
}

const CONTEXT = { userId: "user-1", executionId: "exec-autofix-1" };

const FILE_CONTENT = "const greeting: string = 42;\nconsole.log(greeting);\n";

const BUILD_LOG = [
  "> gen3ia@1.0.0 build",
  "> tsc --noEmit",
  "",
  "src/app.ts:12:5 - error TS2322: Type 'number' is not assignable to type 'string'.",
  "",
  "Found 1 error in src/app.ts",
].join("\n");

function mockLlmPlan(plan: { rootCause: string; patches: unknown[] }) {
  generateForUserMock.mockResolvedValueOnce({
    response: { text: JSON.stringify(plan) },
  });
}

const VALID_PLAN = {
  rootCause: "Un littéral numérique est affecté à une variable typée string.",
  patches: [
    {
      path: "src/app.ts",
      oldSnippet: "const greeting: string = 42;",
      newSnippet: 'const greeting: string = "42";',
      explanation: "Affecte le littéral sous forme de chaîne.",
    },
  ],
};

function happyPathRoutes(defaultBranch = "main", refBranch = defaultBranch) {
  return (url: string, method: string): RouteResult | undefined => {
    if (method === "GET" && url === "https://api.github.com/repos/acme/app") {
      return { body: { default_branch: defaultBranch, full_name: "acme/app" } };
    }
    if (
      method === "GET" &&
      url === `https://api.github.com/repos/acme/app/contents/src%2Fapp.ts?ref=${encodeURIComponent(refBranch)}`
    ) {
      return {
        body: {
          type: "file",
          encoding: "base64",
          sha: "file-sha-1",
          size: FILE_CONTENT.length,
          content: Buffer.from(FILE_CONTENT, "utf8").toString("base64"),
        },
      };
    }
    if (method === "GET" && url === `https://api.github.com/repos/acme/app/git/ref/heads/${encodeURIComponent(refBranch)}`) {
      return { body: { object: { sha: "base-sha-1" } } };
    }
    if (method === "POST" && url === "https://api.github.com/repos/acme/app/git/refs") {
      return { status: 201, body: { ref: "refs/heads/gen3ia-autofix-aaaa1111" } };
    }
    if (method === "PUT" && url === "https://api.github.com/repos/acme/app/contents/src%2Fapp.ts") {
      return { body: { content: { sha: "file-sha-2" } } };
    }
    if (method === "POST" && url === "https://api.github.com/repos/acme/app/pulls") {
      return {
        status: 201,
        body: { html_url: "https://github.com/acme/app/pull/12", number: 12 },
      };
    }
    return undefined;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Réinitialisation complète (file des mockResolvedValueOnce incluse) — évite
  // toute fuite de plan LLM entre deux tests qui s'arrêtent avant l'appel LLM.
  generateForUserMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GITHUB_TOKEN", "gh-token-test");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("build.autofix — gardes d'entrée", () => {
  it("GITHUB_TOKEN manquant : erreur française immédiate, aucun appel réseau ni LLM", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");

    await expect(
      buildAutofixTool.execute(
        { buildLog: BUILD_LOG, owner: "acme", name: "app" },
        CONTEXT,
      ),
    ).rejects.toThrow(
      "GITHUB_TOKEN manquant — le pipeline d'auto-correction ne peut pas accéder au dépôt GitHub.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(generateForUserMock).not.toHaveBeenCalled();
  });

  it("log sans erreur identifiable : erreur française explicite (rien d'inventé)", async () => {
    installGithubRouter(() => undefined);

    await expect(
      buildAutofixTool.execute(
        {
          buildLog: "Build terminé sans incident particulier. Tous les contrôles sont passés avec succès ce jour.",
          owner: "acme",
          name: "app",
        },
        CONTEXT,
      ),
    ).rejects.toThrow(/Aucune erreur identifiable dans le log fourni/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dépôt introuvable (404) : l'erreur GitHub remonte en français", async () => {
    installGithubRouter(() => undefined);

    await expect(
      buildAutofixTool.execute({ buildLog: BUILD_LOG, owner: "acme", name: "app" }, CONTEXT),
    ).rejects.toThrow(/Appel GitHub API en échec .*statut 404/);
    expect(generateForUserMock).not.toHaveBeenCalled();
  });
});

describe("build.autofix — pipeline nominal (fichier lu, correctif vérifié, PR créée)", () => {
  it("extrait l'erreur TS, lit le fichier, applique le correctif verbatim, crée la branche, commit et PR", async () => {
    installGithubRouter(happyPathRoutes());
    mockLlmPlan(VALID_PLAN);

    const result = await buildAutofixTool.execute(
      { buildLog: BUILD_LOG, owner: "acme", name: "app" },
      CONTEXT,
    );

    // ─── Erreurs extraites de façon déterministe ───
    expect(result.analysis.errorEntries).toHaveLength(1);
    expect(result.analysis.errorEntries[0]).toMatchObject({
      file: "src/app.ts",
      line: 12,
      message: expect.stringContaining("TS2322"),
    });

    // ─── Appel LLM facturé au nom de l'utilisateur (task coding, 3500 tokens) ───
    expect(generateForUserMock).toHaveBeenCalledTimes(1);
    const billedCall = generateForUserMock.mock.calls[0][0] as {
      userId: string;
      request: { task: string; maxTokens: number; messages: Array<{ role: string; content: string }> };
    };
    expect(billedCall.userId).toBe("user-1");
    expect(billedCall.request.task).toBe("coding");
    expect(billedCall.request.maxTokens).toBe(3_500);
    expect(billedCall.request.messages[0].content).toContain("src/app.ts:12");
    expect(billedCall.request.messages[0].content).toContain("const greeting: string = 42;");
    expect(billedCall.request.messages[0].content).toContain("### src/app.ts");

    // ─── Branche dédiée créée depuis le SHA de base ───
    expect(result.fixBranch).toMatch(/^gen3ia-autofix-[0-9a-f]{8}$/);
    const createRef = ghCalls.find((call) => call.url.endsWith("/git/refs") && call.method === "POST");
    expect(createRef?.body).toMatchObject({ ref: `refs/heads/${result.fixBranch}`, sha: "base-sha-1" });

    // ─── Commit du correctif (PUT contents, base64 du contenu corrigé) ───
    const put = ghCalls.find(
      (call) => call.method === "PUT" && call.url.endsWith("/contents/src%2Fapp.ts"),
    );
    expect(put).toBeDefined();
    const expectedUpdated = FILE_CONTENT.replace(
      "const greeting: string = 42;",
      'const greeting: string = "42";',
    );
    expect(put?.body).toMatchObject({
      message: "fix: correction automatique — Affecte le littéral sous forme de chaîne.",
      branch: result.fixBranch,
      sha: "file-sha-1",
    });
    expect(put?.body?.content).toBe(Buffer.from(expectedUpdated, "utf8").toString("base64"));

    // ─── Pull request française complète ───
    const pull = ghCalls.find((call) => call.url.endsWith("/pulls") && call.method === "POST");
    expect(pull?.body).toMatchObject({
      title: "fix: correction automatique de build (Gen3ia)",
      head: result.fixBranch,
      base: "main",
    });
    const prBody = String(pull?.body?.body);
    expect(prBody).toContain("## Erreur analysée");
    expect(prBody).toContain("`src/app.ts:12`");
    expect(prBody).toContain("## Cause racine");
    expect(prBody).toContain(VALID_PLAN.rootCause);
    expect(prBody).toContain("## Correctifs appliqués");
    expect(prBody).toContain("Correctif généré automatiquement par le pipeline d'auto-correction Gen3ia.");

    // ─── Contrat de retour ───
    expect(result.repo).toEqual({ owner: "acme", name: "app", branch: "main" });
    expect(result.prUrl).toBe("https://github.com/acme/app/pull/12");
    expect(result.prNumber).toBe(12);
    expect(result.skipped).toEqual([]);
  });

  it("branche NON fournie : c'est la default_branch du dépôt qui sert de base", async () => {
    installGithubRouter(happyPathRoutes("develop"));
    mockLlmPlan(VALID_PLAN);

    const result = await buildAutofixTool.execute(
      { buildLog: BUILD_LOG, owner: "acme", name: "app" },
      CONTEXT,
    );

    expect(result.repo.branch).toBe("develop");
    expect(ghCalls.some((call) => call.url.endsWith("/git/ref/heads/develop"))).toBe(true);
    const pull = ghCalls.find((call) => call.url.endsWith("/pulls") && call.method === "POST");
    expect(pull?.body).toMatchObject({ base: "develop" });
  });

  it("branche fournie explicitement : elle est utilisée telle quelle", async () => {
    // default_branch ≠ branche fournie : les lectures se font bien sur release/1.x.
    installGithubRouter(happyPathRoutes("main", "release/1.x"));
    mockLlmPlan(VALID_PLAN);

    const result = await buildAutofixTool.execute(
      { buildLog: BUILD_LOG, owner: "acme", name: "app", branch: "release/1.x" },
      CONTEXT,
    );

    expect(result.repo.branch).toBe("release/1.x");
    expect(
      ghCalls.some((call) =>
        call.url.endsWith("/contents/src%2Fapp.ts?ref=release%2F1.x"),
      ),
    ).toBe(true);
    const pull = ghCalls.find((call) => call.url.endsWith("/pulls") && call.method === "POST");
    expect(pull?.body).toMatchObject({ base: "release/1.x" });
  });
});

describe("build.autofix — défense : correctifs non vérifiables", () => {
  it("oldSnippet absent du fichier : correctif ÉCARTÉ avec raison, AUCUNE PR, contenu intact", async () => {
    installGithubRouter(happyPathRoutes());
    mockLlmPlan({
      rootCause: "Cause identifiée mais correctif non applicable.",
      patches: [
        {
          path: "src/app.ts",
          oldSnippet: "CE SNIPPET NEXISTE PAS DU TOUT DANS LE FICHIER",
          newSnippet: "whatever",
          explanation: "Correctif hasardeux.",
        },
      ],
    });

    const result = await buildAutofixTool.execute(
      { buildLog: BUILD_LOG, owner: "acme", name: "app" },
      CONTEXT,
    );

    expect(result.analysis.patches).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].path).toBe("src/app.ts");
    expect(result.skipped[0].reason).toContain("oldSnippet introuvable verbatim");
    expect(result.prUrl).toBeUndefined();
    expect(result.fixBranch).toBeUndefined();
    // Aucune écriture GitHub (ni branche, ni commit, ni PR).
    expect(ghCalls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });

  it("chemin désignant un répertoire (réponse tableau) : signalé dans skipped, pipeline stoppé avant le LLM", async () => {
    installGithubRouter((url, method) => {
      if (method === "GET" && url === "https://api.github.com/repos/acme/app") {
        return { body: { default_branch: "main" } };
      }
      if (method === "GET" && url.includes("/contents/src%2Fapp.ts?ref=main")) {
        return { body: [{ name: "index.ts", path: "src/app.ts/index.ts" }] };
      }
      return undefined;
    });

    const result = await buildAutofixTool.execute(
      { buildLog: BUILD_LOG, owner: "acme", name: "app" },
      CONTEXT,
    );

    // Aucun fichier lisible → arrêt propre AVANT tout appel LLM facturé.
    expect(generateForUserMock).not.toHaveBeenCalled();
    expect(result.analysis.rootCause).toBe("Aucun fichier incriminé n'a pu être lu dans le dépôt.");
    expect(result.skipped[0].reason).toContain("répertoire");
    expect(result.prUrl).toBeUndefined();
  });

  it("fichier introuvable sur la branche (404) : signalé dans skipped, pipeline s'arrête proprement", async () => {
    installGithubRouter((url, method) => {
      if (method === "GET" && url === "https://api.github.com/repos/acme/app") {
        return { body: { default_branch: "main" } };
      }
      return undefined; // 404 partout ailleurs.
    });

    const result = await buildAutofixTool.execute(
      { buildLog: BUILD_LOG, owner: "acme", name: "app" },
      CONTEXT,
    );

    expect(generateForUserMock).not.toHaveBeenCalled();
    expect(result.skipped[0]).toMatchObject({
      path: "src/app.ts",
      reason: expect.stringContaining("introuvable sur la branche"),
    });
    expect(result.analysis.patches).toEqual([]);
  });
});

describe("build.autofix — extraction déterministe multi-formats", () => {
  it("reconnaît les formats TS MSBuild, module Node et trace Python (dédupliqués, plafonnés)", async () => {
    const log = [
      "src/a.ts(3,11): error TS2304: Cannot find name 'foo'.",
      "src/a.ts(3,11): error TS2304: Cannot find name 'foo'.",
      "Error: Cannot find module 'lodash'",
      'File "app.py", line 10, in <module>',
    ].join("\n");

    installGithubRouter((url, method) => {
      if (method === "GET" && url === "https://api.github.com/repos/acme/app") {
        return { body: { default_branch: "main" } };
      }
      return { status: 404, body: { message: "Not Found" } };
    });

    const result = await buildAutofixTool.execute(
      { buildLog: log, owner: "acme", name: "app", maxFilesToPatch: 8 },
      CONTEXT,
    );

    // 4 lignes uniques reconnues, la duplication TS n'apparaît qu'une fois.
    expect(result.analysis.errorEntries).toHaveLength(3);
    expect(result.analysis.errorEntries[0]).toMatchObject({ file: "src/a.ts", line: 3 });
    expect(result.analysis.errorEntries[1].file).toBe("lodash");
    expect(result.analysis.errorEntries[2]).toMatchObject({ file: "app.py", line: 10 });
  });
});
