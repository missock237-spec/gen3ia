import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 140 — Outil « schema.extract » (Dynamic Schema Extractor).
 *
 * Verrous :
 *  - extraction LLM facturée (generateStructuredForUser, tâche « document ») ;
 *  - contrat de colonnes IMPOSÉ après parsing (clés parasites supprimées,
 *    colonnes manquantes → null) ;
 *  - coercition de types déterministe (number/boolean/string) et lignes
 *    entièrement invalides écartées + comptées (discardedRows) ;
 *  - troncature à maxRows (flag truncated) ;
 *  - récupération réelle de la page (garde SSRF, redirection unique, UA
 *    plateforme) avec conservation du HTML riche.
 */

vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: vi.fn(),
}));

vi.mock("@/lib/security/url-safety", () => ({
  assertPublicHttpUrl: vi.fn(),
}));

import { generateForUser } from "@/lib/billing/ai-execution";
import { assertPublicHttpUrl } from "@/lib/security/url-safety";

import { schemaExtractTool } from "./schema-extract";

const mockedGenerate = vi.mocked(generateForUser);
const mockedAssertUrl = vi.mocked(assertPublicHttpUrl);

const CONTEXT = { userId: "user-1", executionId: "exec-1" };

/** Le runtime (lib/tools/executor.ts) PARSE l'entrée via inputSchema avant execute — idem ici. */
function extractInput(overrides: Record<string, unknown> = {}) {
  return schemaExtractTool.inputSchema.parse(overrides);
}

const fetchMock = vi.fn();

/** Réponse LLM facturée simulée contenant l'objet JSON demandé. */
function llmTable(payload: unknown): void {
  mockedGenerate.mockResolvedValueOnce({
    response: {
      id: "resp-test",
      provider: "glm",
      model: "glm-test",
      text: JSON.stringify(payload),
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      latencyMs: 5,
    },
    chargeMinor: 0,
    providerCostEur: 0,
  });
}

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

describe("outil schema.extract — schéma d'entrée", () => {
  it("exige une URL OU du HTML (message français explicite)", () => {
    const parsed = schemaExtractTool.inputSchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("Fournissez une URL ou du HTML"))).toBe(true);
    }
    expect(schemaExtractTool.inputSchema.safeParse({ url: "pas-une-url" }).success).toBe(false);
    expect(schemaExtractTool.inputSchema.safeParse({ html: "<p>x</p>" }).success).toBe(true);
    expect(schemaExtractTool.inputSchema.safeParse({ url: "https://exemple.com" }).success).toBe(true);
  });

  it("refuse un HTML dépassant 300 000 caractères et des champs vides", () => {
    expect(() => schemaExtractTool.inputSchema.parse({ html: "x".repeat(300_001) })).toThrow();
    expect(() => schemaExtractTool.inputSchema.parse({ html: "<p>x</p>", fields: [] })).toThrow();
    expect(() =>
      schemaExtractTool.inputSchema.parse({
        html: "<p>x</p>",
        fields: [{ name: "a", type: "decimal" as never }],
      }),
    ).toThrow();
  });

  it("applique le défaut maxRows = 25", () => {
    const parsed = schemaExtractTool.inputSchema.parse({ html: "<p>x</p>" });
    expect(parsed.maxRows).toBe(25);
  });
});

/* ------------------------------------------------------------------ */
/* Détection automatique + coercition                                  */
/* ------------------------------------------------------------------ */

describe("outil schema.extract — détection automatique et coercition", () => {
  it("détecte les colonnes et coerce les types (number, boolean, string)", async () => {
    llmTable({
      columns: [
        { name: "produit", type: "string" },
        { name: "prix", type: "number" },
        { name: "disponible", type: "boolean" },
      ],
      rows: [
        { produit: "Chaise", prix: "49.5", disponible: "true" },
        { produit: "Table", prix: 120, disponible: false },
        { produit: "Lampe", prix: "89", disponible: "FALSE" },
      ],
    });

    const output = await schemaExtractTool.execute(extractInput({ html: "<table><tr><td>Chaise</td></tr></table>" }), CONTEXT);

    expect(output.columns).toEqual([
      { name: "produit", type: "string" },
      { name: "prix", type: "number" },
      { name: "disponible", type: "boolean" },
    ]);
    expect(output.rows).toEqual([
      { produit: "Chaise", prix: 49.5, disponible: true },
      { produit: "Table", prix: 120, disponible: false },
      { produit: "Lampe", prix: 89, disponible: false },
    ]);
    expect(output.rowCount).toBe(3);
    expect(output.truncated).toBe(false);
    expect(output.discardedRows).toBe(0);
    expect(output.sourceChars).toBe("<table><tr><td>Chaise</td></tr></table>".length);
  });

  it("appelle le LLM via la voie facturée (tâche document, 3500 tokens max)", async () => {
    llmTable({ columns: [{ name: "a", type: "string" }], rows: [] });
    await schemaExtractTool.execute(extractInput({ html: "<p>contenu</p>" }), CONTEXT);
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    const [params] = mockedGenerate.mock.calls[0];
    expect(params.request.task).toBe("document");
    expect(params.request.maxTokens).toBe(3_500);
    expect(params.userId).toBe("user-1");
    expect(params.request.messages[0]?.content).toContain("<p>contenu</p>");
  });
});

/* ------------------------------------------------------------------ */
/* Contrat de colonnes imposé                                          */
/* ------------------------------------------------------------------ */

describe("outil schema.extract — contrat de colonnes imposé", () => {
  it("les clés parasites sont supprimées, les colonnes manquantes deviennent null", async () => {
    llmTable({
      columns: [{ name: "produit", type: "string" }],
      rows: [
        { nom: "A", prix: "10", promo: "-20%" },
        { nom: "B" },
      ],
    });

    const output = await schemaExtractTool.execute(
      extractInput({
        html: "<ul><li>A</li><li>B</li></ul>",
        fields: [
          { name: "nom", type: "string" },
          { name: "prix", type: "number", description: "Prix en euros" },
        ],
      }),
      CONTEXT,
    );

    // Le contrat demandé PRIME sur les colonnes détectées par le LLM.
    expect(output.columns).toEqual([
      { name: "nom", type: "string" },
      { name: "prix", type: "number", description: "Prix en euros" },
    ]);
    expect(output.rows).toEqual([
      { nom: "A", prix: 10 },
      { nom: "B", prix: null },
    ]);
    expect(output.discardedRows).toBe(0);

    // Le prompt LLM a bien reçu le contrat strict.
    const [params] = mockedGenerate.mock.calls[0];
    expect(params.request.messages[0]?.content).toContain("SCHÉMA DE COLONNES IMPOSÉ");
  });
});

/* ------------------------------------------------------------------ */
/* Échecs de coercition et troncature                                  */
/* ------------------------------------------------------------------ */

describe("outil schema.extract — échecs de coercition et troncature", () => {
  it("une valeur numérique non convertible devient null et la ligne entièrement invalide est écartée", async () => {
    llmTable({
      columns: [{ name: "prix", type: "number" }],
      rows: [{ prix: "abc" }, { prix: "12.5" }, { prix: "" }],
    });

    const output = await schemaExtractTool.execute(
      extractInput({ html: "<p>catalogue</p>", fields: [{ name: "prix", type: "number" }] }),
      CONTEXT,
    );

    expect(output.rows).toEqual([{ prix: 12.5 }]);
    expect(output.rowCount).toBe(1);
    expect(output.discardedRows).toBe(2);
  });

  it("un booléen non convertible devient null (ligne écartée si isolée)", async () => {
    llmTable({
      columns: [{ name: "actif", type: "boolean" }],
      rows: [{ actif: "TRUE" }, { actif: "peut-être" }],
    });

    const output = await schemaExtractTool.execute(
      extractInput({ html: "<p>stock</p>", fields: [{ name: "actif", type: "boolean" }] }),
      CONTEXT,
    );
    expect(output.rows).toEqual([{ actif: true }]);
    expect(output.discardedRows).toBe(1);
  });

  it("tronque à maxRows et lève le flag truncated", async () => {
    llmTable({
      columns: [{ name: "ville", type: "string" }],
      rows: [{ ville: "Paris" }, { ville: "Lyon" }, { ville: "Nice" }],
    });

    const output = await schemaExtractTool.execute(extractInput({ html: "<p>villes</p>", maxRows: 2 }), CONTEXT);
    expect(output.rows).toEqual([{ ville: "Paris" }, { ville: "Lyon" }]);
    expect(output.rowCount).toBe(2);
    expect(output.truncated).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Source URL (fetch réel + garde SSRF)                                */
/* ------------------------------------------------------------------ */

describe("outil schema.extract — source URL réelle", () => {
  it("récupère la page avec l'UA plateforme et transmet le HTML riche au LLM", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<table><tr><td>Chaise — 49,50 €</td></tr></table>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    llmTable({ columns: [{ name: "article", type: "string" }], rows: [{ article: "Chaise — 49,50 €" }] });

    const output = await schemaExtractTool.execute(extractInput({ url: "https://exemple.com/catalogue" }), CONTEXT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers["User-Agent"]).toBe("Gen3ia-AI-Studio/1.0");
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
    // Le HTML est conservé TEL QUEL (signal riche), pas converti en texte.
    const [params] = mockedGenerate.mock.calls[0];
    expect(params.request.messages[0]?.content).toContain("<table><tr><td>Chaise — 49,50 €</td></tr></table>");
    expect(output.sourceChars).toBe("<table><tr><td>Chaise — 49,50 €</td></tr></table>".length);
    expect(output.rows).toEqual([{ article: "Chaise — 49,50 €" }]);
  });

  it("suit une redirection unique en revalidant l'URL", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "/catalogue-v2" } }))
      .mockResolvedValueOnce(
        new Response("<p>Contenu v2</p>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
      );
    llmTable({ columns: [{ name: "texte", type: "string" }], rows: [{ texte: "Contenu v2" }] });

    const output = await schemaExtractTool.execute(extractInput({ url: "https://exemple.com/catalogue" }), CONTEXT);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0].toString()).toBe("https://exemple.com/catalogue-v2");
    expect(mockedAssertUrl).toHaveBeenCalledTimes(2);
    expect(output.rows).toEqual([{ texte: "Contenu v2" }]);
  });

  it("propage l'erreur de la page sans masquage", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(schemaExtractTool.execute(extractInput({ url: "https://exemple.com/plante" }), CONTEXT)).rejects.toThrow(
      /statut HTTP 500/,
    );
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("refuse un type de contenu non supporté", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(schemaExtractTool.execute(extractInput({ url: "https://exemple.com/api" }), CONTEXT)).rejects.toThrow(
      /Type de contenu non supporté/,
    );
  });
});
