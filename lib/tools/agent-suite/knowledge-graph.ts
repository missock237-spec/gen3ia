import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";
import { persistMarkdownDeliverable } from "./artifact-deliverable";
import { generateStructuredForUser } from "./llm-json";
import { mapWithConcurrency } from "@/lib/video/concurrency";

/**
 * OUTIL AGENT « knowledge.graph » — Document Knowledge Graph Builder (Task 140).
 *
 * D'une collection de documents, extrait les CONCEPTS et leurs RELATIONS puis
 * construit un GRAPHE visualisable :
 *  1. DÉCOUPAGE : chaque document > 6 000 caractères est segmenté en morceaux
 *     de 6 000 caractères avec un chevauchement de 500 (aucun lien perdu aux
 *     frontières) ;
 *  2. EXTRACTION par segment (task « reasoning », 2500 tokens, concurrence
 *     BORNÉE à 3 via mapWithConcurrency — jamais plus de 3 appels LLM
 *     simultanés) via generateStructuredForUser, facturé au nom de
 *     l'utilisateur ;
 * 3. FUSION DÉTERMINISTE : clés en minuscules (la casse la plus fréquente est
 *     conservée pour l'affichage), poids = nombre d'occurrences, arêtes
 *     dédupliquées par paire triée + relation (force cumulée), arêtes
 *     réflexes écartées, plafond `maxNodes` par poids décroissant (clé
 *     croissante en départage) et arêtes orphelines éliminées ;
 *  4. COMMUNAUTÉS : composantes connexes (union-find), étiquetées par leur
 *     nœud le plus lourd — seules celles de ≥ 3 nœuds sont nommées, les
 *     autres sont regroupées sous « divers » ;
 *  5. SVG DÉTERMINISTE (aucune dépendance) : nœud le plus lourd au centre,
 *     3 anneaux concentriques, gigue et couleurs issues d'un hachage stable
 *     des libellés, entités XML échappées ;
 *  6. PERSISTANCE du rapport (stats, SVG brut, concepts, relations) via
 *     persistMarkdownDeliverable — jamais un retour volatil.
 */

const CHUNK_SIZE = 6_000;
const CHUNK_OVERLAP = 500;
const EXTRACTION_CONCURRENCY = 3;

const NODE_TYPES = ["concept", "tool", "person", "organization", "metric", "event", "place"] as const;
type KnowledgeNodeType = (typeof NODE_TYPES)[number];

const KnowledgeGraphInput = z.object({
  documents: z
    .array(
      z.object({
        title: z.string().max(200).optional(),
        content: z.string().min(100).max(80_000),
      }),
    )
    .min(1)
    .max(10),
  maxNodes: z.number().int().min(10).max(80).default(50),
  focus: z.string().max(500).optional(),
});

/** Schéma STRICT de l'extraction produite par le LLM pour UN segment. */
const ChunkExtractionSchema = z.object({
  nodes: z
    .array(
      z.object({
        label: z.string().min(2).max(80),
        type: z.enum(NODE_TYPES),
      }),
    )
    .min(1)
    .max(40),
  edges: z
    .array(
      z.object({
        source: z.string().min(2).max(80),
        target: z.string().min(2).max(80),
        relation: z.string().min(2).max(60),
      }),
    )
    .max(60),
});

type ChunkExtraction = z.infer<typeof ChunkExtractionSchema>;

// ────────────────────────────────────────────────────────────────────────
// Types de sortie du graphe
// ────────────────────────────────────────────────────────────────────────

export interface KnowledgeGraphNode {
  label: string;
  type: KnowledgeNodeType;
  weight: number;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  relation: string;
  strength: number;
}

export interface KnowledgeGraphCluster {
  label: string;
  nodeLabels: string[];
}

export interface KnowledgeGraphStats {
  documents: number;
  chunks: number;
  nodes: number;
  edges: number;
  clusters: number;
  topRelations: string[];
}

/** Nœud prêt à dessiner (clé de fusion + libellé d'affichage). */
export interface GraphRenderNode {
  key: string;
  label: string;
  type: KnowledgeNodeType;
  weight: number;
}

/** Arête prête à dessiner (clés de fusion). */
export interface GraphRenderEdge {
  sourceKey: string;
  targetKey: string;
  relation: string;
  strength: number;
}

// ────────────────────────────────────────────────────────────────────────
// Découpage des documents
// ────────────────────────────────────────────────────────────────────────

export interface TextChunk {
  docIndex: number;
  chunkIndex: number;
  text: string;
}

/**
 * Découpe chaque document : segments de 6 000 caractères avance de 5 500
 * (chevauchement de 500). Les documents courts restent entiers.
 */
export function chunkDocuments(documents: { content: string }[]): TextChunk[] {
  const chunks: TextChunk[] = [];
  documents.forEach((document, docIndex) => {
    const { content } = document;
    if (content.length <= CHUNK_SIZE) {
      chunks.push({ docIndex, chunkIndex: 0, text: content });
      return;
    }
    const step = CHUNK_SIZE - CHUNK_OVERLAP;
    let chunkIndex = 0;
    for (let start = 0; start < content.length; start += step) {
      chunks.push({ docIndex, chunkIndex, text: content.slice(start, start + CHUNK_SIZE) });
      chunkIndex += 1;
      if (start + CHUNK_SIZE >= content.length) break;
    }
  });
  return chunks;
}

// ────────────────────────────────────────────────────────────────────────
// Fusion déterministe
// ────────────────────────────────────────────────────────────────────────

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Clé de fusion : minuscules + espaces réduits (la casse ne crée pas de doublon). */
function fusionKey(label: string): string {
  return collapseWhitespace(label).toLowerCase();
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Valeur la plus fréquente (première insérée en cas d'égalité). */
function mostFrequentEntry<T>(counts: Map<T, number>): { value: T; count: number } {
  let best: { value: T; count: number } | null = null;
  for (const entry of counts) {
    if (best === null || entry[1] > best.count) best = { value: entry[0], count: entry[1] };
  }
  if (best === null) throw new Error("Compteur vide : aucune valeur dominante.");
  return best;
}

interface NodeAccumulator {
  key: string;
  weight: number;
  typeCounts: Map<KnowledgeNodeType, number>;
  displayCounts: Map<string, number>;
}

interface EdgeAccumulator {
  sourceKey: string;
  targetKey: string;
  relation: string;
  strength: number;
}

function edgeSortKey(edge: { sourceKey: string; targetKey: string; relation: string }): string {
  return `${edge.sourceKey}\u0000${edge.targetKey}\u0000${edge.relation.toLowerCase()}`;
}

/**
 * Fusionne les extractions de tous les segments :
 *  - nœuds dédupliqués par clé (casse/espaces ignorés), poids cumulé, type et
 *    casse d'affichage les plus fréquents ;
 *  - arêtes dédupliquées par paire triée + relation (force cumulée),
 *    réflexes écartées ;
 *  - plafond `maxNodes` par poids (clé croissante en départage), arêtes
 *    orphelines (extrémités hors nœuds retenus ou jamais extraites) éliminées.
 */
function mergeExtractions(
  extractions: ChunkExtraction[],
  maxNodes: number,
): { renderNodes: GraphRenderNode[]; renderEdges: GraphRenderEdge[] } {
  const nodeIndex = new Map<string, NodeAccumulator>();
  const edgeIndex = new Map<string, EdgeAccumulator>();

  for (const extraction of extractions) {
    for (const node of extraction.nodes) {
      const key = fusionKey(node.label);
      if (key.length === 0) continue;
      let entry = nodeIndex.get(key);
      if (!entry) {
        entry = { key, weight: 0, typeCounts: new Map(), displayCounts: new Map() };
        nodeIndex.set(key, entry);
      }
      entry.weight += 1;
      entry.typeCounts.set(node.type, (entry.typeCounts.get(node.type) ?? 0) + 1);
      const display = collapseWhitespace(node.label);
      if (display.length > 0) {
        entry.displayCounts.set(display, (entry.displayCounts.get(display) ?? 0) + 1);
      }
    }
    for (const edge of extraction.edges) {
      const sourceKey = fusionKey(edge.source);
      const targetKey = fusionKey(edge.target);
      const relation = collapseWhitespace(edge.relation);
      if (sourceKey.length === 0 || targetKey.length === 0 || relation.length === 0) continue;
      if (sourceKey === targetKey) continue; // arête réflexe écartée
      const key = `${sourceKey < targetKey ? sourceKey : targetKey}\u0000${
        sourceKey < targetKey ? targetKey : sourceKey
      }\u0000${relation.toLowerCase()}`;
      let entry = edgeIndex.get(key);
      if (!entry) {
        entry = { sourceKey, targetKey, relation, strength: 0 };
        edgeIndex.set(key, entry);
      }
      entry.strength += 1;
    }
  }

  // Plafonnement : les maxNodes nœuds les plus lourds (clé croissante en
  // départage — déterminisme strict).
  const ranked = [...nodeIndex.values()].sort(
    (a, b) => b.weight - a.weight || compareStrings(a.key, b.key),
  );
  const kept = ranked.slice(0, Math.max(1, maxNodes));
  const keptKeys = new Set(kept.map((node) => node.key));

  const renderNodes: GraphRenderNode[] = kept.map((entry) => ({
    key: entry.key,
    label: mostFrequentEntry(entry.displayCounts).value,
    type: mostFrequentEntry(entry.typeCounts).value,
    weight: entry.weight,
  }));

  const renderEdges: GraphRenderEdge[] = [...edgeIndex.values()]
    .filter((edge) => keptKeys.has(edge.sourceKey) && keptKeys.has(edge.targetKey))
    .sort((a, b) => b.strength - a.strength || compareStrings(edgeSortKey(a), edgeSortKey(b)))
    .map((edge) => ({
      sourceKey: edge.sourceKey,
      targetKey: edge.targetKey,
      relation: edge.relation,
      strength: edge.strength,
    }));

  return { renderNodes, renderEdges };
}

// ────────────────────────────────────────────────────────────────────────
// Communautés (union-find sur les arêtes retenues)
// ────────────────────────────────────────────────────────────────────────

function buildClusters(
  renderNodes: GraphRenderNode[],
  renderEdges: GraphRenderEdge[],
): KnowledgeGraphCluster[] {
  const parent = new Map<string, string>();
  for (const node of renderNodes) parent.set(node.key, node.key);
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };
  for (const edge of renderEdges) {
    if (!parent.has(edge.sourceKey) || !parent.has(edge.targetKey)) continue;
    const sourceRoot = find(edge.sourceKey);
    const targetRoot = find(edge.targetKey);
    if (sourceRoot !== targetRoot) parent.set(sourceRoot, targetRoot);
  }

  const components = new Map<string, GraphRenderNode[]>();
  for (const node of renderNodes) {
    const root = find(node.key);
    const list = components.get(root) ?? [];
    list.push(node);
    components.set(root, list);
  }

  const byWeight = (a: GraphRenderNode, b: GraphRenderNode) =>
    b.weight - a.weight || compareStrings(a.key, b.key);
  const described = [...components.values()].map((nodes) => [...nodes].sort(byWeight));
  // Déterminisme : composantes triées par taille décroissante, puis par leur
  // nœud dominant (clé croissante).
  described.sort((a, b) => b.length - a.length || compareStrings(a[0].key, b[0].key));

  const clusters: KnowledgeGraphCluster[] = [];
  const diverseLabels: string[] = [];
  for (const ordered of described) {
    if (ordered.length >= 3) {
      clusters.push({ label: ordered[0].label, nodeLabels: ordered.map((node) => node.label) });
    } else {
      diverseLabels.push(...ordered.map((node) => node.label));
    }
  }
  if (diverseLabels.length > 0) clusters.push({ label: "divers", nodeLabels: diverseLabels });
  return clusters;
}

// ────────────────────────────────────────────────────────────────────────
// SVG déterministe (aucune dépendance)
// ────────────────────────────────────────────────────────────────────────

const SVG_WIDTH = 900;
const SVG_HEIGHT = 620;
const CENTER_X = 450;
const CENTER_Y = 310;
const RING_RADII = [120, 200, 280];

const NODE_TYPE_COLORS: Record<KnowledgeNodeType, string> = {
  concept: "#0899B4",
  tool: "#0A6E82",
  person: "#9E85FF",
  organization: "#7C5CFF",
  metric: "#B18AFF",
  event: "#0899B4",
  place: "#B18AFF",
};

const NODE_TYPE_LABELS: Record<KnowledgeNodeType, string> = {
  concept: "Concept",
  tool: "Outil",
  person: "Personne",
  organization: "Organisation",
  metric: "Métrique",
  event: "Événement",
  place: "Lieu",
};

/** Échappement des entités XML (libellés injectés dans le SVG). */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncateSvgLabel(label: string): string {
  return label.length > 18 ? `${label.slice(0, 18)}…` : label;
}

/** Hachage FNV-1a 32 bits — gigue déterministe par libellé. */
function deterministicHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Construit le SVG du graphe (900 × 620) : nœud le plus lourd au centre,
 * autres nœuds répartis sur 3 anneaux (120/200/280) par index, gigués par le
 * hachage du libellé. Rayon = 8 + poids (plafonné à 26), couleur par type,
 * arêtes en <line> d'opacité 0,15 + 0,12 × min(force, 4).
 *
 * Contrat : `nodes` est trié par poids décroissant (clé croissante en
 * départage) — le premier nœud occupe le centre.
 */
export function buildKnowledgeGraphSvg(nodes: GraphRenderNode[], edges: GraphRenderEdge[]): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" role="img" aria-label="Graphe de connaissances">`,
  );
  parts.push(`<rect x="0" y="0" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="#ffffff"/>`);
  parts.push(
    `<text x="${CENTER_X}" y="34" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="18" font-weight="600" fill="#0f172a">Graphe de connaissances</text>`,
  );

  if (nodes.length === 0) {
    parts.push("</svg>");
    return parts.join("\n");
  }

  const positions = new Map<string, { x: number; y: number; r: number }>();
  const place = (node: GraphRenderNode, x: number, y: number) => {
    const radius = Math.min(26, 8 + node.weight);
    // Maintien dans le cadre (titre en haut, légende en bas) — déterministe.
    const clampedX = Math.min(SVG_WIDTH - 30, Math.max(30, x));
    const clampedY = Math.min(SVG_HEIGHT - 54, Math.max(48, y));
    positions.set(node.key, { x: clampedX, y: clampedY, r: radius });
  };

  const [center, ...rest] = nodes;
  place(center, CENTER_X, CENTER_Y);

  const ringCounts = [0, 0, 0];
  for (let i = 0; i < rest.length; i += 1) ringCounts[i % RING_RADII.length] += 1;
  const ringCursors = [0, 0, 0];
  rest.forEach((node, index) => {
    const ring = index % RING_RADII.length;
    const slot = ringCursors[ring];
    ringCursors[ring] += 1;
    const hash = deterministicHash(node.key);
    const angleJitter = ((hash % 997) / 997 - 0.5) * 0.55;
    const radiusJitter = Math.floor(hash / 997) % 21 - 10; // ±10 px
    const angle = (2 * Math.PI * slot) / (ringCounts[ring] || 1) + ring * 0.7 + angleJitter;
    const radius = RING_RADII[ring] + radiusJitter;
    place(node, CENTER_X + radius * Math.cos(angle), CENTER_Y + radius * Math.sin(angle));
  });

  for (const edge of edges) {
    const source = positions.get(edge.sourceKey);
    const target = positions.get(edge.targetKey);
    if (!source || !target) continue;
    const opacity = (0.15 + 0.12 * Math.min(edge.strength, 4)).toFixed(2);
    parts.push(
      `<line x1="${source.x.toFixed(1)}" y1="${source.y.toFixed(1)}" x2="${target.x.toFixed(1)}" y2="${target.y.toFixed(1)}" stroke="#9AA0C2" stroke-width="1.5" stroke-opacity="${opacity}"/>`,
    );
  }

  for (const node of nodes) {
    const position = positions.get(node.key);
    if (!position) continue;
    parts.push(
      `<circle cx="${position.x.toFixed(1)}" cy="${position.y.toFixed(1)}" r="${position.r}" fill="${NODE_TYPE_COLORS[node.type]}" stroke="#ffffff" stroke-width="1.5"/>`,
    );
    // Libellé SOUS le nœud en haut de grille, AU-DESSUS en bas (aucun
    // chevauchement avec le centre du canevas).
    const labelY = position.y > CENTER_Y ? position.y - position.r - 4 : position.y + position.r + 12;
    parts.push(
      `<text x="${position.x.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#0f172a">${escapeXml(truncateSvgLabel(node.label))}</text>`,
    );
  }

  // Légende française — uniquement les types réellement présents.
  const presentTypes = NODE_TYPES.filter((type) => nodes.some((node) => node.type === type));
  const legendY = SVG_HEIGHT - 16;
  let legendX = 40;
  parts.push(
    `<text x="${legendX}" y="${legendY}" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#6B7194">Légende :</text>`,
  );
  legendX += 58;
  for (const type of presentTypes) {
    parts.push(`<rect x="${legendX}" y="${legendY - 9}" width="10" height="10" rx="2" fill="${NODE_TYPE_COLORS[type]}"/>`);
    const label = NODE_TYPE_LABELS[type];
    parts.push(
      `<text x="${legendX + 14}" y="${legendY}" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#6B7194">${escapeXml(label)}</text>`,
    );
    legendX += 14 + Math.round(label.length * 5.6) + 18;
  }

  parts.push("</svg>");
  return parts.join("\n");
}

// ────────────────────────────────────────────────────────────────────────
// Prompts d'extraction
// ────────────────────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = [
  "Tu es un analyste de connaissances spécialisé dans l'extraction de graphes de concepts à partir de documents.",
  "",
  "À partir du segment de document fourni, extrais :",
  '- les « nodes » : les concepts, outils, personnes, organisations, métriques, événements et lieux importants (libellés courts de 2 à 80 caractères) ;',
  '- les « edges » : les relations DIRECTES entre ces éléments (« relation » : verbe court à l\'infinitif, 2 à 60 caractères, en français).',
  "",
  "Règles impératives :",
  "- chaque élément apparaissant comme source ou cible d'une relation DOIT aussi figurer dans les nodes ;",
  "- pas de doublon dans les nodes ; pas d'arête d'un élément vers lui-même ;",
  "- reste STRICTEMENT fidèle au texte : n'invente ni concept ni relation ;",
  "- vise l'essentiel (au plus une trentaine de nœuds par segment).",
  "",
  "Réponds UNIQUEMENT avec un objet JSON valide : {\"nodes\": [{\"label\": string, \"type\": \"concept\" | \"tool\" | \"person\" | \"organization\" | \"metric\" | \"event\" | \"place\"}], \"edges\": [{\"source\": string, \"target\": string, \"relation\": string}]}",
].join("\n");

function buildExtractionUserPrompt(
  documents: { title?: string }[],
  chunk: TextChunk,
  focus?: string,
): string {
  const document = documents[chunk.docIndex];
  const documentTitle =
    document && document.title && document.title.trim().length > 0
      ? document.title.trim()
      : `Document ${chunk.docIndex + 1}`;
  const focusLine =
    focus && focus.trim().length > 0 ? `\n\nAngle d'analyse prioritaire : ${focus.trim()}` : "";
  return `Document : ${documentTitle} — segment ${chunk.chunkIndex + 1} :\n\n${chunk.text}${focusLine}`;
}

// ────────────────────────────────────────────────────────────────────────
// Rendu markdown
// ────────────────────────────────────────────────────────────────────────

/** Échappe une cellule de tableau markdown (| et sauts de ligne). */
function tableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function renderKnowledgeGraphMarkdown(params: {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  clusters: KnowledgeGraphCluster[];
  stats: KnowledgeGraphStats;
  svg: string;
}): string {
  const { nodes, edges, clusters, stats, svg } = params;
  const lines: string[] = [];

  lines.push("# Graphe de connaissances");
  lines.push("");
  lines.push("## Vue d'ensemble");
  lines.push("");
  lines.push("| Indicateur | Valeur |");
  lines.push("| --- | --- |");
  lines.push(`| Documents analysés | ${stats.documents} |`);
  lines.push(`| Segments analysés | ${stats.chunks} |`);
  lines.push(`| Concepts (nœuds) | ${stats.nodes} |`);
  lines.push(`| Relations (arêtes) | ${stats.edges} |`);
  lines.push(`| Communautés détectées | ${stats.clusters} |`);
  lines.push("");
  lines.push("## Graphe");
  lines.push("");
  lines.push(svg);
  lines.push("");
  if (clusters.length > 0) {
    lines.push("Communautés : " + clusters.map((cluster) => `**${cluster.label}** (${cluster.nodeLabels.length})`).join(" · "));
    lines.push("");
  }
  lines.push("## Concepts");
  lines.push("");
  lines.push("| Concept | Type | Poids |");
  lines.push("| --- | --- | --- |");
  for (const node of nodes) {
    lines.push(`| ${tableCell(node.label)} | ${NODE_TYPE_LABELS[node.type]} | ${node.weight} |`);
  }
  lines.push("");
  lines.push("## Relations");
  lines.push("");
  const topRelations = edges.slice(0, 30);
  if (topRelations.length === 0) {
    lines.push("- Aucune relation détectée entre les concepts extraits.");
  } else {
    for (const edge of topRelations) {
      lines.push(`- ${tableCell(edge.source)} —${tableCell(edge.relation)}→ ${tableCell(edge.target)} (×${edge.strength})`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────────
// Outil
// ────────────────────────────────────────────────────────────────────────

export interface KnowledgeGraphResult {
  graph: {
    nodes: KnowledgeGraphNode[];
    edges: KnowledgeGraphEdge[];
    clusters: KnowledgeGraphCluster[];
    stats: KnowledgeGraphStats;
  };
  artifactId: string;
  filename: string;
}

export const knowledgeGraphTool: ToolDefinition<z.infer<typeof KnowledgeGraphInput>, KnowledgeGraphResult> = {
  id: "knowledge.graph",
  name: "Document Knowledge Graph Builder",
  description:
    "Build a visualizable knowledge graph from a collection of documents: weighted concepts and typed relations extracted chunk-by-chunk (bounded LLM concurrency), merged deterministically (case-insensitive dedup, strength accumulation), clustered into communities, and rendered as an embeddable deterministic SVG — persisted as a real markdown report.",
  // NB : « knowledge » n'existe pas dans l'union ToolCategory (figée dans
  // lib/tools/types.ts, non modifiable ici) — la catégorie la plus proche
  // pour un outil d'analyse documentaire de la suite agent est « system ».
  category: "system",
  risk: "medium",
  inputSchema: KnowledgeGraphInput,
  async execute(input, context) {
    const parsed = KnowledgeGraphInput.parse(input);
    const chunks = chunkDocuments(parsed.documents);

    // Extraction par segment — concurrence BORNÉE à 3 appels LLM simultanés.
    const outcomes = await mapWithConcurrency(chunks, EXTRACTION_CONCURRENCY, (chunk) =>
      generateStructuredForUser({
        userId: context.userId,
        executionId: context.executionId,
        task: "reasoning",
        system: EXTRACTION_SYSTEM_PROMPT,
        user: buildExtractionUserPrompt(parsed.documents, chunk, parsed.focus),
        schema: ChunkExtractionSchema,
        maxTokens: 2_500,
      }),
    );

    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    if (rejected && rejected.status === "rejected") {
      const reason = rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason);
      throw new Error(`L'extraction des concepts a échoué sur au moins un segment du corpus : ${reason}`);
    }
    const extractions = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value] : [],
    );

    // Fusion déterministe + plafond + communautés + SVG.
    const { renderNodes, renderEdges } = mergeExtractions(extractions, parsed.maxNodes);
    const clusters = buildClusters(renderNodes, renderEdges);
    const svg = buildKnowledgeGraphSvg(renderNodes, renderEdges);

    const nodeByKey = new Map(renderNodes.map((node) => [node.key, node]));
    const labelOf = (key: string): string => {
      const node = nodeByKey.get(key);
      if (!node) throw new Error(`Nœud introuvable pour la clé « ${key} ».`); // défense interne
      return node.label;
    };

    const nodes: KnowledgeGraphNode[] = renderNodes.map((node) => ({
      label: node.label,
      type: node.type,
      weight: node.weight,
    }));
    const edges: KnowledgeGraphEdge[] = renderEdges.map((edge) => ({
      source: labelOf(edge.sourceKey),
      target: labelOf(edge.targetKey),
      relation: edge.relation,
      strength: edge.strength,
    }));

    const stats: KnowledgeGraphStats = {
      documents: parsed.documents.length,
      chunks: chunks.length,
      nodes: nodes.length,
      edges: edges.length,
      clusters: clusters.length,
      topRelations: edges
        .slice(0, 5)
        .map((edge) => `${edge.source} —${edge.relation}→ ${edge.target}`),
    };

    const markdown = renderKnowledgeGraphMarkdown({ nodes, edges, clusters, stats, svg });

    const deliverable = await persistMarkdownDeliverable({
      userId: context.userId,
      executionId: context.executionId,
      title: "Graphe de connaissances",
      markdown,
    });

    return {
      graph: { nodes, edges, clusters, stats },
      artifactId: deliverable.artifactId,
      filename: deliverable.filename,
    };
  },
};
