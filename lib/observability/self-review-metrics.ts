/**
 * MÉTRIQUES DE SELF-REFLECTION (durcissement production — « sans mal informer
 * un utilisateur »). Chaque passe de relecture visible (lib/ai/self-review.ts,
 * branchée sur le chat des agents Studio ET désormais sur le chat principal
 * workspace) enregistre son verdict ici : la plateforme peut donc PROUVER en
 * production que la barrière anti-désinformation tourne, mesurer son taux
 * d'intervention et alerter si elle tombe en panne silencieuse.
 *
 * Stockage sur globalThis (même convention que metrics-registry.ts) : les
 * compteurs survivent aux rechargements de module en dev et sont par-process
 * (cohérent avec le registre HTTP — VPS mono-process PM2, Vercel par-instance).
 *
 * Le module est PUR et sans dépendance : testable, format Prometheus 0.0.4
 * déterministe (ordre fixe), cardinalité bornée (4 étiquettes fixes).
 */

export type SelfReviewVerdict = "conforme" | "ameliore" | "error";

export type SelfReviewSkipReason = "disabled" | "too_short" | "too_long" | "error";

interface SelfReviewState {
  /** Verdicts effectifs de la passe de relecture. */
  conforme: number;
  ameliore: number;
  /** Passe tentée mais indisponible (réviseur illisible/panne) — proposition d'origine rendue. */
  error: number;
  /** Passe NON tentée, par raison (observabilité du périmètre réel). */
  skips: Record<SelfReviewSkipReason, number>;
  creeLe: number;
}

const CLE_GLOBALE = "__gen3ia_self_review_metrics__";

function etat(): SelfReviewState {
  const global = globalThis as unknown as Record<string, unknown>;
  const existant = global[CLE_GLOBALE] as SelfReviewState | undefined;
  if (existant) return existant;
  const frais: SelfReviewState = {
    conforme: 0,
    ameliore: 0,
    error: 0,
    skips: { disabled: 0, too_short: 0, too_long: 0, error: 0 },
    creeLe: Date.now(),
  };
  global[CLE_GLOBALE] = frais;
  return frais;
}

/** Enregistre l'issue d'une passe de self-review (verdict OU raison de saut). */
export function enregistrerSelfReview(
  issue: { verdict: SelfReviewVerdict; skipped?: SelfReviewSkipReason },
): void {
  const courant = etat();
  if (issue.skipped) {
    const raison = issue.skipped;
    if (raison in courant.skips) courant.skips[raison] += 1;
    return;
  }
  if (issue.verdict === "conforme") courant.conforme += 1;
  else if (issue.verdict === "ameliore") courant.ameliore += 1;
  else courant.error += 1;
}

/** Instantané brut (tests, diagnostics). */
export function instantaneSelfReview(): Readonly<SelfReviewState> {
  const courant = etat();
  return {
    conforme: courant.conforme,
    ameliore: courant.ameliore,
    error: courant.error,
    skips: { ...courant.skips },
    creeLe: courant.creeLe,
  };
}

/**
 * Sérialisation Prometheus (intégrée à /api/metrics via metrics-registry).
 * Déterministe : ordre fixe des séries, aucun label dynamique.
 */
export function selfReviewPrometheus(): string {
  const s = etat();
  const total =
    s.conforme + s.ameliore + s.error + Object.values(s.skips).reduce((a, b) => a + b, 0);
  const lignes: string[] = [
    "# HELP gen3ia_self_review_total Passes de self-review des réponses visibles par issue (verdict ou raison d'abstention).",
    "# TYPE gen3ia_self_review_total counter",
    `gen3ia_self_review_total{issue="conforme"} ${s.conforme}`,
    `gen3ia_self_review_total{issue="ameliore"} ${s.ameliore}`,
    `gen3ia_self_review_total{issue="error"} ${s.error}`,
    `gen3ia_self_review_total{issue="skip_disabled"} ${s.skips.disabled}`,
    `gen3ia_self_review_total{issue="skip_too_short"} ${s.skips.too_short}`,
    `gen3ia_self_review_total{issue="skip_too_long"} ${s.skips.too_long}`,
    `gen3ia_self_review_total{issue="skip_error"} ${s.skips.error}`,
    "# HELP gen3ia_self_review_improvement_ratio Part des passes abouties (verdict effectif) qui ont CORRIGÉ la proposition — indicateur d'intervention de la barrière anti-désinformation.",
    "# TYPE gen3ia_self_review_improvement_ratio gauge",
  ];
  const abouties = s.conforme + s.ameliore;
  const ratio = abouties > 0 ? Math.round((s.ameliore / abouties) * 10_000) / 10_000 : 0;
  lignes.push(`gen3ia_self_review_improvement_ratio ${ratio}`);
  lignes.push(`# gen3ia_self_review_total_all ${total}`);
  return `${lignes.join("\n")}\n`;
}
