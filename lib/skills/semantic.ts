import {
  embedderLexical,
  similariteCosinus,
} from "@/lib/neural/encoding/lexical-embedding";

/**
 * RECHERCHE SÉMANTIQUE DE COMPÉTENCES — encodeur LEXICAL LOCAL.
 *
 * Les embeddings distants (Hugging Face Inference — IA externe) ont été
 * SUPPRIMÉS du projet sur demande explicite de l'utilisateur. La
 * sélection sémantique de compétences repose désormais sur l'encodeur
 * lexical local Gen3 (lib/neural/encoding/lexical-embedding.ts) —
 * déterministe, instantané, sans clé ni appel réseau.
 *
 * Contrat inchangé pour lib/skills/selector.ts.
 */

export async function createEmbedding(
  text: string,
): Promise<number[]> {
  return embedderLexical(text);
}

export function similarity(
  a: number[],
  b: number[],
): number {
  return similariteCosinus(a, b);
}

export function buildSkillSearchText(skill: {
  name: string;
  description: string;
  category: string;
  capabilities: Array<{
    name: string;
    description: string;
  }>;
  compatibleTasks: string[];
  triggers: string[];
}): string {
  return [
    skill.name,
    skill.description,
    skill.category,
    skill.capabilities
      .map(
        (capability) =>
          `${capability.name}: ${capability.description}`,
      )
      .join(" "),
    skill.compatibleTasks.join(" "),
    skill.triggers.join(" "),
  ].join("\n");
}
