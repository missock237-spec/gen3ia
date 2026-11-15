import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";

/**
 * OUTIL AGENT « decision.analyze » — Probability & Odds Decision Engine (Task 140).
 *
 * Moteur d'analyse probabiliste DÉTERMINISTE : AUCUN appel LLM, aucune source
 * d'aléa — les chiffres sont fiables et reproductibles à l'identique.
 *
 * Pour chaque option (distribution discrète d'issues pondérées) :
 *  - espérance, variance, écart-type ;
 *  - simulation Monte-Carlo reproductible : PRNG mulberry32 seedé par un
 *    hachage FNV-1a 32 bits de l'entrée (mêmes entrées ⇒ mêmes tirages) ;
 *  - probabilité de perte, percentile à 5 % (P5), CVaR à 5 % (moyenne des
 *    5 % pires scénarios), percentile à 95 % (upside), interpolation
 *    linéaire exacte entre statistiques d'ordre ;
 *  - score adapté à la tolérance au risque : averse → CVaR5, neutre →
 *    EV − 0,25·σ, avide → EV + 0,25·(P95 − EV) ;
 *  - sensibilité : chaque probabilité d'issue est décalée de ±10 %
 *    (renormalisation proportionnelle des autres issues) et l'impact sur
 *    l'espérance est rapporté pour les 5 influences dominantes ;
 *  - avertissements : normalisation des probabilités (somme ≠ 1 ± 0,01),
 *    option déterministe (issue unique), volatilité élevée (CV > 2) ;
 *  - recommandation française déterministe citant la tolérance et la métrique
 *    décisive du choix.
 */

type RiskTolerance = "averse" | "neutral" | "seeking";

const DecisionAnalyzeInput = z.object({
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(120),
        outcomes: z
          .array(
            z.object({
              label: z.string().min(1).max(200),
              probability: z.number().min(0).max(1),
              value: z.number().finite(),
            }),
          )
          .min(1)
          .max(20),
      }),
    )
    .min(1)
    .max(10),
  simulations: z.number().int().min(500).max(10_000).default(5_000),
  riskTolerance: z.enum(["averse", "neutral", "seeking"]).default("neutral"),
});

// ────────────────────────────────────────────────────────────────────────
// Sortie
// ────────────────────────────────────────────────────────────────────────

export interface DecisionOptionAnalysis {
  label: string;
  expectedValue: number;
  stdDev: number;
  probabilityOfLoss: number;
  p5: number;
  cvar5: number;
  upsideP95: number;
  score: number;
  warnings: string[];
}

export interface DecisionSensitivityInfluence {
  optionLabel: string;
  outcomeLabel: string;
  deltaHigh: number;
  deltaLow: number;
}

export interface DecisionAnalyzeOutput {
  perOption: DecisionOptionAnalysis[];
  ranking: string[];
  recommendation: string;
  sensitivity: { topInfluences: DecisionSensitivityInfluence[] };
  assumptions: { simulations: number; riskTolerance: RiskTolerance; seed: string };
  warnings: string[];
}

// ────────────────────────────────────────────────────────────────────────
// Briques déterministes
// ────────────────────────────────────────────────────────────────────────

/** PRNG mulberry32 — même graine ⇒ même séquence (implémentation standard). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hachage FNV-1a 32 bits — graine déterministe de l'entrée. */
function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Percentile par interpolation linéaire entre statistiques d'ordre. */
function percentile(sortedValues: number[], q: number): number {
  const count = sortedValues.length;
  if (count === 0) return 0;
  if (count === 1) return sortedValues[0];
  const position = (count - 1) * q;
  const base = Math.floor(position);
  const rest = position - base;
  const current = sortedValues[base];
  if (rest > 0 && base + 1 < count) {
    return current + rest * (sortedValues[base + 1] - current);
  }
  return current;
}

interface PreparedOutcome {
  label: string;
  probability: number;
  value: number;
}

interface PreparedOption {
  label: string;
  outcomes: PreparedOutcome[];
  warnings: string[];
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2).replace(".", ",") : "∞";
}

function formatSum(sum: number): string {
  return Number(sum.toFixed(4)).toString().replace(".", ",");
}

/**
 * Normalise les issues d'une option : somme nulle → erreur française ;
 * somme hors de 1 ± 0,01 → renormalisation AVERTIE. Les probabilités
 * utilisées par le moteur sont toujours exactement sommées à 1.
 */
function prepareOptions(options: z.infer<typeof DecisionAnalyzeInput>["options"]): PreparedOption[] {
  return options.map((option) => {
    const sum = option.outcomes.reduce((acc, outcome) => acc + outcome.probability, 0);
    if (sum <= 0) {
      throw new Error(
        `La somme des probabilités de l'option « ${option.label} » est nulle : impossible de normaliser la distribution.`,
      );
    }
    const warnings: string[] = [];
    if (Math.abs(sum - 1) > 0.01) {
      warnings.push(`Probabilités de « ${option.label} » normalisées (somme ${formatSum(sum)}).`);
    }
    if (option.outcomes.length === 1) {
      warnings.push(
        `« ${option.label} » est une option déterministe (issue unique) : résultat certain, aucune variance.`,
      );
    }
    return {
      label: option.label,
      outcomes: option.outcomes.map((outcome) => ({
        label: outcome.label,
        probability: outcome.probability / sum,
        value: outcome.value,
      })),
      warnings,
    };
  });
}

/** Tire UNE valeur selon les probabilités cumulées (PRNG fourni). */
function sampleOutcome(outcomes: PreparedOutcome[], random: () => number): number {
  const dice = random();
  let cumulative = 0;
  for (const outcome of outcomes) {
    cumulative += outcome.probability;
    if (dice < cumulative) return outcome.value;
  }
  return outcomes[outcomes.length - 1].value; // repli d'arrondi flottant
}

/**
 * Espérance quand la probabilité de l'issue `index` est décalée de `factor`
 * (les autres issues sont renormalisées proportionnellement pour sommer à 1).
 */
function shiftedExpectedValue(outcomes: PreparedOutcome[], index: number, factor: number): number {
  const base = outcomes[index].probability;
  const shifted = Math.min(1, base * factor);
  const restMass = 1 - shifted;
  const othersMass = 1 - base;
  let expected = 0;
  outcomes.forEach((outcome, i) => {
    if (i === index) {
      expected += shifted * outcome.value;
    } else {
      expected += (othersMass > 0 ? (outcome.probability / othersMass) * restMass : 0) * outcome.value;
    }
  });
  return expected;
}

const TOLERANCE_LABELS: Record<RiskTolerance, string> = {
  averse: "averse au risque",
  neutral: "neutre au risque",
  seeking: "en quête de risque",
};

// ────────────────────────────────────────────────────────────────────────
// Moteur
// ────────────────────────────────────────────────────────────────────────

function analyzeDecision(parsed: z.infer<typeof DecisionAnalyzeInput>): DecisionAnalyzeOutput {
  // Graine déterministe : mêmes options + mêmes simulations ⇒ mêmes tirages.
  const seed = fnv1a32(JSON.stringify({ options: parsed.options, simulations: parsed.simulations }));
  const random = mulberry32(seed);
  const simulations = parsed.simulations;
  const riskTolerance = parsed.riskTolerance;

  const prepared = prepareOptions(parsed.options);

  const perOption: DecisionOptionAnalysis[] = prepared.map((option) => {
    const expectedValue = option.outcomes.reduce((acc, o) => acc + o.probability * o.value, 0);
    const variance = option.outcomes.reduce((acc, o) => acc + o.probability * (o.value - expectedValue) ** 2, 0);
    const stdDev = Math.sqrt(Math.max(0, variance));

    // Monte-Carlo reproductible : tirages triés pour les statistiques d'ordre.
    const values: number[] = new Array(simulations);
    for (let i = 0; i < simulations; i += 1) {
      values[i] = sampleOutcome(option.outcomes, random);
    }
    const sorted = [...values].sort((a, b) => a - b);
    const lossCount = sorted.reduce((acc, value) => acc + (value < 0 ? 1 : 0), 0);
    const tailCount = Math.max(1, Math.floor(simulations * 0.05));
    let tailSum = 0;
    for (let i = 0; i < tailCount; i += 1) tailSum += sorted[i];

    const probabilityOfLoss = lossCount / simulations;
    const p5 = percentile(sorted, 0.05);
    const upsideP95 = percentile(sorted, 0.95);
    const cvar5 = tailSum / tailCount;

    // Avertissements dégénérés : volatilité élevée (coefficient de variation).
    if (stdDev > 0 && expectedValue !== 0) {
      const coefficientOfVariation = stdDev / Math.abs(expectedValue);
      if (coefficientOfVariation > 2) {
        option.warnings.push(
          `« ${option.label} » présente une volatilité élevée (coefficient de variation ${formatNumber(coefficientOfVariation)}).`,
        );
      }
    } else if (stdDev > 0 && expectedValue === 0) {
      option.warnings.push(
        `« ${option.label} » présente une volatilité élevée (espérance nulle, écart-type ${formatNumber(stdDev)}).`,
      );
    }

    const score =
      riskTolerance === "averse"
        ? cvar5
        : riskTolerance === "neutral"
          ? expectedValue - 0.25 * stdDev
          : expectedValue + 0.25 * (upsideP95 - expectedValue);

    return {
      label: option.label,
      expectedValue,
      stdDev,
      probabilityOfLoss,
      p5,
      cvar5,
      upsideP95,
      score,
      warnings: option.warnings,
    };
  });

  // Classement : score décroissant, ordre de saisie en départage (stable).
  const ordered = perOption
    .map((option, index) => ({ option, index }))
    .sort((a, b) => b.option.score - a.option.score || a.index - b.index);
  const ranking = ordered.map(({ option }) => option.label);
  const best = ordered[0].option;

  // Recommandation déterministe — cite la tolérance ET la métrique décisive.
  let reason: string;
  if (riskTolerance === "averse") {
    reason = `sa queue de perte est la plus maîtrisée (CVaR à 5 % = ${formatNumber(best.cvar5)}, perte moyenne dans les 5 % de scénarios les plus défavorables) pour une espérance de ${formatNumber(best.expectedValue)}`;
  } else if (riskTolerance === "neutral") {
    reason = `elle offre le meilleur compromis rendement/risque (espérance ${formatNumber(best.expectedValue)}, écart-type ${formatNumber(best.stdDev)})`;
  } else {
    reason = `elle maximise le potentiel de hausse (percentile à 95 % = ${formatNumber(best.upsideP95)}) tout en conservant une espérance de ${formatNumber(best.expectedValue)}`;
  }
  const recommendation = `Avec votre tolérance « ${TOLERANCE_LABELS[riskTolerance]} », « ${best.label} » domine grâce à ${reason}.`;

  // Sensibilité : décalage ±10 % de chaque probabilité d'issue.
  const influences: (DecisionSensitivityInfluence & {
    magnitude: number;
    optionIndex: number;
    outcomeIndex: number;
  })[] = [];
  prepared.forEach((option, optionIndex) => {
    const baseEv = perOption[optionIndex].expectedValue;
    option.outcomes.forEach((outcome, outcomeIndex) => {
      const deltaHigh = shiftedExpectedValue(option.outcomes, outcomeIndex, 1.1) - baseEv;
      const deltaLow = shiftedExpectedValue(option.outcomes, outcomeIndex, 0.9) - baseEv;
      const magnitude = Math.max(Math.abs(deltaHigh), Math.abs(deltaLow));
      if (magnitude > 1e-9) {
        influences.push({
          optionLabel: option.label,
          outcomeLabel: outcome.label,
          deltaHigh,
          deltaLow,
          magnitude,
          optionIndex,
          outcomeIndex,
        });
      }
    });
  });
  influences.sort(
    (a, b) =>
      b.magnitude - a.magnitude || a.optionIndex - b.optionIndex || a.outcomeIndex - b.outcomeIndex,
  );
  const topInfluences = influences.slice(0, 5).map(({ optionLabel, outcomeLabel, deltaHigh, deltaLow }) => ({
    optionLabel,
    outcomeLabel,
    deltaHigh,
    deltaLow,
  }));

  return {
    perOption,
    ranking,
    recommendation,
    sensitivity: { topInfluences },
    assumptions: { simulations, riskTolerance, seed: seed.toString(16) },
    warnings: perOption.flatMap((option) => option.warnings),
  };
}

export const decisionAnalyzeTool: ToolDefinition<z.infer<typeof DecisionAnalyzeInput>, DecisionAnalyzeOutput> = {
  id: "decision.analyze",
  name: "Probability & Odds Decision Engine",
  description:
    "Deterministic probabilistic decision engine (no LLM, reproducible numbers): expected value, variance, seeded Monte-Carlo simulation, P5/CVaR5/P95, probability of loss, ±10 % sensitivity analysis and a French recommendation ranked by your risk tolerance.",
  category: "system",
  risk: "low",
  inputSchema: DecisionAnalyzeInput,
  async execute(input) {
    const parsed = DecisionAnalyzeInput.parse(input);
    return analyzeDecision(parsed);
  },
};
