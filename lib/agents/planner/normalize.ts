/**
 * Normalisation défensive des sorties LLM du planner.
 *
 * Les providers renvoient parfois le JSON entouré de fences markdown ou
 * précédé d'un texte de raisonnement, avec des champs approximatifs. Plutôt
 * que d'échouer (et de faire échouer la création de tâche APRÈS avoir payé
 * l'appel LLM), on extrait et on répare : c'est le même principe défensif
 * que lib/agents/runtime/unified-agent.ts, décliné pour DynamicPlanSchema.
 */

/** Extrait l'objet JSON le plus externe d'une réponse de modèle. */
export function extractJsonObject(raw: string): unknown {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1]?.trim(), text].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(candidate.slice(start, end + 1));
        } catch {
          // Candidat suivant.
        }
      }
    }
  }
  throw new Error("Planner returned invalid JSON.");
}

/** Alias de types flous -> énum stricte du schéma. */
const STEP_TYPE_ALIASES: Record<string, string> = {
  search: "research", web: "research", websearch: "research", research: "research",
  tool: "tool", tools: "tool",
  llm: "llm", text: "llm", reasoning: "llm", chat: "llm", answer: "llm", write: "llm", summary: "llm", generation: "llm",
  document: "document", doc: "document", docs: "document",
  media: "media", image: "media", video: "media", audio: "media",
  code: "code", compute: "code", script: "code",
  condition: "condition", branch: "condition",
  agent: "agent", subagent: "agent", delegation: "agent", delegate: "agent",
};

/**
 * Répare toute sortie de planner plausible en étapes valides pour le schéma :
 * IDs uniques, types mappés, noms/descriptions présents, dépendances
 * existantes uniquement, input en objet.
 */
export function normalizePlanSteps(rawSteps: unknown): unknown[] {
  if (!Array.isArray(rawSteps)) return [];
  const knownIds = new Set<string>();
  const mapped = rawSteps.map((step, index) => {
    const base: Record<string, unknown> = (typeof step === "object" && step !== null)
      ? { ...(step as Record<string, unknown>) }
      : { description: String(step ?? "") };
    if (typeof base.id !== "string" || !base.id.trim()) base.id = `step-${index + 1}`;
    knownIds.add(String(base.id));
    return base;
  });

  for (const record of mapped) {
    const typeRaw = typeof record.type === "string" ? record.type.toLowerCase().replace(/[^a-z]/g, "") : "";
    record.type = STEP_TYPE_ALIASES[typeRaw] ?? "llm";
    if (record.type === "tool" && (typeof record.toolName !== "string" || !record.toolName.trim())) {
      // Étape outil sans cible : inutilisable, dégradation en raisonnement.
      record.type = "llm";
    }
    if (record.type === "agent" && (typeof record.agentId !== "string" || !record.agentId.trim())) {
      // Étape de délégation sans cible : dégradation en raisonnement.
      record.type = "llm";
    }
    const nameSource = [record.name, record.title, record.toolName, record.description].find(
      (value) => typeof value === "string" && value.trim(),
    );
    record.name = typeof nameSource === "string" ? nameSource.trim().slice(0, 120) : "Étape";
    const descriptionSource = [record.description, record.name, record.objective].find(
      (value) => typeof value === "string" && value.trim(),
    );
    record.description = typeof descriptionSource === "string" ? descriptionSource.trim().slice(0, 600) : record.name;
    if (typeof record.input !== "object" || record.input === null || Array.isArray(record.input)) record.input = {};
    record.dependencies = Array.isArray(record.dependencies)
      ? (record.dependencies as unknown[]).map(String).filter((dep) => knownIds.has(dep) && dep !== record.id)
      : [];
    if (record.skillIds !== undefined && !Array.isArray(record.skillIds)) delete record.skillIds;
    if (record.maxRetries !== undefined && !Number.isInteger(Number(record.maxRetries))) delete record.maxRetries;
    if (record.timeoutMs !== undefined && !Number.isFinite(Number(record.timeoutMs))) delete record.timeoutMs;
  }
  return mapped;
}

/**
 * Plan de repli déterministe : une seule étape LLM qui traite l'objectif.
 * Sert quand le provider de planning échoue ou renvoie du JSON irréparable —
 * l'utilisateur obtient une mission exécutable minimale au lieu d'une erreur.
 */
export function fallbackPlanSteps(objective: string): unknown[] {
  const trimmed = objective.trim().slice(0, 300);
  return [
    {
      id: "step-1",
      type: "llm",
      name: "Traiter l'objectif",
      description: `Exécuter l'objectif suivant de façon autonome : ${trimmed}`,
      dependencies: [],
      skillIds: [],
      input: { objective: trimmed },
      maxRetries: 2,
      timeoutMs: 180_000,
      sideEffect: false,
      requiresApproval: false,
    },
  ];
}
