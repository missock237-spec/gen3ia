import "server-only";

import type { SkillDefinitionInput } from "./schema";
import { listSkills } from "./repository";
import { composeSkills } from "./composer";

/**
 * PONT SKILLS → RUNTIME (skills intégré avancé).
 *
 * Jusqu'ici le moteur de skills (sélection sémantique + composition) était
 * une île : aucune exécution réelle ne consommait `composeSkills`. Ce pont
 * alimente le planificateur universel ET les étapes LLM du runner :
 *  - sélection bornée (3 max) parmi les skills ACTIVES visibles par le
 *    principal (visibility "system" OU authorId = utilisateur) ;
 *  - composition des instructions (fondation d'abord) + outils requis ;
 *  - FAIL-SOFT total : toute panne → null (le runtime n'en dépend jamais).
 *
 * Multi-tenant : un utilisateur ne reçoit JAMAIS les skills privées d'un
 * autre (filtre authorId/visibility appliqué AVANT la sélection).
 */

export interface SkillsContextBlock {
  skillIds: string[];
  skillNames: string[];
  systemInstructions: string;
  executionInstructions: string;
  requiredTools: string[];
  evaluationCriteria: string[];
}

const MAX_SKILLS_PER_MISSION = 3;
const MAX_INSTRUCTION_CHARS = 4_000;

function skillInputOf(skill: SkillDefinitionInput): SkillDefinitionInput {
  return skill;
}

/**
 * Sélectionne et compose les skills pertinentes pour un objectif.
 * Retourne null si aucune skill ne matche ou en cas de panne (fail-soft).
 */
export async function selectSkillsForObjective(params: {
  userId: string;
  objective: string;
  taskType?: string;
  maxSkills?: number;
}): Promise<SkillsContextBlock | null> {
  try {
    const all = await listSkills({ status: "active" });
    // Cloisonnement : system (plateforme) + skills privées de l'utilisateur.
    const visible = all.filter(
      (skill) => skill.visibility === "system" || skill.authorId === params.userId,
    );
    if (visible.length === 0) return null;

    const objective = params.objective.toLowerCase();
    const taskType = (params.taskType ?? "*").toLowerCase();

    // Scoring local déterministe (aucune dépendance réseau) :
    //  - compatibleTasks contient "*" ou le type de tâche ;
    //  - recouvrement lexical entre l'objectif et les instructions/compétences.
    const scored = visible
      .map((skill) => {
        const compat = skill.compatibleTasks.includes("*") || skill.compatibleTasks.some((t) => t.toLowerCase() === taskType);
        if (!compat && skill.compatibleTasks.length > 0) return null;
        const haystack = [
          skill.name,
          skill.description,
          ...skill.capabilities.map((c) => `${c.name} ${c.description ?? ""}`),
          ...skill.evaluationCriteria,
        ].join(" ").toLowerCase();
        const tokens = [...new Set(objective.split(/[^\p{L}\p{N}]+/u))].filter((token) => token.length >= 4);
        if (tokens.length === 0) return { skill, score: compat ? 0.5 : 0 };
        const hits = tokens.filter((token) => haystack.includes(token)).length;
        const lexical = tokens.length > 0 ? hits / tokens.length : 0;
        const score = (compat ? 0.5 : 0) + lexical * 0.5;
        return { skill, score };
      })
      .filter((entry): entry is { skill: SkillDefinitionInput; score: number } => entry !== null && entry.score > 0.2)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, Math.min(Math.max(params.maxSkills ?? MAX_SKILLS_PER_MISSION, 1), MAX_SKILLS_PER_MISSION));

    if (scored.length === 0) return null;

    const composed = composeSkills(scored.map((entry) => skillInputOf(entry.skill)));
    return {
      skillIds: scored.map((entry) => String((entry.skill as unknown as { id?: string }).id ?? entry.skill.name)),
      skillNames: scored.map((entry) => entry.skill.name),
      systemInstructions: composed.systemInstructions.slice(0, MAX_INSTRUCTION_CHARS),
      executionInstructions: composed.executionInstructions.slice(0, MAX_INSTRUCTION_CHARS),
      requiredTools: composed.requiredTools.slice(0, 12),
      evaluationCriteria: composed.evaluationCriteria.slice(0, 8),
    };
  } catch {
    return null;
  }
}

/** Bloc "SKILLS ACTIVES" injecté dans le prompt du planificateur. */
export function formatSkillsSection(block: SkillsContextBlock | null): string {
  if (!block) return "";
  return [
    "",
    "SKILLS ACTIVES (spécialisations à appliquer) :",
    `Skills : ${block.skillNames.join(", ")}`,
    block.systemInstructions ? `Instructions système :\n${block.systemInstructions}` : "",
    block.requiredTools.length > 0 ? `Outils requis par ces skills (à privilégier dans le plan) : ${block.requiredTools.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}
