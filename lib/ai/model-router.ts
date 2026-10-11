import "server-only";

/**
 * ROUTEUR DE MODÈLES INTELLIGENT (intentions du commit b074300, intégrées
 * au standard du projet).
 *
 * Correctif d'intégration (Task 127) : le module d'origine référençait des
 * types hallucinés (ModelConfig/CacheManager non définis, this.getCheapModel/
 * callModel inexistants) et ne compilait pas. Ici : sélecteur TYPÉ et
 * autonome — le routage OFFICIEL des requêtes reste lib/ai/router.ts (score
 * de capacités + résilience multi-fournisseurs) ; ce module aide à CHOISIR
 * une intention de modèle selon tâche/urgence/budget AVANT l'appel router.
 */

export type TaskType = "simple" | "complex" | "reasoning" | "creative";
export type Urgency = "low" | "medium" | "high";

export interface ModelConfig {
  provider: string;
  model: string;
  maxTokens: number;
  temperature: number;
}

/** Modèles par défaut (surchargeables par env : GLM_MODEL, GROQ_MODEL…). */
function envModel(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

const CHEAP: ModelConfig = {
  provider: "groq",
  model: envModel("GROQ_MODEL", "llama-3.1-8b-instruct"),
  maxTokens: 1000,
  temperature: 0.2,
};

const STRONG: ModelConfig = {
  provider: "glm",
  model: envModel("GLM_MODEL", "glm-4.6"),
  maxTokens: 4000,
  temperature: 0.3,
};

const CREATIVE: ModelConfig = {
  provider: "glm",
  model: envModel("GLM_MODEL", "glm-4.6"),
  maxTokens: 3000,
  temperature: 0.8,
};

export class IntelligentModelRouter {
  /** Choisit le modèle optimal selon la tâche, l'urgence et le budget. */
  static selectModel(context: {
    taskType: TaskType;
    urgency: Urgency;
    /** Budget restant (crédits/tokens) — sous 1000, modèles économiques. */
    budgetRemaining: number;
    preferredProvider?: string;
  }): ModelConfig {
    const { taskType, urgency, budgetRemaining, preferredProvider } = context;

    // Routage par budget : préserver les crédits avec des modèles économiques.
    if (budgetRemaining < 1000) return CHEAP;

    let chosen: ModelConfig;
    switch (taskType) {
      case "complex":
      case "reasoning":
        chosen = STRONG;
        break;
      case "creative":
        chosen = CREATIVE;
        break;
      case "simple":
      default:
        chosen = urgency === "high" ? CHEAP : STRONG;
        break;
    }

    // Préférence fournisseur explicite : gardée si le modèle s'y prête.
    if (preferredProvider && chosen.provider !== preferredProvider) {
      return { ...chosen, provider: preferredProvider };
    }
    return chosen;
  }

  /**
   * Cache de sélection (clé contextuelle → config) : même demande dans la
   * même instance → même réponse sans re-scoring (mémoire bornée).
   */
  private static readonly cache = new Map<string, ModelConfig>();

  static selectModelCached(context: Parameters<typeof IntelligentModelRouter.selectModel>[0]): ModelConfig {
    const key = `${context.taskType}:${context.urgency}:${context.budgetRemaining}:${context.preferredProvider ?? ""}`;
    const hit = IntelligentModelRouter.cache.get(key);
    if (hit) return hit;
    const chosen = IntelligentModelRouter.selectModel(context);
    if (IntelligentModelRouter.cache.size > 500) IntelligentModelRouter.cache.clear();
    IntelligentModelRouter.cache.set(key, chosen);
    return chosen;
  }
}
