import "server-only";

import { newUlid } from "@/lib/storage/user-data-store";

import { executableEngines, findEngine, validatePlanAgainstEngine } from "./engines/registry";
import { getProjectOverview } from "./repository";
import { auditSplits } from "./validation/dataset-files";
import { trainingPlanSchema, type ProjectOverview, type TrainingPlan } from "./types";

/* ------------------------------------------------------------------ */
/* Assistant IA du Training Studio (spec §6)                            */
/*                                                                    */
/* L'assistant s'appuie UNIQUEMENT sur les métadonnées réelles du       */
/* projet (statuts de validation, stats de datasets, capacités des      */
/* moteurs) — jamais de métrique inventée. Deux sources :              */
/*  - "assistant-llm" : analyse par le moteur IA de la plateforme ;    */
/*  - "heuristic-fallback" : règles déterministes quand l'IA est       */
/*    indisponible — le plan est clairement étiqueté comme tel.        */
/* ------------------------------------------------------------------ */

function nowIso(): string {
  return new Date().toISOString();
}

/** Sérialise le contexte RÉEL du projet pour l'analyse (aucune invention). */
export function buildAnalysisContext(overview: ProjectOverview): Record<string, unknown> {
  const { project, models, datasets } = overview;
  const splitFindings = auditSplits(
    datasets.map((d) => ({ id: d.id, name: d.name, split: d.split, rows: d.stats.rows })),
  );
  return {
    project: {
      name: project.name,
      description: project.description,
      family: project.family,
      objective: project.objective,
      primaryLanguage: project.primaryLanguage,
      dataTypes: project.dataTypes,
      mode: project.mode,
    },
    models: models.map((m) => ({
      name: m.name,
      source: m.source,
      catalogId: m.catalogId ?? null,
      format: m.format ?? null,
      sizeBytes: m.sizeBytes,
      status: m.status,
      findings: m.findings,
    })),
    datasets: datasets.map((d) => ({
      name: d.name,
      format: d.format,
      split: d.split,
      rows: d.stats.rows,
      pairs: d.stats.pairs,
      duplicates: d.stats.duplicates,
      warnings: d.stats.warnings,
    })),
    splits: {
      train: datasets.filter((d) => d.split === "train").reduce((t, d) => t + d.stats.rows, 0),
      validation: datasets.filter((d) => d.split === "validation").reduce((t, d) => t + d.stats.rows, 0),
      test: datasets.filter((d) => d.split === "test").reduce((t, d) => t + d.stats.rows, 0),
      findings: splitFindings.map((f) => f.message),
    },
    engines: executableEngines().map((engine) => ({
      id: engine.id,
      name: engine.name,
      methods: engine.methods,
      minVramGb: engine.minVramGb,
      parameters: engine.parameters.map((p) => ({ key: p.key, min: p.min, max: p.max, defaultValue: p.defaultValue })),
    })),
  };
}

/** Prompt système strict : l'assistant doit répondre en JSON contraint. */
const SYSTEM_PROMPT = `Tu es l'assistant d'entraînement de la plateforme Gen3ia AI Training Studio.
On te fournit le contexte RÉEL d'un projet d'entraînement (modèles importés, datasets analysés, moteurs disponibles).
Ta mission : recommander un plan d'entraînement PRÉCIS et HONNÊTE.

Règles impératives :
- Ne recommande QUE des méthodes supportées par les moteurs listés (champ methods).
- Utilise uniquement les paramètres déclarés par le moteur, dans leurs bornes.
- Les estimations de ressources (VRAM, durée) sont des ESTIMATIONS : arrondis prudemment par excès.
- Si les données sont insuffisantes pour un fine-tuning (< 50 paires), recommande la méthode "rag" (indexation RAG) et explique pourquoi.
- Si aucun dataset n'est importé, dis-le clairement et recommande d'importer des données (aucun plan de fine-tuning).
- Ne promets JAMAIS de résultat garanti ; formule des résultats attendus prudents.
- Réponds STRICTEMENT en JSON valide (sans texte autour) avec ce schéma :
{
  "method": "lora|qlora|adapter|eval-only|rag|finetune|full-training|quantize|convert",
  "engineId": "text-lora|text-eval|rag-index",
  "baseModel": "identifiant catalogue ou nom d'asset importé",
  "baseModelKind": "catalog|upload",
  "parameters": { "clé": valeur },
  "resources": { "vramGbEstimate": nombre|null, "storageGbEstimate": nombre|null, "estimatedDurationMinutes": nombre|null, "providerClass": "worker-http" },
  "risks": ["..."],
  "warnings": ["..."],
  "expectedOutcomes": "description prudente",
  "evaluationCriteria": ["..."],
  "explanation": "explication du choix, en français, 3 à 6 phrases"
}`;

/** Analyse par l'assistant IA (repli heuristique si indisponible). */
export async function generateTrainingPlan(uid: string, projectId: string): Promise<
  { ok: true; plan: TrainingPlan; generatedBy: "assistant-llm" | "heuristic-fallback"; explanation: string } | { ok: false; error: string }
> {
  const overview = await getProjectOverview(uid, projectId);
  if (!overview) return { ok: false, error: "Projet introuvable." };
  const context = buildAnalysisContext(overview);

  const { generate } = await import("@/lib/ai/router");

  let planDraft: Record<string, unknown> | null = null;
  let explanation = "";
  let generatedBy: "assistant-llm" | "heuristic-fallback" = "heuristic-fallback";

  try {
    const response = await generate({
      task: "reasoning",
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Analyse ce projet d'entraînement et propose un plan (JSON strict) :\n${JSON.stringify(context, null, 2)}`,
        },
      ],
      temperature: 0.2,
      maxTokens: 1600,
      requiresStructuredOutput: true,
    });
    const text = response.text.trim();
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
      planDraft = parsed;
      explanation = typeof parsed.explanation === "string" ? parsed.explanation : "";
      generatedBy = "assistant-llm";
    }
  } catch {
    // IA indisponible : repli heuristique ci-dessous — honnête et étiqueté.
    planDraft = null;
  }

  if (!planDraft) {
    const heuristic = heuristicPlan(context);
    planDraft = heuristic.plan;
    explanation = heuristic.explanation;
    generatedBy = "heuristic-fallback";
  }

  // Base model : repli sur le premier asset/catalogue réel disponible.
  const validated = normalizePlan(planDraft, overview);
  if (!validated) {
    const heuristic = heuristicPlan(context);
    const normalized = normalizePlan(heuristic.plan, overview);
    if (!normalized) return { ok: false, error: "Impossible de produire un plan cohérent avec les données du projet." };
    return { ok: true, plan: finalizePlan(normalized, overview, "heuristic-fallback"), generatedBy: "heuristic-fallback", explanation: heuristic.explanation };
  }

  return { ok: true, plan: finalizePlan(validated, overview, generatedBy), generatedBy, explanation };
}

function normalizePlan(
  draft: Record<string, unknown>,
  overview: ProjectOverview,
): Partial<TrainingPlan> | null {
  const engineId = typeof draft.engineId === "string" ? draft.engineId : "text-lora";
  const method = typeof draft.method === "string" ? draft.method : "lora";
  const engine = findEngine(engineId);
  if (!engine) return null;

  // Base model : asset importé valide → assetId ; sinon catalogue par défaut.
  const uploaded = overview.models.find((m) => m.source === "upload" && m.status === "valid");
  const catalogAsset = overview.models.find((m) => m.source === "catalog");
  const defaultCatalog = overview.project.family === "text" ? "Qwen/Qwen2.5-1.5B-Instruct" : null;

  let baseModel = typeof draft.baseModel === "string" ? draft.baseModel : "";
  let baseModelKind: "upload" | "catalog" = draft.baseModelKind === "upload" ? "upload" : "catalog";
  if (uploaded && baseModelKind === "upload") {
    baseModel = uploaded.id;
  } else if (catalogAsset) {
    baseModel = catalogAsset.catalogId ?? catalogAsset.id;
    baseModelKind = "catalog";
  } else if (uploaded) {
    baseModel = uploaded.id;
    baseModelKind = "upload";
  } else if (defaultCatalog && baseModelKind === "catalog") {
    baseModel = defaultCatalog;
  } else if (defaultCatalog) {
    baseModel = defaultCatalog;
    baseModelKind = "catalog";
  } else {
    baseModel = baseModel || "Qwen/Qwen2.5-1.5B-Instruct";
    baseModelKind = "catalog";
  }

  const parameters: Record<string, string | number | boolean | null> = {};
  for (const spec of engine.parameters) {
    const value = (draft.parameters as Record<string, unknown> | undefined)?.[spec.key];
    if (spec.type === "number") {
      const num = typeof value === "number" ? value : Number(value);
      const bounded = Number.isFinite(num)
        ? Math.min(spec.max ?? num, Math.max(spec.min ?? num, num))
        : (spec.defaultValue as number | undefined) ?? null;
      if (bounded !== null) parameters[spec.key] = bounded;
    } else if (typeof value === "string" || typeof value === "boolean" || value === null) {
      parameters[spec.key] = value;
    } else if (spec.defaultValue !== undefined) {
      parameters[spec.key] = spec.defaultValue;
    }
  }

  const resourcesRaw = (draft.resources as Record<string, unknown> | undefined) ?? {};
  const toPositive = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

  return {
    method: method as TrainingPlan["method"],
    engineId,
    baseModel,
    baseModelKind,
    parameters,
    resources: {
      vramGbEstimate: toPositive(resourcesRaw.vramGbEstimate) ?? (engine.minVramGb || null),
      storageGbEstimate: toPositive(resourcesRaw.storageGbEstimate),
      estimatedDurationMinutes: toPositive(resourcesRaw.estimatedDurationMinutes),
      providerClass: "worker-http",
    },
    risks: Array.isArray(draft.risks) ? draft.risks.filter((r): r is string => typeof r === "string").slice(0, 10) : [],
    warnings: Array.isArray(draft.warnings) ? draft.warnings.filter((w): w is string => typeof w === "string").slice(0, 10) : [],
    expectedOutcomes: typeof draft.expectedOutcomes === "string" ? draft.expectedOutcomes.slice(0, 1500) : "",
    evaluationCriteria: Array.isArray(draft.evaluationCriteria)
      ? draft.evaluationCriteria.filter((c): c is string => typeof c === "string").slice(0, 10)
      : ["Perte de validation stable sur les dernières époques", "Aucune régression sur des exemples hors dataset"],
  };
}

function finalizePlan(
  partial: Partial<TrainingPlan>,
  overview: ProjectOverview,
  generatedBy: "assistant-llm" | "heuristic-fallback",
): TrainingPlan {
  const stamp = nowIso();
  return trainingPlanSchema.parse({
    id: newUlid(),
    projectId: overview.project.id,
    ownerId: overview.project.ownerId,
    method: partial.method ?? "lora",
    engineId: partial.engineId ?? "text-lora",
    baseModel: partial.baseModel ?? "",
    baseModelKind: partial.baseModelKind ?? "catalog",
    parameters: partial.parameters ?? {},
    resources: partial.resources ?? {},
    risks: partial.risks ?? [],
    warnings: partial.warnings ?? [],
    expectedOutcomes: partial.expectedOutcomes ?? "",
    evaluationCriteria: partial.evaluationCriteria ?? [],
    generatedBy,
    status: "proposed",
    createdAt: stamp,
  });
}

/* ------------------------- Repli heuristique ----------------------- */

/**
 * Plan déterministe fondé sur des règles simples, appliquées au contexte
 * RÉEL. Étiqueté "heuristic-fallback" : l'utilisateur sait que l'analyse
 * IA n'a pas pu être produite.
 */
export function heuristicPlan(context: Record<string, unknown>): {
  plan: Record<string, unknown>;
  explanation: string;
} {
  const datasets = (context.datasets as Array<{ rows: number; pairs: number; split: string }>) ?? [];
  const models = (context.models as Array<{ source: string; status: string }>) ?? [];
  const splits = (context.splits as { train: number; validation: number }) ?? { train: 0, validation: 0 };
  const totalPairs = datasets.reduce((t, d) => t + (d.pairs || 0), 0);

  if (datasets.length === 0) {
    return {
      plan: {
        method: "rag",
        engineId: "rag-index",
        baseModel: "Qwen/Qwen2.5-1.5B-Instruct",
        baseModelKind: "catalog",
        parameters: { chunkSize: 800, chunkOverlap: 80 },
        resources: { vramGbEstimate: null, storageGbEstimate: 1, estimatedDurationMinutes: 5, providerClass: "worker-http" },
        risks: ["Aucun dataset importé : aucun fine-tuning n'est possible pour l'instant."],
        warnings: ["Importez au moins 50 paires instruction/réponse pour envisager un fine-tuning LoRA."],
        expectedOutcomes: "Indexation RAG de vos futurs documents — le modèle de langage reste inchangé.",
        evaluationCriteria: ["Questions de test auxquelles le RAG répond correctement"],
      },
      explanation:
        "Aucun dataset n'a encore été importé : l'assistant ne peut pas recommander de fine-tuning. Un plan RAG vous permet de démarrer dès que des documents seront disponibles. (Analyse heuristique — assistant IA momentanément indisponible.)",
    };
  }

  const uploadedValid = models.some((m) => m.source === "upload" && m.status === "valid");
  const smallData = totalPairs < 50 || splits.train < 50;

  if (smallData) {
    return {
      plan: {
        method: "rag",
        engineId: "rag-index",
        baseModel: "Qwen/Qwen2.5-1.5B-Instruct",
        baseModelKind: "catalog",
        parameters: { chunkSize: 800, chunkOverlap: 80 },
        resources: { vramGbEstimate: null, storageGbEstimate: 1, estimatedDurationMinutes: 5, providerClass: "worker-http" },
        risks: [
          "Volume de données trop faible pour un fine-tuning crédible (risque fort de surapprentissage).",
          ...(splits.validation === 0 ? ["Aucun split de validation : les métriques ne seront pas mesurables."] : []),
        ],
        warnings: [`${totalPairs} paires détectées : en dessous du seuil recommandé (50+) pour un LoRA.`],
        expectedOutcomes: "RAG fonctionnel sur vos données : réponses ancrées dans vos documents sans toucher aux poids.",
        evaluationCriteria: ["Réponses correctes sur 10 questions de contrôle", "Aucune hallucination sur des questions hors périmètre"],
      },
      explanation:
        "Le volume de données est trop faible pour un fine-tuning fiable : la solution adaptée est un RAG (indexation de vos documents, sans modification des poids du modèle). Enrichissez le dataset (plusieurs centaines de paires) pour débloquer un LoRA. (Analyse heuristique — assistant IA momentanément indisponible.)",
    };
  }

  const baseModelKind = uploadedValid ? "upload" : "catalog";
  return {
    plan: {
      method: "lora",
      engineId: "text-lora",
      baseModel: "Qwen/Qwen2.5-1.5B-Instruct",
      baseModelKind,
      parameters: {
        learningRate: 0.0002,
        epochs: 3,
        batchSize: 4,
        loraRank: 16,
        loraAlpha: 32,
        loraDropout: 0.05,
        maxSequenceLength: 1024,
        gradientAccumulation: 2,
      },
      resources: { vramGbEstimate: 10, storageGbEstimate: 4, estimatedDurationMinutes: 45, providerClass: "worker-http" },
      risks: [
        "Surapprentissage si le nombre d'époques est trop élevé : surveillez la perte de validation.",
        ...(splits.validation === 0 ? ["Aucun split de validation fourni : ajoutez-en un pour mesurer le surapprentissage."] : []),
      ],
      warnings: [],
      expectedOutcomes: "Adaptateurs LoRA spécialisant le modèle de base sur vos données, exportables et réutilisables.",
      evaluationCriteria: [
        "Perte de validation inférieure à la perte initiale",
        "Réponses cohérentes sur 10 exemples hors entraînement",
        "Absence de dégradation sur des cas généraux",
      ],
    },
    explanation:
      "Volume de données suffisant pour un fine-tuning LoRA : paramètres standards prudent (3 époques, rang 16). L'exécution nécessitera un worker GPU connecté. (Analyse heuristique — assistant IA momentanément indisponible.)",
  };
}

/** Vérifie la cohérence d'un plan avec son moteur (utilisé avant acceptation). */
export function planCoherenceErrors(plan: TrainingPlan): string[] {
  return validatePlanAgainstEngine({
    method: plan.method,
    engineId: plan.engineId,
    parameters: plan.parameters,
  });
}
