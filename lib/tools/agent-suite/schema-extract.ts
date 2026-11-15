import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";
import { assertPublicHttpUrl } from "@/lib/security/url-safety";
import { generateStructuredForUser } from "./llm-json";

/**
 * Task 140 — Outil « schema.extract » — Dynamic Schema Extractor.
 *
 * Transforme une page web (récupérée réellement, avec garde SSRF) ou du HTML
 * brut NON STRUCTURÉ en TABLEAUX JSON propres :
 *  - schéma cible imposé par l'utilisatrice/l'utilisateur (`fields`) ou
 *    détection automatique des colonnes par le LLM ;
 *  - extraction LLM facturée au wallet (generateStructuredForUser, tâche
 *    « document ») avec sortie JSON validée par zod ;
 *  - contrat de colonnes APPLIQUÉ après parsing (clés parasites supprimées,
 *    colonnes manquantes → null) ;
 *  - coercition de types déterministe (number/boolean/string) ;
 *  - les lignes entièrement invalides sont écartées et comptées
 *    (`discardedRows`), la sortie est tronquée à `maxRows` (flag `truncated`).
 *
 * Le HTML est conservé TEL QUEL pour l'extraction (signal plus riche que du
 * texte plat), plafonné à 300 000 caractères.
 */

const MAX_HTML_CHARS = 300_000;
const MAX_BODY_BYTES = 5_000_000;

const RequestedFieldSchema = z.object({
  name: z.string().min(1).max(60),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().max(300).optional(),
});

const SchemaExtractInput = z
  .object({
    url: z.string().url().optional(),
    html: z.string().max(MAX_HTML_CHARS).optional(),
    fields: z.array(RequestedFieldSchema).min(1).max(30).optional(),
    maxRows: z.number().int().min(1).max(100).default(25),
  })
  .refine((data) => Boolean(data.url ?? data.html), {
    message: "Fournissez une URL ou du HTML à extraire.",
  });

const ExtractedColumnSchema = z.object({
  name: z.string().min(1).max(60),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().optional(),
});

const ExtractedTableSchema = z.object({
  columns: z.array(ExtractedColumnSchema).min(1).max(30),
  rows: z
    .array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])))
    .max(200),
});

export type ExtractedColumn = z.infer<typeof ExtractedColumnSchema>;
type ExtractedRow = Record<string, string | number | boolean | null>;

export interface SchemaExtractResult {
  columns: ExtractedColumn[];
  rows: Array<Record<string, string | number | boolean | null>>;
  rowCount: number;
  truncated: boolean;
  sourceChars: number;
  discardedRows: number;
}

/* ------------------------------------------------------------------ */
/* Récupération du HTML source (garde SSRF, redirection unique)        */
/* ------------------------------------------------------------------ */

async function fetchSourceHtml(url: string, signal: AbortSignal | undefined): Promise<string> {
  const initial = await assertPublicHttpUrl(url);
  const headers = { "User-Agent": "Gen3ia-AI-Studio/1.0" };
  const effectiveSignal = signal ?? AbortSignal.timeout(15_000);
  let response = await fetch(initial, { redirect: "manual", headers, signal: effectiveSignal });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error("La page a renvoyé une redirection sans destination.");
    const redirected = await assertPublicHttpUrl(new URL(location, initial).toString());
    response = await fetch(redirected, { redirect: "manual", headers, signal: effectiveSignal });
    if (response.status >= 300 && response.status < 400) throw new Error("La page a renvoyé une chaîne de redirections.");
  }
  if (!response.ok) throw new Error(`La page a répondu avec le statut HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    throw new Error("Type de contenu non supporté : " + (contentType || "inconnu"));
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw new Error("La page dépasse la limite de 5 Mo.");
  const html = await response.text();
  if (Buffer.byteLength(html, "utf8") > MAX_BODY_BYTES) throw new Error("La page dépasse la limite de 5 Mo.");
  return html;
}

/* ------------------------------------------------------------------ */
/* Coercition déterministe des types                                   */
/* ------------------------------------------------------------------ */

function coerceCell(value: string | number | boolean | null | undefined, type: ExtractedColumn["type"]): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (type === "string") return String(value);
  if (type === "number") {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean") return value ? 1 : 0;
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  // type "boolean"
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

/* ------------------------------------------------------------------ */
/* Outil                                                              */
/* ------------------------------------------------------------------ */

const EXTRACT_SYSTEM_PROMPT = `Tu es un extracteur de données structurées (« Dynamic Schema Extractor ») de Gen3ia.

RÔLE : transformer le contenu HTML non structuré fourni en TABLEAUX JSON propres et exploitables.

MÉTHODE :
- Identifie les entités récurrentes du contenu (produits, articles, contacts, lignes de tableau…).
- Déduis les colonnes les plus fidèles au contenu réel : noms courts et explicites (snake_case), type "string", "number" ou "boolean".
- Une ligne = un enregistrement : chaque clé de ligne DOIT être un nom de colonne déclaré, aucune clé inventée.
- Ne JAMAIS inventer de données absentes du contenu : cellule inconnue → null.
- Une colonne non applicable au contenu → ne l'invente pas.

SORTIE : UNIQUEMENT un objet JSON valide exactement conforme au schéma :
{"columns":[{"name":"…","type":"string"|"number"|"boolean","description":"…"}],"rows":[{"col":"valeur"}]}

Limites : 30 colonnes maximum, 200 lignes maximum. Tout est en français (descriptions comprises). Aucun texte en dehors du JSON.`;

export const schemaExtractTool: ToolDefinition<z.infer<typeof SchemaExtractInput>, SchemaExtractResult> = {
  id: "schema.extract",
  name: "Dynamic Schema Extractor",
  description:
    "Transforme une page web publique (ou du HTML brut) en tableaux JSON propres selon un schéma de colonnes imposé ou détecté automatiquement, avec coercition de types et lignes invalides écartées.",
  category: "web",
  risk: "low",
  inputSchema: SchemaExtractInput,
  async execute(input, context) {
    // 1. Source : HTML fourni ou page réellement récupérée (garde SSRF).
    let sourceHtml: string;
    if (input.html) {
      sourceHtml = input.html;
    } else if (input.url) {
      sourceHtml = await fetchSourceHtml(input.url, context.signal);
    } else {
      throw new Error("Fournissez une URL ou du HTML à extraire.");
    }
    const content = sourceHtml.slice(0, MAX_HTML_CHARS);

    // 2. Contrat de colonnes : imposé par l'entrée, ou délégé à la détection auto.
    const fieldContract = input.fields
      ? input.fields.map((field) => ({ name: field.name, type: field.type, ...(field.description ? { description: field.description } : {}) }))
      : undefined;

    const userPrompt = [
      "CONTENU À EXTRAIRE (HTML brut, éventuellement tronqué) :",
      content,
      "",
      fieldContract
        ? `SCHÉMA DE COLONNES IMPOSÉ (contrat strict — n'utilise QUE ces colonnes, exactement ces noms) :\n${JSON.stringify(fieldContract)}`
        : "Aucun schéma imposé : détecte automatiquement les colonnes les plus fidèles au contenu.",
      "",
      `Nombre maximum de lignes pertinentes à retourner : ${input.maxRows}.`,
      "Renvoie uniquement le JSON {columns, rows}.",
    ].join("\n");

    // 3. Extraction LLM facturée (wallet) avec sortie validée par zod.
    const extracted = await generateStructuredForUser({
      userId: context.userId,
      executionId: context.executionId,
      task: "document",
      system: EXTRACT_SYSTEM_PROMPT,
      user: userPrompt,
      schema: ExtractedTableSchema,
      maxTokens: 3_500,
    });

    // 4. Colonnes finales : le contrat demandé PRIME sur la détection auto.
    const columns: ExtractedColumn[] = fieldContract ?? extracted.columns;

    // 5. Contrat + coercition : clés parasites supprimées, manquantes → null,
    //    types convertis ; une ligne dont TOUTES les cellules échouent est
    //    écartée et comptée dans discardedRows.
    const coercedRows: ExtractedRow[] = [];
    let discardedRows = 0;
    for (const row of extracted.rows) {
      const mapped: ExtractedRow = {};
      let hasData = false;
      for (const column of columns) {
        const coerced = coerceCell(row[column.name], column.type);
        mapped[column.name] = coerced;
        if (coerced !== null) hasData = true;
      }
      if (!hasData) {
        discardedRows += 1;
        continue;
      }
      coercedRows.push(mapped);
    }

    // 6. Troncature déterministe à maxRows.
    const truncated = coercedRows.length > input.maxRows;
    const rows = truncated ? coercedRows.slice(0, input.maxRows) : coercedRows;

    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      sourceChars: content.length,
      discardedRows,
    };
  },
};
