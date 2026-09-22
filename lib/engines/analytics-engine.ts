import "server-only";
import { z } from "zod";
import { buildDocument } from "./document-engine";
import type { EngineFeature } from "./types";

/**
 * Moteur 5 — Analytics Engine.
 *
 * Trois couches :
 *  1. Agrégations pures (testées) : summarizeNumbers, timeseriesByDay,
 *     linearForecast, forecastDaily — aucune dépendance d'infrastructure.
 *  2. KPI par module : chaque module envoie ses enregistrements et récupère
 *     un instantané homogène (valeur, delta, formatage).
 *  3. Rapport narratif : combine agrégats + AI Engine (synthèse) + Document
 *     Engine (PDF/DOCX téléchargeable) pour produire un rapport complet.
 */

export interface NumberSummary {
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
  median: number;
  p90: number;
}

export function summarizeNumbers(values: number[]): NumberSummary {
  if (values.length === 0) return { count: 0, sum: 0, avg: 0, min: 0, max: 0, median: 0, p90: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const median = sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const p90Index = Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1);
  return {
    count: sorted.length,
    sum,
    avg: sum / sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median,
    p90: sorted[p90Index],
  };
}

export interface DayPoint {
  date: string;
  value: number;
}

/**
 * Agrège des enregistrements par jour calendaire (UTC). `value` peut être
 * absent (comptage), ou être un nombre direct, ou un chemin `a.b` dans les
 * données. `sign` permet d'inverser (ex. sorties de trésorerie négatives).
 */
export function timeseriesByDay(
  records: Array<Record<string, unknown>>,
  dateField: string,
  valueField?: string,
  sign: 1 | -1 = 1,
): DayPoint[] {
  const buckets = new Map<string, number>();
  for (const record of records) {
    const rawDate = getAtPath(record, dateField);
    if (typeof rawDate !== "string" && typeof rawDate !== "number") continue;
    const date = new Date(rawDate);
    if (Number.isNaN(date.getTime())) continue;
    const key = date.toISOString().slice(0, 10);
    let value: number;
    if (!valueField) value = 1;
    else {
      const raw = getAtPath(record, valueField);
      value = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(value)) continue;
    }
    buckets.set(key, (buckets.get(key) ?? 0) + sign * value);
  }
  return [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, value]) => ({ date, value }));
}

/** Lecture de chemin pointé : getAtPath({a:{b:3}}, "a.b") → 3. Chemin vide → source. */
export function getAtPath(source: Record<string, unknown>, path: string): unknown {
  if (!path) return source;
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) return (acc as Record<string, unknown>)[key];
    return undefined;
  }, source);
}

export interface ForecastPoint {
  x: number;
  y: number;
}

export interface LinearForecast {
  slope: number;
  intercept: number;
  r2: number;
  predictions: number[];
}

/**
 * Régression linéaire par moindres carrés. Prédit `horizon` valeurs suivant
 * le dernier point. Avec < 2 points, prévision plate (dernière valeur) et
 * r² = 0 — l'appelant peut toujours afficher quelque chose d'honnête.
 */
export function linearForecast(points: ForecastPoint[], horizon: number): LinearForecast {
  const n = points.length;
  if (n === 0) return { slope: 0, intercept: 0, r2: 0, predictions: Array.from({ length: horizon }, () => 0) };
  if (n === 1) return { slope: 0, intercept: points[0].y, r2: 0, predictions: Array.from({ length: horizon }, () => points[0].y) };

  const sumX = points.reduce((acc, p) => acc + p.x, 0);
  const sumY = points.reduce((acc, p) => acc + p.y, 0);
  const sumXY = points.reduce((acc, p) => acc + p.x * p.y, 0);
  const sumX2 = points.reduce((acc, p) => acc + p.x * p.x, 0);
  const sumY2 = points.reduce((acc, p) => acc + p.y * p.y, 0);
  const denom = n * sumX2 - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  const meanY = sumY / n;
  const ssTot = points.reduce((acc, p) => acc + (p.y - meanY) ** 2, 0);
  const ssRes = points.reduce((acc, p) => acc + (p.y - (slope * p.x + intercept)) ** 2, 0);
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);

  const lastX = points[n - 1].x;
  const predictions = Array.from({ length: horizon }, (_, i) => slope * (lastX + i + 1) + intercept);
  return { slope, intercept, r2, predictions };
}

/**
 * Prévision quotidienne : comble les jours manquants par zéro puis projette
 * `horizonDays` avec la tendance linéaire. Les valeurs négatives de tendance
 * sont bornées à 0 pour les compteurs ; les montants signés sont conservés.
 */
export function forecastDaily(series: DayPoint[], horizonDays: number, clampNonNegative = true): { history: DayPoint[]; forecast: DayPoint[]; r2: number } {
  if (series.length === 0) return { history: [], forecast: [], r2: 0 };
  const filled: DayPoint[] = [];
  const start = new Date(`${series[0].date}T00:00:00Z`);
  const end = new Date(`${series[series.length - 1].date}T00:00:00Z`);
  const byDate = new Map(series.map((p) => [p.date, p.value]));
  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const key = cursor.toISOString().slice(0, 10);
    filled.push({ date: key, value: byDate.get(key) ?? 0 });
  }
  const points = filled.map((p, index) => ({ x: index, y: p.value }));
  const { slope, intercept, r2, predictions } = linearForecast(points, horizonDays);
  const forecast = predictions.map((y, i) => {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() + i + 1);
    const value = clampNonNegative ? Math.max(0, y) : y;
    return { date: date.toISOString().slice(0, 10), value: Math.round(value * 100) / 100 };
  });
  void slope;
  void intercept;
  return { history: filled, forecast, r2 };
}

/** Formatage monétaire homogène (EUR par défaut, Intl). */
export function formatMoney(amount: number, currency = "EUR"): string {
  try {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/* ------------------------------------------------------------------ */
/* Rapport narratif (AI + Document)                                   */
/* ------------------------------------------------------------------ */

const ReportContentSchema = z.object({
  headline: z.string().min(3).max(200),
  summary: z.string().min(20).max(4_000),
  highlights: z.array(z.string()).max(10).default([]),
  risks: z.array(z.string()).max(10).default([]),
  recommendations: z.array(z.string()).max(10).default([]),
});
export type ReportContent = z.infer<typeof ReportContentSchema>;

export interface BuildReportInput {
  userId: string;
  feature: EngineFeature;
  title: string;
  /** Contexte chiffré à analyser : KPI, agrégats, extraits. */
  facts: string;
  format?: "pdf" | "docx" | "md";
  periodLabel?: string;
}

export interface BuildReportResult {
  content: ReportContent;
  markdown: string;
  artifactId?: string;
  filename?: string;
  provider: string;
  model: string;
}

/**
 * Génère un rapport complet : synthèse IA structurée + rendu document
 * téléchargeable. Les faits sont fournis par le module appelant (le moteur
 * n'interroge pas Firestore lui-même — responsabilité du module de composer
 * les données fraîches).
 */
export async function buildReport(input: BuildReportInput): Promise<BuildReportResult> {
  const { runAIJSON } = await import("./ai-engine");
  const result = await runAIJSON({
    userId: input.userId,
    feature: input.feature,
    system:
      "Tu es un analyste d'entreprise senior. Tu rédiges des rapports concis, factuels, orientés décision, en français. " +
      "Réponds UNIQUEMENT avec un objet JSON: {\"headline\": string, \"summary\": string, \"highlights\": string[], \"risks\": string[], \"recommendations\": string[]}. " +
      "Ne ré invente jamais de chiffres absents des faits fournis.",
    prompt:
      `Titre du rapport : ${input.title}\n` +
      (input.periodLabel ? `Période : ${input.periodLabel}\n` : "") +
      `FAITS COLLECTÉS (source de vérité) :\n${input.facts}\n\n` +
      "Rédige le rapport : titre accrocheur, résumé exécutif (3-6 phrases), points saillants chiffrés, risques, recommandations actionnables.",
    schema: ReportContentSchema,
    label: `rapport ${input.title}`,
    maxTokens: 2_000,
  });

  const content = result.data;
  const lines: string[] = [`# ${content.headline}`, "", content.summary, ""];
  if (content.highlights.length) lines.push("## Points saillants", ...content.highlights.map((h) => `- ${h}`), "");
  if (content.risks.length) lines.push("## Risques", ...content.risks.map((r) => `- ${r}`), "");
  if (content.recommendations.length) lines.push("## Recommandations", ...content.recommendations.map((r) => `- ${r}`), "");

  const markdown = lines.join("\n");
  let artifactId: string | undefined;
  let filename: string | undefined;
  try {
    const doc = await buildDocument({
      userId: input.userId,
      feature: input.feature,
      title: content.headline,
      format: input.format ?? "pdf",
      markdown,
    });
    artifactId = doc.artifactId;
    filename = doc.filename;
  } catch {
    // Le rapport reste utile sans le fichier : le texte est renvoyé quoiqu'il
    // arrive. Une panne du moteur documentaire ne doit pas perdre la synthèse.
  }

  return { content, markdown, artifactId, filename, provider: result.provider, model: result.model };
}
