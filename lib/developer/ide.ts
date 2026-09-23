/**
 * Utilitaires purs du Workshop IDE — utilisés côté client (rendu) et côté
 * serveur/tests. Aucune dépendance Node ni Firebase.
 */

import type { TerminalEntry } from "@/lib/agents/runtime/terminal-sessions";

export interface ErrorRef {
  /** Chemin de fichier mentionné par l'erreur. */
  path: string;
  line?: number;
  column?: number;
  /** Extrait de la ligne d'erreur d'origine. */
  source: string;
}

const REF_PATTERNS: Array<RegExp> = [
  // Node / general : file.js:42:7 — fichier.js:42
  /(?:[(\s'"=]|^)((?:[\w./@-]+\/)?[\w@.-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|php|sh|html|css|json|yml|yaml|sql))(?::(\d+))(?::(\d+))?/g,
  // Python : File "app.py", line 42
  /File\s+"((?:[\w./-]+\/)?[\w.-]+\.py)",\s+line\s+(\d+)/g,
];

/** Extrait les références fichier:ligne depuis une sortie terminal. */
export function parseErrorRefs(text: string | undefined): ErrorRef[] {
  if (!text) return [];
  const seen = new Set<string>();
  const refs: ErrorRef[] = [];
  for (const line of text.split("\n")) {
    for (const pattern of REF_PATTERNS) {
      pattern.lastIndex = 0;
      let match = pattern.exec(line);
      while (match) {
        const path = match[1];
        const lineNo = match[2] ? Number(match[2]) : undefined;
        const column = match[3] ? Number(match[3]) : undefined;
        const key = `${path}:${lineNo ?? ""}:${column ?? ""}`;
        if (!seen.has(key)) {
          seen.add(key);
          refs.push({ path, line: lineNo, column, source: line.trim().slice(0, 300) });
        }
        match = pattern.exec(line);
      }
    }
  }
  return refs.slice(0, 50);
}

export interface TestRunResult {
  /** Index de l'entrée terminal d'origine. */
  entryIndex: number;
  command: string;
  passed: boolean | null;
  durationMs?: number;
  createdAt: string;
  /** Résumé détecté (ex. « 12 passed », « 2 failed »). */
  summary?: string;
  exitCode?: number;
}

const TEST_COMMAND_PATTERN = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|\bvitest\b|\bjest\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bnode\s+--test\b/i;
const SUMMARY_PATTERNS = [
  /(\d+)\s+(?:test[s]?\s+)?passed/i,
  /Tests?:\s*(\d+)\s*passed(?:,\s*(\d+)\s*failed)?/i,
  /(\d+)\s*(?:tests?)\s*(?:passed|réussis)/i,
  /(\d+)\s+failed/i,
];

/** Dérive les résultats de tests depuis l'historique terminal (commandes de test). */
export function extractTestRuns(entries: TerminalEntry[]): TestRunResult[] {
  const results: TestRunResult[] = [];
  for (const entry of entries) {
    if (!TEST_COMMAND_PATTERN.test(entry.command)) continue;
    const output = `${entry.stdout ?? ""}\n${entry.stderr ?? ""}`;
    let passed: boolean | null = typeof entry.exitCode === "number" ? entry.exitCode === 0 : entry.success === true ? true : entry.success === false ? false : null;
    let summary: string | undefined;
    const passedMatch = output.match(/(\d+)\s*(?:tests?\s*)?(?:passed|réussis)/i);
    const failedMatch = output.match(/(\d+)\s*(?:tests?\s*)?failed|(\d+)\s*(?:tests?\s*)?(?:échoué|en échec)/i);
    if (passedMatch && Number(passedMatch[1]) > 0) {
      const failed = failedMatch ? Number(failedMatch[1]) : 0;
      summary = failed > 0 ? `${passedMatch[1]} réussis · ${failed} échoués` : `${passedMatch[1]} réussis`;
      passed = failed === 0;
    } else if (failedMatch && Number(failedMatch[1]) > 0) {
      summary = `${failedMatch[1]} échoués`;
      passed = false;
    }
    if (summary === undefined && passed !== null) summary = passed ? "Succès (exit 0)" : "Échec";
    results.push({
      entryIndex: entry.index,
      command: entry.command,
      passed,
      durationMs: entry.durationMs,
      createdAt: entry.createdAt,
      summary,
      exitCode: entry.exitCode,
    });
  }
  return results.slice(-50);
}

/** Langage Monaco détecté à partir du nom de fichier / langage d'artefact. */
export function monacoLanguageFor(filenameOrLanguage: string): string {
  const value = filenameOrLanguage.toLowerCase();
  if (/\.(tsx?|jsx?|mjs|cjs)$/.test(value) || /^(typescript|javascript|ts|js)$/.test(value)) {
    if (value.endsWith(".tsx") || value === "tsx") return "typescript";
    if (value.endsWith(".jsx")) return "javascript";
    if (/\.(ts|tsx)$/.test(value) || value === "typescript" || value === "ts") return "typescript";
    return "javascript";
  }
  if (value.endsWith(".py") || value === "python" || value === "py") return "python";
  if (value.endsWith(".html") || value === "html") return "html";
  if (value.endsWith(".css") || value === "css") return "css";
  if (value.endsWith(".json") || value === "json") return "json";
  if (value.endsWith(".md") || value === "markdown" || value === "md") return "markdown";
  if (/\.(yml|yaml)$/.test(value)) return "yaml";
  if (value.endsWith(".sql")) return "sql";
  if (value.endsWith(".sh") || value === "shell" || value === "bash") return "shell";
  return "plaintext";
}
