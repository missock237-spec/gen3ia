/**
 * Task 141 — options de modèles IA exposées dans le composer conversationnel.
 *
 * Module PUR (aucune dépendance serveur) : partagé entre le composer client,
 * la persistance localStorage et les tests unitaires.
 *
 * MOTEUR UNIQUE : les IA externes (OpenAI, Anthropic, Groq, OpenRouter, GLM,
 * Agnes) ont été SUPPRIMÉES du projet sur demande explicite de l'utilisateur
 * — le SYSTÈME NEURONAL Gen3 (SNN interne) est l'unique moteur. La liste
 * reste exposée pour la compatibilité des appels (label « Neural Gen3 »)
 * mais ne propose plus aucun fournisseur externe.
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
    description: "Le moteur neuronal Gen3 traite votre demande — recommandé.",
  },
  {
    id: "neural",
    provider: "gen3-snn",
    model: "gen3-snn-v1",
    label: "Neural Gen3",
    description: "Le système neuronal Gen3 (SNN à spikes) — moteur interne de la plateforme.",
  },
];

/** Résout une option par identifiant (null = choix inconnu → « Auto »). */
export function findModelOption(id: string | undefined): ComposerModelOption | null {
  if (!id) return null;
  return COMPOSER_MODEL_OPTIONS.find((option) => option.id === id) ?? null;
}

/** Libellé compact de la pill : « Moteur : Neural Gen3 ». */
export function modelChoiceLabel(id: string | undefined): string {
  return findModelOption(id)?.label ?? "Automatique";
}
