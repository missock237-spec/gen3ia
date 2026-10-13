/**
 * Task 141 — options de modèles IA exposées dans le composer conversationnel.
 *
 * Module PUR (aucune dépendance serveur) : partagé entre le composer client,
 * la persistance localStorage et les tests unitaires.
 *
 * « Auto » laisse le routeur Gen3ia choisir (repli élastique multi-fournisseurs
 * — Task 42) ; les autres options fixent le couple provider/model du tour.
 * Le routeur retombe automatiquement sur un autre fournisseur si le modèle
 * choisi est indisponible (coupe-circuit + résilience élastique).
 */

export interface ComposerModelChoice {
  provider?: string;
  model?: string;
  /** Libellé court affiché dans la pill du composer. */
  label: string;
}

export interface ComposerModelOption extends ComposerModelChoice {
  id: string;
  description: string;
}

export const COMPOSER_MODEL_OPTIONS: ComposerModelOption[] = [
  {
    id: "auto",
    label: "Automatique",
    description: "Le routeur Gen3ia choisit le meilleur modèle disponible — recommandé.",
  },
  {
    id: "glm-flash",
    provider: "glm",
    model: "glm-4-flash",
    label: "GLM 4 Flash",
    description: "Ultra rapide et économique — idéal pour le quotidien.",
  },
  {
    id: "gpt-4o",
    provider: "openai",
    model: "gpt-4o",
    label: "GPT-4o",
    description: "OpenAI — raisonnement polyvalent et vision.",
  },
  {
    id: "claude-sonnet",
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    label: "Claude 3.5 Sonnet",
    description: "Anthropic — rédaction soignée et analyse approfondie.",
  },
  {
    id: "gpt-oss",
    provider: "groq",
    model: "openai/gpt-oss-120b",
    label: "GPT-OSS 120B",
    description: "Groq — réponses éclair en open source.",
  },
];

/** Résout une option par identifiant (null = choix inconnu → « Auto »). */
export function findModelOption(id: string | undefined): ComposerModelOption | null {
  if (!id) return null;
  return COMPOSER_MODEL_OPTIONS.find((option) => option.id === id) ?? null;
}

/** Libellé compact de la pill : « Moteur : GLM 4 Flash ». */
export function modelChoiceLabel(id: string | undefined): string {
  return findModelOption(id)?.label ?? "Automatique";
}
