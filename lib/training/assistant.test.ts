import { beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ */
/* Assistant du Training Studio — contexte réel, repli heuristique.   */
/* ------------------------------------------------------------------ */

vi.mock("@/lib/storage/user-data-store", () => ({
  newUlid: () => `ulid-${Math.random().toString(36).slice(2, 10)}`,
}));

vi.mock("@/lib/training/repository", () => ({
  getProjectOverview: vi.fn(),
}));

vi.mock("@/lib/ai/router", () => ({
  generate: vi.fn(),
}));

import { getProjectOverview } from "@/lib/training/repository";
import { generate } from "@/lib/ai/router";
import { buildAnalysisContext, generateTrainingPlan, heuristicPlan } from "./assistant";
import type { ProjectOverview } from "./types";

const mockedOverview = vi.mocked(getProjectOverview);
const mockedGenerate = vi.mocked(generate);

function makeOverview(overrides: {
  datasets?: Array<{ rows: number; pairs: number; split: string }>;
  models?: Array<{ source: string; status: string; catalogId?: string }>;
}): ProjectOverview {
  return {
    project: {
      v: 1,
      id: "proj-1",
      ownerId: "user-1",
      name: "Assistant support",
      description: "",
      family: "text",
      objective: "Support client spécialisé",
      primaryLanguage: "fr",
      dataTypes: [],
      mode: "assisted",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    models: (overrides.models ?? []).map((model, index) => ({
      v: 1,
      id: `model-${index}`,
      projectId: "proj-1",
      ownerId: "user-1",
      name: `Model ${index}`,
      source: model.source as "upload" | "catalog",
      catalogId: model.catalogId ?? null,
      format: "safetensors",
      storageKey: null,
      sizeBytes: 1024,
      sha256: "a".repeat(64),
      status: model.status as "valid",
      findings: [],
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    datasets: (overrides.datasets ?? []).map((dataset, index) => ({
      v: 1,
      id: `ds-${index}`,
      projectId: "proj-1",
      ownerId: "user-1",
      name: `dataset-${index}.jsonl`,
      format: "jsonl",
      storageKey: `users/user-1/training-files/proj-1/ds-${index}`,
      sizeBytes: 2048,
      sha256: "b".repeat(64),
      split: dataset.split,
      status: "valid",
      stats: {
        rows: dataset.rows,
        columns: ["instruction", "response"],
        pairs: dataset.pairs,
        duplicates: 0,
        emptyLines: 0,
        warnings: [],
      },
      findings: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    plans: [],
    jobs: [],
    exports: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedOverview.mockResolvedValue(null);
  mockedGenerate.mockReset();
});

describe("buildAnalysisContext — métadonnées réelles uniquement", () => {
  it("sérialise stats, splits et capacités moteurs sans rien inventer", () => {
    const overview = makeOverview({
      datasets: [
        { rows: 800, pairs: 800, split: "train" },
        { rows: 200, pairs: 200, split: "validation" },
      ],
    });
    const context = buildAnalysisContext(overview) as unknown as {
      project: unknown;
      datasets: unknown[];
      splits: { train: number; validation: number };
      engines: unknown[];
    };
    expect(context.project).toBeTruthy();
    expect(context.datasets).toHaveLength(2);
    expect(context.splits.train).toBe(800);
    expect(context.splits.validation).toBe(200);
    expect(Array.isArray(context.engines)).toBe(true);
    // Aucun champ "métrique" inventé : pas de loss, pas de coûts.
    expect(JSON.stringify(context)).not.toContain("loss");
  });
});

describe("heuristicPlan — règles déterministes", () => {
  it("recommande un RAG quand aucun dataset n'est importé", () => {
    const { plan } = heuristicPlan({ datasets: [], models: [] });
    expect(plan.method).toBe("rag");
    expect(plan.engineId).toBe("rag-index");
    expect(plan.risks.join(" ")).toContain("Aucun dataset");
  });

  it("recommande un RAG quand les données sont trop faibles", () => {
    const { plan } = heuristicPlan({
      datasets: [{ rows: 20, pairs: 20, split: "train" }],
      models: [],
      splits: { train: 20, validation: 0 },
    });
    expect(plan.method).toBe("rag");
    expect(plan.warnings.join(" ")).toContain("50");
  });

  it("recommande un LoRA prudent au-delà du seuil de paires", () => {
    const { plan } = heuristicPlan({
      datasets: [{ rows: 600, pairs: 600, split: "train" }],
      models: [],
      splits: { train: 600, validation: 100 },
    });
    expect(plan.method).toBe("lora");
    expect(plan.engineId).toBe("text-lora");
    expect(plan.parameters.epochs).toBe(3);
  });
});

describe("generateTrainingPlan — sources et étiquetage", () => {
  it("produit un plan assistant-llm quand l'IA répond un JSON valide", async () => {
    const overview = makeOverview({
      datasets: [
        { rows: 800, pairs: 800, split: "train" },
        { rows: 200, pairs: 200, split: "validation" },
      ],
    });
    mockedOverview.mockResolvedValue(overview);
    mockedGenerate.mockResolvedValue({
      id: "resp-1",
      provider: "groq",
      model: "llama-3.3-70b",
      text: JSON.stringify({
        method: "lora",
        engineId: "text-lora",
        baseModel: "Qwen/Qwen2.5-1.5B-Instruct",
        baseModelKind: "catalog",
        parameters: { epochs: 3, learningRate: 0.0002, loraRank: 16, loraAlpha: 32, loraDropout: 0.05, batchSize: 4, maxSequenceLength: 1024, gradientAccumulation: 2 },
        resources: { vramGbEstimate: 12, storageGbEstimate: 4, estimatedDurationMinutes: 60, providerClass: "worker-http" },
        risks: ["Surapprentissage"],
        warnings: [],
        expectedOutcomes: "Adaptateurs spécialisés",
        evaluationCriteria: ["Perte de validation en baisse"],
        explanation: "Volume suffisant pour un LoRA.",
      }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 500,
    });

    const result = await generateTrainingPlan("user-1", "proj-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.generatedBy).toBe("assistant-llm");
      expect(result.plan.method).toBe("lora");
      expect(result.plan.engineId).toBe("text-lora");
      expect(result.plan.status).toBe("proposed");
      expect(result.explanation).toContain("LoRA");
    }
  });

  it("tombe sur le repli heuristique étiqueté quand l'IA échoue", async () => {
    mockedOverview.mockResolvedValue(makeOverview({ datasets: [{ rows: 10, pairs: 10, split: "train" }] }));
    mockedGenerate.mockRejectedValue(new Error("Aucun fournisseur IA configuré"));

    const result = await generateTrainingPlan("user-1", "proj-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.generatedBy).toBe("heuristic-fallback");
      expect(result.plan.generatedBy).toBe("heuristic-fallback");
      expect(result.explanation).toContain("heuristique");
      expect(result.plan.method).toBe("rag");
    }
  });

  it("tombe sur le repli heuristique quand l'IA répond hors format", async () => {
    mockedOverview.mockResolvedValue(makeOverview({ datasets: [{ rows: 600, pairs: 600, split: "train" }] }));
    mockedGenerate.mockResolvedValue({
      id: "resp-2",
      provider: "groq",
      model: "llama-3.3-70b",
      text: "Je ne peux pas répondre en JSON, voici du prose libre.",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 100,
    });

    const result = await generateTrainingPlan("user-1", "proj-1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.generatedBy).toBe("heuristic-fallback");
  });

  it("refuse quand le projet n'existe pas", async () => {
    const result = await generateTrainingPlan("user-1", "inconnu");
    expect(result.ok).toBe(false);
  });

  it("borne les paramètres hors des capacités du moteur", async () => {
    mockedOverview.mockResolvedValue(makeOverview({ datasets: [{ rows: 600, pairs: 600, split: "train" }] }));
    mockedGenerate.mockResolvedValue({
      id: "resp-3",
      provider: "groq",
      model: "llama-3.3-70b",
      text: JSON.stringify({
        method: "lora",
        engineId: "text-lora",
        parameters: { epochs: 999, learningRate: 5 },
        resources: {},
        risks: [],
        warnings: [],
        expectedOutcomes: "",
        evaluationCriteria: [],
        explanation: "",
      }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 50,
    });
    const result = await generateTrainingPlan("user-1", "proj-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.parameters.epochs).toBeLessThanOrEqual(20);
      expect(result.plan.parameters.learningRate).toBeLessThanOrEqual(0.01);
    }
  });
});
