import { describe, expect, it } from "vitest";

import type { RuntimePlan } from "@/lib/agents/runtime/types";
import { deliverablesSection, extractDeliverables } from "./deliverables";

function planWith(steps: Array<Record<string, unknown>>): RuntimePlan {
  return {
    executionId: "exec-1",
    objective: "objectif",
    steps: steps.map((step) => ({
      id: "s1",
      type: "tool",
      name: "Étape",
      description: "Étape",
      dependencies: [],
      status: "pending",
      input: {},
      skillIds: [],
      maxRetries: 2,
      timeoutMs: 120_000,
      sideEffect: false,
      requiresApproval: false,
      ...step,
    })) as RuntimePlan["steps"],
    maxConcurrency: 1,
    maxIterations: 5,
  };
}

/**
 * MANIFEST DE LIVRABLES (exigence production « système mission avancé ») :
 * les livrables sont extraits des sorties RÉELLES — jamais inventés.
 */
describe("extractDeliverables", () => {
  it("extrait un artefact persisté (artifact.create complété)", () => {
    const plan = planWith([
      { id: "a1", toolName: "artifact.create", status: "completed" },
      { id: "a2", toolName: "artifact.create", status: "pending" },
    ]);
    const outputs = {
      a1: { success: true, artifactId: "art-1", filename: "rapport.pdf", format: "pdf", sizeBytes: 2048, storageKey: "users/u/artifacts/rapport.pdf" },
      a2: { artifactId: "art-2" },
    };
    const deliverables = extractDeliverables(plan, outputs);
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0]).toMatchObject({
      kind: "artifact",
      artifactId: "art-1",
      filename: "rapport.pdf",
      format: "pdf",
    });
  });

  it("ignore les étapes en échec (jamais de faux livrable)", () => {
    const plan = planWith([{ id: "a1", toolName: "artifact.create", status: "failed" }]);
    const deliverables = extractDeliverables(plan, { a1: { artifactId: "art-1", filename: "x.pdf" } });
    expect(deliverables).toHaveLength(0);
  });

  it("extrait un zip et un fichier de workspace", () => {
    const plan = planWith([
      { id: "z1", toolName: "zip.create", status: "completed" },
      { id: "f1", toolName: "file.create", status: "completed" },
    ]);
    const outputs = {
      z1: { success: true, filename: "archive.zip", sizeBytes: 1024, storageKey: "artifacts/archive.zip" },
      f1: { success: true, filename: "notes.md", sizeBytes: 200 },
    };
    const deliverables = extractDeliverables(plan, outputs);
    expect(deliverables.map((item) => item.kind).sort()).toEqual(["file", "zip"]);
  });

  it("retourne une liste vide sans sortie réelle", () => {
    expect(extractDeliverables(planWith([{ id: "a1", toolName: "artifact.create", status: "completed" }]), {})).toHaveLength(0);
  });

  it("la section livrables est vide sans livrable et liste les fichiers sinon", () => {
    expect(deliverablesSection([])).toBe("");
    const section = deliverablesSection([{ stepId: "a1", name: "Rapport", kind: "artifact", filename: "rapport.pdf", format: "pdf", sizeBytes: 2048 }]);
    expect(section).toContain("Rapport");
    expect(section).toContain("rapport.pdf");
    expect(section).toContain("PDF");
  });
});
