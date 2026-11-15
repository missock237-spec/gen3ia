import type { AgentType } from "@/lib/agents/agent-types";

/**
 * TEMPLATES D'AGENTS SECTORIELS — types (Task 132).
 *
 * Un template est une DONNÉE PURE (aucune dépendance serveur) : il peut
 * être importé par l'UI (grille Bibliothèque) et par le serveur
 * (instanciation). L'instanciation passe par la fabrique d'agents
 * (lib/agents/factory.ts) puis le dépôt validant (lib/agents/repository.ts)
 * — voir ./instantiate.ts.
 */

/** Type d'un template d'agent sectoriel prêt à l'emploi. */
export interface AgentTemplate {
  /** Identifiant slug unique (utilisé dans les liens `?template=<id>`). */
  id: string;
  /** Nom métier affiché (l'agent instancié sera préfixé « Agent … »). */
  nom: string;
  /** Description courte (grille Bibliothèque, ≤ 300 caractères). */
  description: string;
  /** Secteur d'activité couvert par le template. */
  secteur: string;
  /** Persona : prompt système complet de l'agent (français). */
  persona: string;
  /**
   * ALLOWLIST d'outils autorisés — identifiants RÉELS du registre Gen3ia
   * (lib/tools/registry + lib/security/tool-permissions). Portée dans
   * agent.tools à l'instanciation.
   */
  outilsAutorises: string[];
  /** Préférences de modèle (stratégie de routage, température, itérations). */
  preferencesModele: {
    strategie: "automatic" | "fixed";
    fournisseur?: string;
    modele?: string;
    /** 0 = déterministe, 2 = très créatif. */
    temperature: number;
    /** Profondeur d'exécution maximale par mission (1..20). */
    maxIterations: number;
  };
  /** Compétences déclarées (libellés proposés au propriétaire). */
  competences: string[];
  /**
   * Amorces de connaissances : rappels fondamentaux ajoutés au prompt
   * système à l'instanciation (l'agent démarre avec ces repères métier).
   */
  amorcesConnaissances: string[];
  /** Type technique d'agent (AGENT_TYPES) pilotant la charte et le niveau. */
  typeAgent: AgentType;
}
