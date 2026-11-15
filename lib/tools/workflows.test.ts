import { describe, expect, it, vi } from "vitest";

import { validateWorkflow } from "@/lib/workflows/validator";
import { construireGrapheLineaire } from "@/lib/tools/workflows";

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() })),
      where: vi.fn(() => ({ limit: vi.fn(() => ({ get: vi.fn(async () => ({ docs: [] })) })) })),
    })),
  },
}));

describe("construction de graphe workflow linéaire", () => {
  it("construit un graphe valide pour des étapes énoncées", () => {
    const workflow = construireGrapheLineaire("Veille marché", [
      { name: "Recherche", description: "recherche les tendances" },
      { name: "Rédaction", description: "rédige un résumé" },
    ]);
    expect(workflow.nodes).toHaveLength(3); // 2 étapes + output
    expect(workflow.edges).toHaveLength(2);
    expect(workflow.nodes[0]!.type).toBe("agent");
    expect(workflow.nodes[0]!.config.task).toBe("recherche les tendances");
    expect(workflow.nodes[2]!.type).toBe("output");

    const validation = validateWorkflow(workflow);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("construit un graphe à une étape valide", () => {
    const workflow = construireGrapheLineaire("Simple", [
      { name: "Étape 1", description: "fais un résumé" },
    ]);
    expect(workflow.nodes).toHaveLength(2);
    expect(validateWorkflow(workflow).valid).toBe(true);
  });

  it("chaîne les nœuds dans l'ordre énoncé", () => {
    const workflow = construireGrapheLineaire("Chaîne", [
      { name: "A", description: "a" },
      { name: "B", description: "b" },
      { name: "C", description: "c" },
    ]);
    const cibleDe = (id: string) => workflow.edges.find((e) => e.source === id)?.target;
    expect(cibleDe("step_1")).toBe("step_2");
    expect(cibleDe("step_2")).toBe("step_3");
    expect(cibleDe("step_3")).toBe("output_final");
  });
});
