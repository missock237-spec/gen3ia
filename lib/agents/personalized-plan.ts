import { randomUUID } from "node:crypto";

import { createAgentPolicy, type AgentSecurityLevel } from "@/lib/security/agent-policy";
import type { ExecutionPolicy } from "@/lib/security/execution-policy";
import type { RuntimePlan, RuntimeStep } from "@/lib/agents/runtime/types";

import { AGENT_TYPE_META, type AgentRecord } from "./schema";
import { GEN3IA_TOOLS } from "@/lib/tools/registry";
import { KNOWN_TOOL_SECURITY_NAMES } from "@/lib/security/tool-permissions";

/**
 * Traduit un agent personnalise (record Firestore) en plan d'execution concret
 * pour AgentRuntime, et derive sa politique de securite. Un agent cree et
 * personnalise via le Studio doit pouvoir s'executer immediatement.
 *
 * NOUVEAU CONTRAT (Task 107 — « l'agent IA a accès à TOUS les outils ») :
 * l'utilisateur ne désigne plus les outils — l'agent comprend seul et
 * sélectionne automatiquement les bons outils dans le catalogue complet du
 * projet. Les outils déclarés (`agent.tools`) restent un bonus de compat :
 * ils sont fusionnés à la whitelist mais n'y restreignent plus rien.
 * La whitelist émet la sentinelle "*" (catalogue complet — sémantique déjà
 * supportée par isToolAllowed dans execution-policy.ts et par unified-agent
 * depuis le lot C) SAUF quand une exception doit s'exprimer :
 *  - niveau safe : lecture seule par design → liste réduite explicite, JAMAIS
 *    la sentinelle ;
 *  - caps persona désactivant une capacité (webSearch / codeExecution /
 *    fileGeneration) : "*" ne sait pas dire « tout sauf X » → repasse en liste
 *    explicite = registre complet moins les outils désactivés ;
 *  - ui.components : outil EXCLUSIF des agents de type "code" (même logique
 *    qu'avant) → liste explicite pour tout agent non-code.
 * La barrière fine reste en aval : permissions + flags (authorizeTool), HITL
 * (approval-policy), consentements + kill-switch (executor), existence réelle
 * au registre exécutable.
 */

const ROLE_BY_TYPE: Record<string, string> = {
  universal: "general",
  code: "developer",
  content: "publisher",
  research: "researcher",
  automation: "planner",
};

/**
 * Outils d'exécution exclusifs aux agents de type "code" : terminal isolé,
 * exécution sandbox et simulation de code. Ajoutés à la whitelist du niveau
 * power (leur niveau) SAUF si la persona désactive l'exécution de code —
 * l'agent de code doit pouvoir, de sa propre initiative, exécuter ou
 * simuler le code qu'il produit (terminal, vérification, débogage).
 */
const CODE_AGENT_TOOLS = ["terminal.execute", "code.execute", "code.simulate"];

/**
 * Sources canoniques des noms d'outils exécutables (Task 107) : l'UNION du
 * catalogue statique GEN3IA_TOOLS et des définitions de sécurité
 * KNOWN_TOOL_SECURITY_NAMES (qui couvre schedule.*, workflow.* — absents du
 * catalogue) est LA source unique de vérité — toute évolution du registre se
 * propage automatiquement à la whitelist explicite et à l'orchestrateur.
 */
const REGISTRY_TOOL_SET: ReadonlySet<string> = new Set([
  ...GEN3IA_TOOLS.map((tool) => tool.name),
  ...KNOWN_TOOL_SECURITY_NAMES,
]);
const FULL_TOOL_NAMES: readonly string[] = Object.freeze([...REGISTRY_TOOL_SET]);

export function securityLevelForAgent(agent: AgentRecord): AgentSecurityLevel {
  return AGENT_TYPE_META[agent.type]?.securityLevel ?? "standard";
}

/**
 * Résout la whitelist d'outils effective d'un agent (fonction pure, exportée
 * pour tests) :
 *  - safe → liste réduite explicite (outils déclarés valides uniquement),
 *    JAMAIS la sentinelle "*" ;
 *  - standard/power/admin → ["*"] (les outils déclarés restent fusionnés
 *    au-dessus pour compat — inoffensifs avec la sentinelle) SAUF si une
 *    exclusion s'applique (cap persona désactivée, ui.components hors agents
 *    code) : dans ce cas, liste explicite = registre complet moins les
 *    exclusions — sémantiquement équivalente pour unified-agent (filtre par
 *    nom) tout en exprimant l'exception.
 */
export function resolveAllowedTools(level: AgentSecurityLevel, agent: AgentRecord): string[] {
  const caps = agent.persona?.capabilities;
  const isCodeAgent = agent.type === "code";

  // Exclusions non négociables : leur présence force la liste explicite (la
  // sentinelle "*" ne peut pas exprimer d'exception).
  const exclusions = new Set<string>();
  if (caps?.webSearch === false) exclusions.add("web.search");
  if (caps?.codeExecution === false) {
    // Couper l'exécution de code retire TOUT le panel code (exécution,
    // simulation, terminal isolé) — intention historique des caps persona
    // (CODE_AGENT_TOOLS n'était pas ajouté quand codeExecution === false).
    exclusions.add("code.execute");
    exclusions.add("code.simulate");
    exclusions.add("terminal.execute");
  }
  if (caps?.fileGeneration === false) exclusions.add("artifact.create");
  // ui.components est l'outil EXCLUSIF des agents de type "code" : aucun
  // autre type ne peut l'obtenir, ni en le déclarant, ni via la sentinelle.
  if (!isCodeAgent) exclusions.add("ui.components");

  // Étape 7 (défense en profondeur) : seuls les outils RÉELLEMENT présents au
  // registre Gen3ia rejoignent la whitelist — les records legacy contenant des
  // outils fantômes (« gmail », « jira »…) ne déclenchent plus de whitelist
  // morte, et les noms « en clair » (espaces, majuscules) ne sont plus
  // silencieusement jetés sans traçabilité (résolus à la création par
  // lib/agents/tool-resolver). Les outils exclus (caps / ui.components) ne
  // peuvent pas être réintroduits par la déclaration.
  const declared = agent.tools.filter(
    (tool) => /^[a-z0-9_.]+$/.test(tool) && tool.length <= 80 && REGISTRY_TOOL_SET.has(tool) && !exclusions.has(tool),
  );

  // Niveau safe : lecture seule par design — whitelist réduite explicite,
  // aucune sentinelle.
  if (level === "safe") return Array.from(new Set(declared));

  // standard/power/admin sans exclusion : sentinelle "*" = catalogue complet.
  if (exclusions.size === 0) {
    return ["*", ...new Set(declared)];
  }

  // Une exclusion s'applique : liste explicite = registre complet moins les
  // exclusions (suit automatiquement toute évolution des deux sources).
  const explicit = FULL_TOOL_NAMES.filter((tool) => !exclusions.has(tool));
  // Les agents de code gardent le terminal isolé et la simulation : déjà
  // couverts par le registre, l'ajout explicite préserve la parité avec
  // l'ajout historique si le catalogue évolue ; retirés si la persona coupe
  // l'exécution de code.
  if (isCodeAgent && caps?.codeExecution !== false) {
    for (const tool of CODE_AGENT_TOOLS) {
      if (!exclusions.has(tool)) explicit.push(tool);
    }
  }
  return Array.from(new Set([...explicit, ...declared]));
}

export function policyForAgent(agent: AgentRecord): ExecutionPolicy {
  const level = securityLevelForAgent(agent);
  const base = createAgentPolicy(level);
  return {
    ...base,
    // Whitelist résolue : sentinelle "*" ou liste explicite (caps persona /
    // exclusivité ui.components) — cf. resolveAllowedTools. Les outils
    // déclarés par le propriétaire restent soumis aux garde-fous aval
    // (authorizeTool, approval, metering) dans executeToolSecurely.
    allowedTools: resolveAllowedTools(level, agent),
  };
}

function baseStep(partial: Omit<RuntimeStep, "status" | "skillIds" | "maxRetries" | "timeoutMs" | "sideEffect" | "requiresApproval" | "dependencies" | "input"> & {
  dependencies?: string[];
  input?: Record<string, unknown>;
}): RuntimeStep {
  return {
    dependencies: [],
    input: {},
    skillIds: [],
    maxRetries: 2,
    timeoutMs: 120_000,
    sideEffect: false,
    requiresApproval: false,
    status: "pending",
    ...partial,
  };
}

export function createPersonalizedPlan(agent: AgentRecord, objective: string, executionId = randomUUID()): RuntimePlan {
  const role = ROLE_BY_TYPE[agent.type] ?? "general";
  const steps: RuntimeStep[] = [];

  if (agent.webResearchEnabled) {
    steps.push(
      baseStep({
        id: "research_context",
        type: "research",
        name: "Collecte d'informations",
        description: "Rechercher les informations externes necessaires a l'objectif.",
        agentRole: "researcher",
        input: { query: objective },
      }),
    );
  }

  steps.push(
    baseStep({
      id: "deliver_result",
      type: "llm",
      name: "Execution de la mission",
      description:
        agent.type === "code"
          ? `${objective}\n\nConsignes d'agent de code : produis un code complet et prêt à exécuter. Utilise le terminal isolé (terminal.execute) pour explorer et vérifier, et code.simulate pour valider tout extrait de code sensible sans effet externe. Announce clairement le mode d'exécution utilisé.`
          : objective,
      agentRole: role,
      ...(steps.length > 0 ? { dependencies: [steps[0].id] } : {}),
    }),
  );

  return {
    executionId,
    objective,
    steps,
    maxConcurrency: steps.length > 1 ? 2 : 1,
    maxIterations: Math.min(agent.maxIterations, 20),
  };
}
