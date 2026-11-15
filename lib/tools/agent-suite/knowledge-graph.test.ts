import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Outil agent « knowledge.graph » — Document Knowledge Graph Builder (Task 140).
 *
 * Verrous :
 *  1. schéma d'entrée strict (documents 1→10, contenu borné 100→80 000,
 *     plafond de nœuds 10→80) ;
 *  2. découpage : document court = 1 segment (1 appel LLM), document long =
 *     segments de 6 000 caractères avec chevauchement de 500 (2 appels) ;
 *  3. extraction par segment via generateStructuredForUser — facturée au NOM
 *     de l'utilisateur (task « reasoning », maxTokens 2500), concurrence
 *     bornée, échec d'un segment = erreur française sans persistance ;
 *  4. fusion DÉTERMINISTE : libellés équivalents à la casse près dédupliqués
 *     avec poids cumulé et casse d'affichage la plus fréquente ; arêtes
 *     dédupliquées (paire triée + relation) avec force cumulée ; plafond
 *     maxNodes respecté et arêtes orphelines éliminées ;
 *  5. communautés : composantes connexes ≥ 3 nœuds nommées par leur nœud le
 *     plus lourd, le reste regroupé sous « divers » ;
 *  6. SVG DÉTERMINISTE : balise <svg>, entités XML échappées (&, <, >),
 *     re-render identique pour une même entrée ;
 *  7. livrable PERSISTÉ via la voie réelle (generateArtifact →
 *     storeArtifactBuffer) avec le userId du contexte.
 *
 * Frontières mockées (convention du dépôt) : voie de facturation LLM et
 * moteurs de documents — le sujet testé est le pipeline de l'outil.
 */

const generateForUserMock = vi.fn();
vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: (...args: unknown[]) => generateForUserMock(...args),
}));

const generateArtifactMock = vi.fn();
vi.mock("@/lib/documents/engine", () => ({
  generateArtifact: (...args: unknown[]) => generateArtifactMock(...args),
}));

const storeArtifactBufferMock = vi.fn();
vi.mock("@/lib/documents/artifact-store", () => ({
  storeArtifactBuffer: (...args: unknown[]) => storeArtifactBufferMock(...args),
}));

import {
  buildKnowledgeGraphSvg,
  chunkDocuments,
  knowledgeGraphTool,
  type GraphRenderEdge,
  type GraphRenderNode,
} from "./knowledge-graph";

const CONTEXT = { userId: "user-1", executionId: "exec-graph-1" };

const DOC =
  "Le document décrit plusieurs concepts clés du domaine, leurs relations et les outils associés, avec suffisamment de matière pour dépasser le seuil minimal de contenu exigé par le schéma d'entrée. ";

function llmJson(payload: unknown) {
  return { response: { text: JSON.stringify(payload) } };
}

function mockArtifactPipeline() {
  generateArtifactMock.mockResolvedValue({
    filename: "graphe-de-connaissances.md",
    format: "md",
    mimeType: "text/markdown",
    data: Buffer.from("# Graphe de connaissances"),
  });
  storeArtifactBufferMock.mockResolvedValue({
    artifactId: "stored-graph-1",
    name: "graphe-de-connaissances.md",
    storageKey: "users/user-1/artifacts/stored-graph-1/graphe-de-connaissances.md",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("outil knowledge.graph — schéma d'entrée", () => {
  it("accepte une entrée minimale avec le plafond de 50 nœuds par défaut", () => {
    const parsed = knowledgeGraphTool.inputSchema.parse({ documents: [{ content: DOC }] });
    expect(parsed.maxNodes).toBe(50);
    expect(parsed.focus).toBeUndefined();
  });

  it("refuse zéro document, plus de 10 documents, un contenu trop court ou un plafond hors bornes", () => {
    expect(() => knowledgeGraphTool.inputSchema.parse({ documents: [] })).toThrow();
    expect(() =>
      knowledgeGraphTool.inputSchema.parse({ documents: Array.from({ length: 11 }, () => ({ content: DOC })) }),
    ).toThrow();
    expect(() => knowledgeGraphTool.inputSchema.parse({ documents: [{ content: "trop court" }] })).toThrow();
    expect(() =>
      knowledgeGraphTool.inputSchema.parse({ documents: [{ content: DOC }], maxNodes: 9 }),
    ).toThrow();
    expect(() =>
      knowledgeGraphTool.inputSchema.parse({ documents: [{ content: DOC }], maxNodes: 81 }),
    ).toThrow();
  });
});

describe("découpage des documents — chevauchement de 500 caractères", () => {
  it("(e) un document court reste entier : un seul segment, un seul appel LLM", async () => {
    generateForUserMock.mockResolvedValueOnce(
      llmJson({ nodes: [{ label: "Concept unique", type: "concept" }], edges: [] }),
    );
    mockArtifactPipeline();

    const output = await knowledgeGraphTool.execute({ documents: [{ content: DOC }] }, CONTEXT);

    expect(generateForUserMock).toHaveBeenCalledTimes(1);
    const call = generateForUserMock.mock.calls[0][0];
    expect(call.userId).toBe("user-1");
    expect(call.request.task).toBe("reasoning");
    expect(call.request.maxTokens).toBe(2500);
    expect(output.graph.stats.chunks).toBe(1);
    expect(output.graph.stats.documents).toBe(1);
  });

  it("(f) un document de 11 000 caractères produit 2 segments avec chevauchement", async () => {
    const parts: string[] = [];
    for (let i = 0; i < 1100; i += 1) parts.push(`seg${i}#`.padEnd(10, "x"));
    const content = parts.join("");
    expect(content.length).toBe(11_000);
    expect(chunkDocuments([{ content }])).toHaveLength(2);
    // Le chevauchement : la fin du segment 1 (seg550…) est reprise au début du segment 2.
    const [, second] = chunkDocuments([{ content }]);
    expect(second.text.slice(0, 500)).toBe(content.slice(5500, 6000));

    generateForUserMock
      .mockResolvedValueOnce(llmJson({ nodes: [{ label: "Début du doc", type: "concept" }], edges: [] }))
      .mockResolvedValueOnce(llmJson({ nodes: [{ label: "Fin du doc", type: "concept" }], edges: [] }));
    mockArtifactPipeline();

    const output = await knowledgeGraphTool.execute({ documents: [{ content }] }, CONTEXT);

    expect(generateForUserMock).toHaveBeenCalledTimes(2);
    const firstPrompt = generateForUserMock.mock.calls[0][0].request.messages[0].content;
    const secondPrompt = generateForUserMock.mock.calls[1][0].request.messages[0].content;
    expect(firstPrompt).toContain("seg0#");
    expect(firstPrompt).toContain("seg599");
    expect(secondPrompt).toContain("seg550"); // zone de chevauchement
    expect(secondPrompt).toContain("seg1099");
    expect(secondPrompt).not.toContain("seg0#");
    expect(output.graph.stats.chunks).toBe(2);
  });

  it("transmet le titre du document et l'angle d'analyse au prompt d'extraction", async () => {
    generateForUserMock.mockResolvedValueOnce(
      llmJson({ nodes: [{ label: "Concept unique", type: "concept" }], edges: [] }),
    );
    mockArtifactPipeline();

    await knowledgeGraphTool.execute(
      { documents: [{ title: "Rapport annuel", content: DOC }], focus: "sécurité des données" },
      CONTEXT,
    );

    const prompt = generateForUserMock.mock.calls[0][0].request.messages[0].content;
    expect(prompt).toContain("Rapport annuel");
    expect(prompt).toContain("sécurité des données");
  });
});

describe("fusion déterministe des extractions", () => {
  it("(a) libellés équivalents à la casse près : dédupliqués, poids cumulé, casse la plus fréquente conservée", async () => {
    generateForUserMock
      .mockResolvedValueOnce(
        llmJson({
          nodes: [
            { label: "Machine Learning", type: "concept" },
            { label: "Python", type: "tool" },
          ],
          edges: [],
        }),
      )
      .mockResolvedValueOnce(
        llmJson({
          nodes: [
            { label: "machine learning", type: "concept" },
            { label: "machine learning", type: "concept" },
          ],
          edges: [],
        }),
      );
    mockArtifactPipeline();

    const output = await knowledgeGraphTool.execute(
      { documents: [{ content: DOC }, { content: DOC }] },
      CONTEXT,
    );

    expect(generateForUserMock).toHaveBeenCalledTimes(2);
    const machineLearning = output.graph.nodes.find(
      (node) => node.label.toLowerCase() === "machine learning",
    );
    expect(machineLearning).toBeDefined();
    expect(machineLearning?.weight).toBe(3);
    // « machine learning » apparaît 2 fois, « Machine Learning » 1 fois.
    expect(machineLearning?.label).toBe("machine learning");
    expect(output.graph.nodes).toHaveLength(2);
    expect(output.graph.stats.nodes).toBe(2);
  });

  it("(b) arêtes équivalentes (paire triée, casse ignorée) : force cumulée, orientation d'affichage stable", async () => {
    generateForUserMock
      .mockResolvedValueOnce(
        llmJson({
          nodes: [
            { label: "Python", type: "tool" },
            { label: "Pandas", type: "tool" },
          ],
          edges: [{ source: "Python", target: "Pandas", relation: "utilise" }],
        }),
      )
      .mockResolvedValueOnce(
        llmJson({
          nodes: [
            { label: "python", type: "tool" },
            { label: "pandas", type: "tool" },
          ],
          edges: [{ source: "pandas", target: "python", relation: "utilise" }],
        }),
      );
    mockArtifactPipeline();

    const output = await knowledgeGraphTool.execute(
      { documents: [{ content: DOC }, { content: DOC }] },
      CONTEXT,
    );

    expect(output.graph.edges).toHaveLength(1);
    expect(output.graph.edges[0]).toMatchObject({
      source: "Python",
      target: "Pandas",
      relation: "utilise",
      strength: 2,
    });
    expect(output.graph.stats.topRelations[0]).toBe("Python —utilise→ Pandas");
  });

  it("(c) plafond maxNodes respecté (poids, puis clé croissante) et arêtes orphelines éliminées", async () => {
    const nodes: { label: string; type: "concept" }[] = [];
    for (let i = 1; i <= 12; i += 1) {
      const repetitions = i <= 2 ? 3 : i <= 5 ? 2 : 1;
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        nodes.push({ label: `Concept ${String(i).padStart(2, "0")}`, type: "concept" });
      }
    }
    generateForUserMock.mockResolvedValueOnce(
      llmJson({
        nodes,
        edges: [
          { source: "Concept 01", target: "Concept 02", relation: "précède" },
          { source: "Concept 11", target: "Concept 12", relation: "voisin de" },
        ],
      }),
    );
    mockArtifactPipeline();

    const output = await knowledgeGraphTool.execute(
      { documents: [{ content: DOC }], maxNodes: 10 },
      CONTEXT,
    );

    expect(output.graph.nodes).toHaveLength(10);
    const labels = output.graph.nodes.map((node) => node.label);
    // Plafond : les 12 poids forment 2×3 + 3×2 + 7×1 ; départage par clé
    // croissante pour les poids égaux → Concept 11 et 12 écartés.
    expect(labels).not.toContain("Concept 11");
    expect(labels).not.toContain("Concept 12");
    // L'arête entre les deux nœuds écartés disparaît, l'autre survit.
    expect(output.graph.edges).toHaveLength(1);
    expect(output.graph.edges[0].source).toBe("Concept 01");
    expect(output.graph.edges[0].target).toBe("Concept 02");
    expect(output.graph.edges[0].strength).toBe(1);
  });

  it("communautés : composantes ≥ 3 nœuds nommées par le nœud le plus lourd, le reste en « divers »", async () => {
    generateForUserMock.mockResolvedValueOnce(
      llmJson({
        nodes: [
          { label: "Alpha", type: "concept" },
          { label: "Alpha", type: "concept" },
          { label: "Alpha", type: "concept" },
          { label: "Beta", type: "concept" },
          { label: "Beta", type: "concept" },
          { label: "Gamma", type: "concept" },
          { label: "Delta", type: "concept" },
        ],
        edges: [
          { source: "Alpha", target: "Beta", relation: "compose" },
          { source: "Beta", target: "Gamma", relation: "entraîne" },
        ],
      }),
    );
    mockArtifactPipeline();

    const output = await knowledgeGraphTool.execute({ documents: [{ content: DOC }] }, CONTEXT);

    expect(output.graph.clusters).toHaveLength(2);
    expect(output.graph.clusters[0]).toMatchObject({
      label: "Alpha",
      nodeLabels: expect.arrayContaining(["Alpha", "Beta", "Gamma"]),
    });
    expect(output.graph.clusters[0].nodeLabels).toHaveLength(3);
    expect(output.graph.clusters[1]).toMatchObject({ label: "divers", nodeLabels: ["Delta"] });
    expect(output.graph.stats.clusters).toBe(2);
  });

  it("échec d'extraction d'un segment : erreur française, rien n'est persisté", async () => {
    generateForUserMock.mockRejectedValue(new Error("solde insuffisant"));

    await expect(
      knowledgeGraphTool.execute({ documents: [{ content: DOC }, { content: DOC }] }, CONTEXT),
    ).rejects.toThrow(/extraction des concepts a échoué.*solde insuffisant/);
    expect(generateArtifactMock).not.toHaveBeenCalled();
    expect(storeArtifactBufferMock).not.toHaveBeenCalled();
  });
});

describe("SVG déterministe — structure et échappement", () => {
  const SVG_NODES: GraphRenderNode[] = [
    { key: "r&d <sigma> & co", label: "R&D <sigma> & Co", type: "concept", weight: 3 },
    { key: "python", label: "Python", type: "tool", weight: 1 },
    { key: "pandas", label: "Pandas", type: "tool", weight: 1 },
  ];
  const SVG_EDGES: GraphRenderEdge[] = [
    { sourceKey: "r&d <sigma> & co", targetKey: "python", relation: "utilise", strength: 3 },
  ];

  it("(d) contient la balise <svg>, le titre et la légende français, et échappe les entités XML", () => {
    const svg = buildKnowledgeGraphSvg(SVG_NODES, SVG_EDGES);
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).toContain("Graphe de connaissances");
    expect(svg).toContain("Légende :");
    expect(svg).toContain("<line");
    expect(svg).toContain("<circle");
    // Entités XML échappées — jamais de libellé brut dangereux.
    expect(svg).toContain("R&amp;D");
    expect(svg).toContain("&lt;sigma&gt;");
    expect(svg).toContain("&amp; Co");
    expect(svg).not.toContain("R&D");
    expect(svg).not.toContain("<sigma>");
  });

  it("(d) re-render identique pour une même entrée (aucune source d'aléa)", () => {
    const first = buildKnowledgeGraphSvg(SVG_NODES, SVG_EDGES);
    const second = buildKnowledgeGraphSvg(
      [...SVG_NODES].map((node) => ({ ...node })),
      [...SVG_EDGES].map((edge) => ({ ...edge })),
    );
    expect(second).toBe(first);
  });

  it("place le nœud le plus lourd au centre et plafonne le rayon (8 + poids, max 26)", () => {
    const heavy: GraphRenderNode[] = [
      { key: "noyau", label: "Noyau", type: "concept", weight: 40 },
      { key: "satellite", label: "Satellite", type: "tool", weight: 1 },
    ];
    const svg = buildKnowledgeGraphSvg(heavy, []);
    // Noyau (poids 40) : rayon plafonné à 26, centré en (450, 310).
    expect(svg).toContain('cx="450.0"');
    expect(svg).toContain('cy="310.0"');
    expect(svg).toContain('r="26"');
    // Satellite (poids 1) : rayon 9.
    expect(svg).toContain('r="9"');
  });
});

describe("outil knowledge.graph — persistance du rapport", () => {
  it("PERSISTE le rapport complet (stats + SVG brut + concepts + relations) pour l'utilisateur", async () => {
    generateForUserMock.mockResolvedValueOnce(
      llmJson({
        nodes: [
          { label: "Base de données", type: "tool" },
          { label: "Réplication", type: "concept" },
        ],
        edges: [{ source: "Base de données", target: "Réplication", relation: "assure" }],
      }),
    );
    mockArtifactPipeline();

    const output = await knowledgeGraphTool.execute(
      { documents: [{ title: "Architecture", content: DOC }] },
      CONTEXT,
    );

    expect(generateArtifactMock).toHaveBeenCalledTimes(1);
    expect(generateArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        executionId: "exec-graph-1",
        plan: expect.objectContaining({ title: "Graphe de connaissances", format: "md" }),
      }),
    );
    expect(storeArtifactBufferMock).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "user-1", name: "graphe-de-connaissances.md" }),
    );
    expect(output.artifactId).toBe("stored-graph-1");
    expect(output.filename).toBe("graphe-de-connaissances.md");

    // Le SVG brut est bien embarqué dans le livrable markdown.
    const plan = generateArtifactMock.mock.calls[0][0].plan;
    const flattened = JSON.stringify(plan.blocks);
    expect(flattened).toContain("<svg");
    expect(flattened).toContain("</svg>");
    // Les sections françaises du rapport.
    expect(flattened).toContain("Vue d'ensemble");
    expect(flattened).toContain("Concepts");
    expect(flattened).toContain("Relations");
    expect(flattened).toContain("Base de données");
  });
});
