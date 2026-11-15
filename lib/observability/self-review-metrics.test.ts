import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Métriques self-review (durcissement production) — compteurs process-local
 * sur globalThis : verdicts effectifs, abstentions motivées, ratio
 * d'intervention, sérialisation Prometheus déterministe.
 */

describe("self-review-metrics", () => {
  let mod: typeof import("./self-review-metrics");

  beforeEach(async () => {
    vi.resetModules();
    // Le stockage vit sur globalThis : purgé entre les tests pour isoler.
    (globalThis as unknown as Record<string, unknown>).__gen3ia_self_review_metrics__ = undefined;
    mod = await import("./self-review-metrics");
  });

  it("compte les verdicts effectifs (conforme / ameliore / error)", () => {
    mod.enregistrerSelfReview({ verdict: "conforme" });
    mod.enregistrerSelfReview({ verdict: "conforme" });
    mod.enregistrerSelfReview({ verdict: "ameliore" });
    mod.enregistrerSelfReview({ verdict: "error" });

    const s = mod.instantaneSelfReview();
    expect(s.conforme).toBe(2);
    expect(s.ameliore).toBe(1);
    expect(s.error).toBe(1);
  });

  it("compte les abstentions par raison (skips) sans toucher aux verdicts", () => {
    mod.enregistrerSelfReview({ verdict: "conforme", skipped: "too_short" });
    mod.enregistrerSelfReview({ verdict: "conforme", skipped: "disabled" });
    mod.enregistrerSelfReview({ verdict: "conforme", skipped: "too_short" });

    const s = mod.instantaneSelfReview();
    expect(s.skips.too_short).toBe(2);
    expect(s.skips.disabled).toBe(1);
    expect(s.conforme).toBe(0);
    expect(s.ameliore).toBe(0);
  });

  it("produit une sortie Prometheus complète et déterministe", () => {
    mod.enregistrerSelfReview({ verdict: "conforme" });
    mod.enregistrerSelfReview({ verdict: "ameliore" });
    mod.enregistrerSelfReview({ verdict: "conforme", skipped: "too_short" });

    const a = mod.selfReviewPrometheus();
    const b = mod.selfReviewPrometheus();
    expect(a).toBe(b);
    expect(a).toContain('gen3ia_self_review_total{issue="conforme"} 1');
    expect(a).toContain('gen3ia_self_review_total{issue="ameliore"} 1');
    expect(a).toContain('gen3ia_self_review_total{issue="skip_too_short"} 1');
    // Ratio d'intervention : 1 amélioration / 2 passes effectives = 0.5
    expect(a).toContain("gen3ia_self_review_improvement_ratio 0.5");
    expect(a.endsWith("\n")).toBe(true);
  });

  it("ratio à 0 quand aucune passe effective (jamais de NaN exposé)", () => {
    mod.enregistrerSelfReview({ verdict: "conforme", skipped: "disabled" });
    expect(mod.selfReviewPrometheus()).toContain("gen3ia_self_review_improvement_ratio 0");
  });

  it("survit à un rechargement de module (stockage globalThis)", async () => {
    mod.enregistrerSelfReview({ verdict: "ameliore" });
    vi.resetModules();
    const rechargé = await import("./self-review-metrics");
    expect(rechargé.instantaneSelfReview().ameliore).toBe(1);
  });
});
