import { describe, expect, it } from "vitest";

import { buildFinalResponse } from "./final-response";
import { planFailureAppendix } from "@/lib/domain/conversations/engine";

/**
 * Étape 3 du plan 20 — suppression des FAUSSES confirmations « livré » :
 * le texte final est construit depuis les statuts RÉELS du plan, et une
 * annexe déterministe nomme les échecs même si la synthèse LLM les omet.
 */

const BASE_STEP = {
  dependencies: [], input: {}, skillIds: [] as string[], maxRetries: 2,
  timeoutMs: 120_000, sideEffect: false, requiresApproval: false,
};

function plan(steps: Array<Partial<typeof BASE_STEP> & { id: string; type: "llm" | "tool"; status: string; name: string; description?: string }>) {
  return {
    executionId: "exec-1",
    objective: "objectif",
    steps: steps.map((s) => ({ ...BASE_STEP, ...s, status: s.status, type: s.type, name: s.name })) as never,
    maxConcurrency: 1,
    maxIterations: 3,
  } as Parameters<typeof buildFinalResponse>[0];
}

describe("buildFinalResponse — jamais de faux « livré »", () => {
  it("mission entièrement réussie : le livrable réel est renvoyé tel quel", () => {
    const result = buildFinalResponse(
      plan([{ id: "s1", type: "llm", status: "completed", name: "Rédiger" }]),
      { s1: "Voici le rapport demandé, complet." },
    );
    expect(result.ok).toBe(true);
    expect(result.failedSteps).toHaveLength(0);
    expect(result.text).toBe("Voici le rapport demandé, complet.");
  });

  it("échec partiel : le texte N'AFFIRME PAS la livraison et nomme les étapes en échec", () => {
    const result = buildFinalResponse(
      plan([
        { id: "s1", type: "llm", status: "completed", name: "Recherche" },
        { id: "s2", type: "llm", status: "failed", name: "Envoi email", description: "Envoyer le rapport par email" },
      ]),
      { s1: "Le rapport est rédigé." },
    );
    expect(result.ok).toBe(false);
    expect(result.failedSteps).toEqual(["Envoyer le rapport par email"]);
    expect(result.text).toContain("Mission incomplète");
    expect(result.text).toContain("n'a pas été livrée");
    expect(result.text).toContain("Envoyer le rapport par email");
    expect(result.text).toContain("Le rapport est rédigé.");
    // Jamais de formulation de livraison complète.
    expect(result.text).not.toMatch(/livr[ée]e?s?\s*!|termin[ée]e avec succ[è]s/i);
  });

  it("échec sans livrable : la phrase « aucun livrable produit » est explicite", () => {
    const result = buildFinalResponse(
      plan([{ id: "s1", type: "tool", status: "failed", name: "Recherche" }]),
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Aucun livrable n'a été produit");
    expect(result.text).toContain("Continuer la mission");
  });

  it("mission réussie sans livrable : repli honnête (pas de promesse)", () => {
    const result = buildFinalResponse(
      plan([{ id: "s1", type: "tool", status: "completed", name: "Analyse" }]),
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Le plan de l'agent a été exécuté");
  });
});

describe("planFailureAppendix — annexe déterministe du moteur conversationnel", () => {
  it("aucune annexe quand tout est réussi", () => {
    const steps = [
      { status: "done", title: "Recherche", output: "ok" },
      { status: "done", title: "Rédaction" },
    ] as never as Parameters<typeof planFailureAppendix>[0];
    expect(planFailureAppendix(steps)).toBeUndefined();
  });

  it("liste exacte des échecs avec le marqueur « ne sont PAS livrés »", () => {
    const steps = [
      { status: "done", title: "Recherche", output: "données trouvées" },
      { status: "failed", title: "Envoi email", output: "SMTP indisponible" },
      { status: "failed", title: "Publication" },
    ] as never as Parameters<typeof planFailureAppendix>[0];
    const appendix = planFailureAppendix(steps);
    expect(appendix).toContain("ne sont PAS livrés");
    expect(appendix).toContain("- Envoi email — SMTP indisponible");
    expect(appendix).toContain("- Publication");
    expect(appendix).toContain("reprendre la mission");
  });
});
