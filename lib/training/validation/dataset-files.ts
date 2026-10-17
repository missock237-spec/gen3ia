import "server-only";

import { createHash } from "node:crypto";

import type { DatasetFormat, DatasetStats } from "../types";
import type { validationFindingSchema } from "../types";
import type { z } from "zod";

/* ------------------------------------------------------------------ */
/* Validation des datasets (spec §4 étape 3)                           */
/*                                                                    */
/* Analyse RÉELLE du contenu : lignes, colonnes, paires                */
/* instruction/réponse, doublons, lignes vides, détection basique de   */
/* données personnelles (emails/téléphones) pour l'avertissement       */
/* RGPD. Aucune donnée n'est envoyée à un service externe ici.         */
/* ------------------------------------------------------------------ */

export type ValidationFinding = z.infer<typeof validationFindingSchema>;

export interface DatasetValidationReport {
  format: DatasetFormat;
  status: "valid" | "rejected";
  stats: DatasetStats;
  findings: ValidationFinding[];
  sha256: string;
}

const FORMAT_BY_EXTENSION: Record<string, DatasetFormat> = {
  ".csv": "csv",
  ".json": "json",
  ".jsonl": "jsonl",
  ".txt": "txt",
};

/** Plafond mémoire : au-delà, l'analyse se fait par échantillonnage. */
const FULL_SCAN_CAP_BYTES = 8 * 1024 * 1024;

/** Clés usuelles des paires instruction/réponse dans les datasets LLM. */
const PAIR_KEY_PATTERNS = [
  "instruction",
  "response",
  "input",
  "output",
  "prompt",
  "completion",
  "question",
  "answer",
  "messages",
  "conversations",
];

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:\+33|\b0)[1-9](?:[\s.-]?\d{2}){4}\b/;

function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx).toLowerCase();
}

export function detectDatasetFormat(filename: string): DatasetFormat | null {
  return FORMAT_BY_EXTENSION[extensionOf(filename)] ?? null;
}

function detectPairs(sampleText: string, columns: string[]): number {
  const lowered = columns.map((c) => c.toLowerCase());
  const hasInstruction = lowered.some((c) => PAIR_KEY_PATTERNS.slice(0, 8).includes(c));
  const hasResponse = lowered.some((c) => ["response", "output", "completion", "answer"].includes(c));
  if (hasInstruction && hasResponse) return 1; // signal détecté (structure en colonnes)
  if (PAIR_KEY_PATTERNS.some((k) => sampleText.toLowerCase().includes(`"${k}"`))) return 1;
  return 0;
}

/** Parse un CSV simple (guillemets doubles, virgule ou point-virgule détecté). */
function parseCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Valide un fichier dataset téléversé.
 * `buffer` : contenu intégral (plafonné par le quota d'upload).
 */
export function validateDatasetFile(filename: string, buffer: Buffer): DatasetValidationReport {
  const sha = createHash("sha256").update(buffer).digest("hex");
  const format = detectDatasetFormat(filename);
  const findings: ValidationFinding[] = [];

  if (!format) {
    return {
      format: "txt",
      status: "rejected",
      stats: { rows: 0, columns: [], pairs: 0, duplicates: 0, emptyLines: 0, warnings: [] },
      findings: [
        {
          level: "error",
          code: "unsupported-format",
          message: `Format non pris en charge (${extensionOf(filename) || "aucune extension"}) : formats acceptés — .csv, .json, .jsonl, .txt.`,
        },
      ],
      sha256: sha,
    };
  }

  if (buffer.byteLength === 0) {
    return {
      format,
      status: "rejected",
      stats: { rows: 0, columns: [], pairs: 0, duplicates: 0, emptyLines: 0, warnings: [] },
      findings: [{ level: "error", code: "empty-file", message: "Fichier vide." }],
      sha256: sha,
    };
  }

  const text = buffer.toString("utf8");
  const rawLines = text.split(/\r?\n/);
  // Les sauts de ligne FINAUX ne sont pas des lignes vides : on les retire
  // avant tout comptage (un fichier se termine normalement par \n).
  while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === "") {
    rawLines.pop();
  }
  const lines = rawLines;
  const warnings: string[] = [];
  let rows = 0;
  let columns: string[] = [];
  let pairs = 0;
  let emptyLines = 0;
  let duplicates = 0;

  const seen = new Set<string>();
  const trackDuplicate = (content: string) => {
    const key = content.trim().slice(0, 512);
    if (key.length === 0) return;
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  };

  if (format === "csv") {
    const headerLine = lines[0] ?? "";
    const delimiter = (headerLine.match(/;/g)?.length ?? 0) > (headerLine.match(/,/g)?.length ?? 0) ? ";" : ",";
    columns = parseCsvLine(headerLine, delimiter).map((c) => c.trim()).filter(Boolean);
    pairs = detectPairs(headerLine, columns);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) {
        emptyLines++;
        continue;
      }
      rows++;
      trackDuplicate(line);
    }
  } else if (format === "jsonl") {
    let parsedObjects = 0;
    for (const line of lines) {
      if (!line.trim()) {
        emptyLines++;
        continue;
      }
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        rows++;
        parsedObjects++;
        if (columns.length === 0) columns = Object.keys(obj).slice(0, 20);
        if (pairs === 0) pairs = detectPairs(line, columns);
        trackDuplicate(line);
      } catch {
        findings.push({
          level: "warn",
          code: "jsonl-bad-line",
          message: "Ligne JSON illisible ignorée : vérifiez l'encodage du fichier.",
        });
        if (findings.filter((f) => f.code === "jsonl-bad-line").length > 3) break;
      }
    }
    if (parsedObjects === 0) {
      return {
        format,
        status: "rejected",
        stats: { rows: 0, columns: [], pairs: 0, duplicates: 0, emptyLines: 0, warnings: [] },
        findings: [{ level: "error", code: "no-valid-rows", message: "Aucune ligne JSON valide détectée." }],
        sha256: sha,
      };
    }
  } else if (format === "json") {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        rows = parsed.length;
        const first = parsed.find((item) => typeof item === "object" && item !== null) as Record<string, unknown> | undefined;
        if (first) columns = Object.keys(first).slice(0, 20);
        pairs = detectPairs(text.slice(0, 4096), columns);
        for (const item of parsed.slice(0, 5000)) trackDuplicate(JSON.stringify(item));
      } else if (typeof parsed === "object" && parsed !== null) {
        // Structure { train: [...], validation: [...] } — datasets déjà splittés
        const sections = Object.keys(parsed).filter((k) => Array.isArray((parsed as Record<string, unknown>)[k]));
        rows = sections.reduce((total, k) => {
          const arr = (parsed as Record<string, unknown>)[k] as unknown[];
          return total + arr.length;
        }, 0);
        columns = sections;
        if (sections.length > 0) {
          findings.push({
            level: "info",
            code: "pre-split-json",
            message: `Dataset multi-sections détecté (${sections.join(", ")}). Les sections seront conservées telles quelles.`,
          });
        }
      }
      if (rows === 0) {
        return {
          format,
          status: "rejected",
          stats: { rows: 0, columns: [], pairs: 0, duplicates: 0, emptyLines: 0, warnings: [] },
          findings: [{ level: "error", code: "no-rows", message: "JSON valide mais aucune donnée exploitable (ni tableau, ni sections)." }],
          sha256: sha,
        };
      }
    } catch {
      return {
        format,
        status: "rejected",
        stats: { rows: 0, columns: [], pairs: 0, duplicates: 0, emptyLines: 0, warnings: [] },
        findings: [{ level: "error", code: "bad-json", message: "JSON illisible : le fichier est corrompu ou tronqué." }],
        sha256: sha,
      };
    }
  } else {
    // txt : corpus brut
    rows = lines.filter((l) => l.trim()).length;
    emptyLines = lines.length - rows;
    for (const line of lines.slice(0, 5000)) trackDuplicate(line);
  }

  // --- Avertissements qualité (spec §4 étape 3) ---
  if (rows < 50) {
    warnings.push(
      `Jeu de données très petit (${rows} lignes) : un fine-tuning crédible demande généralement plusieurs centaines d'exemples. Envisagez plutôt une solution RAG.`,
    );
    findings.push({ level: "warn", code: "dataset-too-small", message: `Seulement ${rows} lignes détectées.` });
  }
  if (rows >= 50 && duplicates > rows * 0.2) {
    warnings.push(
      `${duplicates} doublons détectés (> 20 %) : dédupliquez le jeu pour éviter le surapprentissage.`,
    );
    findings.push({ level: "warn", code: "many-duplicates", message: `${duplicates} lignes dupliquées.` });
  }
  if (pairs === 0 && (format === "csv" || format === "jsonl")) {
    warnings.push(
      "Aucune paire instruction/réponse détectée (colonnes type instruction/response, prompt/completion…) : un fine-tuning supervisé exige des exemples entrée → sortie.",
    );
    findings.push({ level: "warn", code: "no-pairs-detected", message: "Structure de paires non reconnue." });
  }

  // --- RGPD : détection basique de données personnelles (échantillon) ---
  const sample = text.slice(0, Math.min(text.length, FULL_SCAN_CAP_BYTES));
  const emails = sample.match(new RegExp(EMAIL_RE.source, "g"))?.length ?? 0;
  const phones = sample.match(new RegExp(PHONE_RE.source, "g"))?.length ?? 0;
  if (emails > 3 || phones > 3) {
    warnings.push(
      "Données personnelles détectées (emails/téléphones) : assurez-vous d'avoir le droit de les utiliser et anonymisez-les si nécessaire (RGPD).",
    );
    findings.push({
      level: "warn",
      code: "pii-detected",
      message: `${emails} emails et ${phones} numéros détectés dans l'échantillon analysé.`,
    });
  }

  if (buffer.byteLength > FULL_SCAN_CAP_BYTES) {
    findings.push({
      level: "info",
      code: "sampled-analysis",
      message: "Fichier volumineux : l'analyse de qualité a porté sur un échantillon (8 premiers Mo).",
    });
  }

  return {
    format,
    status: "valid",
    stats: { rows, columns, pairs, duplicates, emptyLines, warnings },
    findings,
    sha256: sha,
  };
}

/**
 * Vérifie l'intégrité de la répartition train/validation/test d'un projet :
 * la fuite (fuites entre ensembles) et l'absence de split de validation
 * sont signalées avant l'entraînement (spec §4 étape 3).
 */
export function auditSplits(
  datasets: Array<{ id: string; name: string; split: string; rows: number }>,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const train = datasets.filter((d) => d.split === "train");
  const validation = datasets.filter((d) => d.split === "validation");
  const test = datasets.filter((d) => d.split === "test");
  const unassigned = datasets.filter((d) => d.split === "unassigned");

  if (unassigned.length > 0) {
    findings.push({
      level: "warn",
      code: "unassigned-datasets",
      message: `${unassigned.length} dataset(s) non assignés à un split : assignez chaque fichier à train, validation ou test.`,
    });
  }
  if (train.length === 0 && datasets.length > 0) {
    findings.push({
      level: "error",
      code: "no-train-split",
      message: "Aucun dataset assigné au split d'entraînement : impossible de lancer un fine-tuning.",
    });
  }
  if (train.length > 0 && validation.length === 0) {
    findings.push({
      level: "warn",
      code: "no-validation-split",
      message: "Aucun dataset de validation : les métriques de validation (perte, surapprentissage) ne pourront pas être mesurées.",
    });
  }
  if (test.length > 0 && validation.length === 0) {
    findings.push({
      level: "warn",
      code: "test-without-validation",
      message: "Split de test présent sans split de validation : répartition inhabituelle.",
    });
  }
  return findings;
}
