import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";
import { generateStructuredForUser } from "./llm-json";

/**
 * OUTIL AGENT « build.autofix » — Autonomous Error-to-Fix Pipeline (Task 140).
 *
 * Analyse un LOG DE BUILD brut (webhook CI, e-mail transféré, copier-coller),
 * LOCALISE les lignes fautives dans le dépôt GitHub, ÉCRIT le correctif et
 * CRÉE LA PULL REQUEST — en autonomie, via l'API REST GitHub officielle.
 *
 * Pipeline :
 *  1. ANALYSE DÉTERMINISTE du log (regex linéaires : TypeScript, webpack,
 *     Node.js, ENOENT, Python, gcc/générique) — extraction d'entrées
 *     { fichier, ligne?, message } dédupliquées, plafonnées à 15 ;
 *  2. LECTURE GitHub : validation du dépôt (default_branch utilisé quand
 *     la branche n'était PAS fournie), récupération du contenu des fichiers
 *     incriminés (base64, ≤ 512 Ko, plafond maxFilesToPatch) ;
 *  3. CORRECTIF par LLM FACTURÉ au nom de l'utilisateur
 *     (generateStructuredForUser — task « coding ») avec DÉFENSE
 *     SYSTÉMATIQUE : un correctif n'est appliqué QUE si son oldSnippet
 *     existe VERBATIM dans le fichier récupéré (sinon : écarté et signalé) ;
 *  4. PULL REQUEST : branche dédiée gen3ia-autofix-<id>, commit par
 *     correctif (PUT contents), PR française avec erreur analysée, cause
 *     racine et correctifs appliqués.
 *
 * Sécurité : GITHUB_TOKEN obligatoire (sinon erreur française immédiate),
 * appels REST timeout 20 s, segments d'URL encodés (encodeURIComponent),
 * aucun contenu exécuté localement — le pipeline ne fait QUE lire la
 * branche cible et écrire sur UNE NOUVELLE branche, jamais sur la base.
 */

const inputSchema = z.object({
  buildLog: z.string().min(50).max(100_000),
  owner: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  branch: z.string().max(200).default("main"),
  createPr: z.boolean().default(true),
  maxFilesToPatch: z.number().int().min(1).max(8).default(5),
});

export interface BuildAutofixErrorEntry {
  file: string;
  line?: number;
  message: string;
}

export interface BuildAutofixResult {
  repo: { owner: string; name: string; branch: string };
  analysis: {
    rootCause: string;
    errorEntries: BuildAutofixErrorEntry[];
    patches: Array<{ path: string; explanation: string }>;
  };
  prUrl?: string;
  prNumber?: number;
  fixBranch?: string;
  skipped: Array<{ path: string; reason: string }>;
}

const MAX_ERROR_ENTRIES = 15;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILE_EXCERPT = 24_000;
const MAX_LOG_EXCERPT = 8_000;
const PATCHES_SYSTEM_PROMPT = [
  "Tu es le moteur « Autonomous Error-to-Fix Pipeline » de Gen3ia. On te fournit un log de build en échec et le contenu des fichiers incriminés du dépôt. Ta mission : diagnostiquer la cause racine et produire des correctifs MINIMAUX et sûrs.",
  "",
  "Contraintes impératives :",
  "- Réponds UNIQUEMENT par un objet JSON valide, sans texte autour, sans fences markdown.",
  "- Chaque correctif remplace EXACTEMENT un extrait « oldSnippet » qui DOIT exister VERBATIM dans le contenu du fichier fourni — copie-le à l'identique, espaces et indentations compris (minimum 10 caractères).",
  "- « newSnippet » est le remplacement minimal : n'inclus JAMAIS le fichier entier.",
  "- N'expédie que des correctifs fiables ; si aucun n'est possible, renvoie un tableau « patches » vide.",
  "- « explanation » en français, concise et actionnable (elle devient le message de commit).",
  "",
  "Schéma JSON strict attendu :",
  '{"rootCause": string, "patches": [{"path": string, "oldSnippet": string (≥10 caractères, verbatim), "newSnippet": string, "explanation": string}]}',
].join("\n");

interface LlmPatch {
  path: string;
  oldSnippet: string;
  newSnippet: string;
  explanation: string;
}

interface LlmPatchPlan {
  rootCause: string;
  patches: LlmPatch[];
}

/** Nettoie un chemin de fichier extrait d'un log (préfixe d'horodatage CI, espaces). */
function cleanExtractedFile(raw: string): string {
  return raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s*/, "")
    .trim();
}

/**
 * Extraction DÉTERMINISTE des erreurs d'un log de build (linéaire, une passe
 * par ligne, formats TypeScript/webpack/Node/ENOENT/Python/générique).
 */
export function parseBuildLogErrors(log: string): BuildAutofixErrorEntry[] {
  const entries: BuildAutofixErrorEntry[] = [];
  const seen = new Set<string>();
  const push = (rawFile: string, line: number | undefined, message: string) => {
    const file = cleanExtractedFile(rawFile);
    if (!file || file.length > 500) return;
    const trimmedMessage = message.trim().slice(0, 400);
    const key = `${file}:${line ?? ""}:${trimmedMessage.slice(0, 120)}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (entries.length < MAX_ERROR_ENTRIES) {
      entries.push({ file, line, message: trimmedMessage });
    }
  };

  for (const rawLine of log.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    // TypeScript — format MSBuild « src/file.ts(12,5): error TS2322: message »
    let match = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
    if (match) {
      push(match[1], Number(match[2]), `${match[4]}: ${match[5]}`);
      continue;
    }
    // TypeScript — format tsc « src/file.ts:12:5 - error TS2322: message »
    match = /^(.+?):(\d+):(\d+) - error (TS\d+): (.*)$/.exec(line);
    if (match) {
      push(match[1], Number(match[2]), `${match[4]}: ${match[5]}`);
      continue;
    }
    // Variante non ancrée (préfixes de log CI) « error TS…: … (file:line:col) »
    match = /error TS\d+:.*?\((.+?):(\d+):(\d+)\)/.exec(line);
    if (match) {
      push(match[1], Number(match[2]), line.trim());
      continue;
    }
    // webpack — « ERROR in ./src/app.tsx 12:34 »
    match = /^ERROR in (.+?) (\d+):(\d+)/.exec(line);
    if (match) {
      push(match[1], Number(match[2]), line.trim());
      continue;
    }
    // webpack — module non résolu
    match = /Module not found: Error: Can't resolve '([^']+)' in '([^']+)'/.exec(line);
    if (match) {
      push(match[2], undefined, `Module « ${match[1]} » introuvable (importé depuis ${match[2]})`);
      continue;
    }
    // Node.js — module introuvable
    match = /Cannot find module '([^']+)'/.exec(line);
    if (match) {
      push(match[1], undefined, `Module « ${match[1]} » introuvable`);
      continue;
    }
    // Node.js/ENOENT — fichier introuvable
    match = /ENOENT: no such file or directory, open '([^']+)'/.exec(line);
    if (match) {
      push(match[1], undefined, `Fichier introuvable : ${match[1]}`);
      continue;
    }
    // Python — « File "app.py", line 10 »
    match = /File "(.+?)", line (\d+)/.exec(line);
    if (match) {
      push(match[1], Number(match[2]), line.trim());
      continue;
    }
    // Générique gcc/clang/rust — « file.c:12:5: error: message »
    match = /^(.+?):(\d+):(\d+): error: (.+)$/.exec(line);
    if (match) {
      push(match[1], Number(match[2]), match[4]);
      continue;
    }
  }
  return entries;
}

interface GitHubApi {
  (pathname: string, init?: RequestInit & { allowNotFound?: boolean }): Promise<unknown>;
}

/** Appel REST GitHub authentifié (timeout 20 s, erreur française au statut). */
function makeGh(token: string): GitHubApi {
  return async (pathname, init) => {
    const method = (init?.method as string | undefined) ?? "GET";
    let response: Response;
    try {
      response = await fetch(`https://api.github.com${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
        },
        body: init?.body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new Error(
        `Appel GitHub API en échec (${method} ${pathname}) : ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 404 && init?.allowNotFound) return null;
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(
        `Appel GitHub API en échec (${method} ${pathname}) — statut ${response.status}${detail ? ` : ${detail}` : ""}`,
      );
    }
    return response.json() as Promise<unknown>;
  };
}

function buildPrBody(result: BuildAutofixResult, patches: LlmPatch[]): string {
  const lines: string[] = [];
  lines.push("## Erreur analysée");
  lines.push("");
  if (result.analysis.errorEntries.length > 0) {
    for (const entry of result.analysis.errorEntries.slice(0, 10)) {
      lines.push(`- \`${entry.file}${entry.line !== undefined ? `:${entry.line}` : ""}\` — ${entry.message}`);
    }
  } else {
    lines.push("Voir la cause racine ci-dessous.");
  }
  lines.push("");
  lines.push("## Cause racine");
  lines.push("");
  lines.push(result.analysis.rootCause);
  lines.push("");
  lines.push("## Correctifs appliqués");
  lines.push("");
  for (const patch of patches) {
    lines.push(`- **${patch.path}** : ${patch.explanation}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("Correctif généré automatiquement par le pipeline d'auto-correction Gen3ia.");
  return lines.join("\n");
}

export const buildAutofixTool: ToolDefinition<z.infer<typeof inputSchema>, BuildAutofixResult> = {
  id: "build.autofix",
  name: "Autonomous Error-to-Fix Pipeline",
  description:
    "Analyze a raw build log (CI webhook, forwarded email, paste), locate the faulty lines in the GitHub repository, write the fix and open the pull request — autonomously. Deterministic error extraction, GitHub-backed file reading, LLM-generated patches applied only when verifiable verbatim, dedicated fix branch and French pull request.",
  category: "github",
  risk: "high",
  inputSchema,
  async execute(input, context) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error(
        "GITHUB_TOKEN manquant — le pipeline d'auto-correction ne peut pas accéder au dépôt GitHub.",
      );
    }

    // Branche « par défaut » ? (non fournie en entrée brute → default_branch du dépôt)
    const rawInput = input as Record<string, unknown>;
    const branchProvided = typeof rawInput.branch === "string" && (rawInput.branch as string).length > 0;
    const parsed = inputSchema.parse(input);
    const gh = makeGh(token);
    const enc = encodeURIComponent;

    // ─── 1. Analyse déterministe du log ───
    const errorEntries = parseBuildLogErrors(parsed.buildLog);
    if (errorEntries.length === 0) {
      throw new Error(
        "Aucune erreur identifiable dans le log fourni — le pipeline d'auto-correction a besoin d'un log de build contenant au moins une erreur exploitable (TypeScript, webpack, Node.js, ENOENT, Python ou gcc).",
      );
    }

    // ─── 2. Validation du dépôt + branche effective ───
    const repo = (await gh(`/repos/${enc(parsed.owner)}/${enc(parsed.name)}`)) as {
      default_branch?: string;
    };
    const branch = branchProvided ? parsed.branch : (repo.default_branch ?? parsed.branch);

    const skipped: Array<{ path: string; reason: string }> = [];
    const uniqueFiles = [...new Set(errorEntries.map((entry) => entry.file))];

    interface FetchedFile {
      path: string;
      content: string;
      sha: string;
    }
    const fetchedFiles = new Map<string, FetchedFile>();

    for (const file of uniqueFiles.slice(0, parsed.maxFilesToPatch)) {
      try {
        const payload = (await gh(
          `/repos/${enc(parsed.owner)}/${enc(parsed.name)}/contents/${enc(file)}?ref=${enc(branch)}`,
          { allowNotFound: true },
        )) as {
          type?: string;
          encoding?: string;
          content?: string;
          sha?: string;
          size?: number;
        } | null;
        if (!payload) {
          skipped.push({ path: file, reason: `fichier introuvable sur la branche « ${branch} »` });
          continue;
        }
        if (Array.isArray(payload) || payload.type !== "file" || payload.encoding !== "base64" || typeof payload.content !== "string") {
          skipped.push({ path: file, reason: "le chemin désigne un répertoire (ou un encodage non lisible), pas un fichier" });
          continue;
        }
        const content = Buffer.from(payload.content, "base64").toString("utf8");
        if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
          skipped.push({ path: file, reason: "fichier trop volumineux (dépasse 512 Ko) — hors périmètre du pipeline" });
          continue;
        }
        fetchedFiles.set(file, { path: file, content, sha: payload.sha ?? "" });
      } catch {
        skipped.push({ path: file, reason: `récupération impossible depuis GitHub sur la branche « ${branch} »` });
      }
    }
    for (const file of uniqueFiles.slice(parsed.maxFilesToPatch)) {
      skipped.push({ path: file, reason: "limite de fichiers analysés atteinte (maxFilesToPatch)" });
    }

    if (fetchedFiles.size === 0) {
      const result: BuildAutofixResult = {
        repo: { owner: parsed.owner, name: parsed.name, branch },
        analysis: { rootCause: "Aucun fichier incriminé n'a pu être lu dans le dépôt.", errorEntries, patches: [] },
        skipped,
      };
      return result;
    }

    // ─── 3. Correctifs LLM (facturés au nom de l'utilisateur) ───
    const patchPlanSchema = z.object({
      rootCause: z.string(),
      patches: z
        .array(
          z.object({
            path: z.string(),
            oldSnippet: z.string().min(10),
            newSnippet: z.string(),
            explanation: z.string(),
          }),
        )
        .max(parsed.maxFilesToPatch),
    });

    const filesSection = [...fetchedFiles.values()]
      .map(
        (file) =>
          `### ${file.path}\n\n\`\`\`\n${file.content.slice(0, MAX_FILE_EXCERPT)}\n\`\`\``,
      )
      .join("\n\n");

    const errorsSection = errorEntries
      .map((entry) => `- ${entry.file}${entry.line !== undefined ? `:${entry.line}` : ""} — ${entry.message}`)
      .join("\n");

    const plan: LlmPatchPlan = await generateStructuredForUser({
      userId: context.userId,
      executionId: context.executionId,
      task: "coding",
      maxTokens: 3_500,
      system: PATCHES_SYSTEM_PROMPT,
      user: [
        "Analyse ce log de build en échec et produis les correctifs pour les fichiers fournis.",
        "",
        "## Erreurs extraites (détection déterministe)",
        errorsSection,
        "",
        "## Extrait du log brut (8 Ko max)",
        parsed.buildLog.slice(0, MAX_LOG_EXCERPT),
        "",
        "## Contenu des fichiers du dépôt",
        filesSection,
      ].join("\n"),
      schema: patchPlanSchema,
    });

    // ─── Défense : seuls les correctifs VÉRIFIABLES sont retenus ───
    const appliedPatches: LlmPatch[] = [];
    for (const patch of plan.patches) {
      const file = fetchedFiles.get(patch.path);
      if (!file) {
        skipped.push({ path: patch.path, reason: "fichier absent de la liste récupérée depuis GitHub" });
        continue;
      }
      if (!file.content.includes(patch.oldSnippet)) {
        skipped.push({
          path: patch.path,
          reason: "oldSnippet introuvable verbatim dans le contenu actuel du fichier — correctif rejeté par sécurité",
        });
        continue;
      }
      // Remplacement sans interprétation des séquences « $… » du remplacement.
      file.content = file.content.replace(patch.oldSnippet, () => patch.newSnippet);
      appliedPatches.push(patch);
    }

    const baseResult: BuildAutofixResult = {
      repo: { owner: parsed.owner, name: parsed.name, branch },
      analysis: {
        rootCause: plan.rootCause,
        errorEntries,
        patches: appliedPatches.map((patch) => ({ path: patch.path, explanation: patch.explanation })),
      },
      skipped,
    };

    // ─── 4. Branche + commits + pull request ───
    if (!parsed.createPr || appliedPatches.length === 0) {
      return baseResult;
    }

    const ref = (await gh(`/repos/${enc(parsed.owner)}/${enc(parsed.name)}/git/ref/heads/${enc(branch)}`)) as {
      object?: { sha?: string };
    };
    const baseSha = ref.object?.sha;
    if (!baseSha) throw new Error(`Impossible de résoudre le SHA de la branche « ${branch} » sur GitHub.`);

    const fixBranch = `gen3ia-autofix-${randomUUID().slice(0, 8)}`;
    await gh(`/repos/${enc(parsed.owner)}/${enc(parsed.name)}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${fixBranch}`, sha: baseSha }),
    });

    for (const patch of appliedPatches) {
      const file = fetchedFiles.get(patch.path);
      if (!file) continue;
      const commitMessage = `fix: correction automatique — ${patch.explanation.slice(0, 72)}`;
      const updated = (await gh(`/repos/${enc(parsed.owner)}/${enc(parsed.name)}/contents/${enc(patch.path)}`, {
        method: "PUT",
        body: JSON.stringify({
          message: commitMessage,
          content: Buffer.from(file.content, "utf8").toString("base64"),
          branch: fixBranch,
          sha: file.sha,
        }),
      })) as { content?: { sha?: string } };
      if (updated.content?.sha) file.sha = updated.content.sha;
    }

    const pull = (await gh(`/repos/${enc(parsed.owner)}/${enc(parsed.name)}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: "fix: correction automatique de build (Gen3ia)",
        head: fixBranch,
        base: branch,
        body: buildPrBody(baseResult, appliedPatches),
      }),
    })) as { html_url?: string; number?: number };

    return {
      ...baseResult,
      prUrl: pull.html_url,
      prNumber: pull.number,
      fixBranch,
    };
  },
};
