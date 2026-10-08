import {
  DEFAULT_EXECUTION_POLICY,
  type ExecutionPolicy,
} from "./execution-policy";

export type AgentSecurityLevel =
  | "safe"
  | "standard"
  | "power"
  | "admin";

/**
 * MODÈLE DE WHITELIST (Task 107 — « l'agent IA a accès à TOUS les outils ») :
 *
 *  - La liste blanche n'est PLUS le filtre principal : la sentinelle "*" est
 *    émise pour les niveaux standard, power et admin (isToolAllowed dans
 *    execution-policy.ts traite "*" comme passe-partout — même sémantique que
 *    CONVERSATION_EXECUTION_POLICY dans lib/domain/conversations/engine.ts).
 *    Seul le niveau safe conserve une whitelist réduite explicite (mode
 *    lecture seule par design : rien d'exécutable tant que rien n'est déclaré).
 *  - Les BARRIÈRES RÉELLES restent en aval, par couches indépendantes :
 *      1. permissions fines (assertPermission) + flags (allowNetwork,
 *         allowExternalApps, allowCodeExecution…) via authorizeTool ;
 *      2. caps persona : resolveAllowedTools (lib/agents/personalized-plan.ts)
 *         repasse en liste explicite quand une capacité est désactivée ou que
 *         l'exclusivité ui.components s'applique (la sentinelle ne sait pas
 *         exprimer d'exception) ;
 *      3. HITL : approval-policy (stepRequiresHumanApproval + plancher
 *         NEVER_BYPASSED_TOOLS : ads.publish, file.delete, phone.call) ;
 *      4. existence réelle au registre exécutable (lib/tools/default-registry)
 *         : un outil non enregistré échoue proprement de toute façon, ainsi
 *         que les consentements par catégorie et le kill-switch (executor).
 */
export function createAgentPolicy(
  level: AgentSecurityLevel,
): ExecutionPolicy {
  const base: ExecutionPolicy = {
    ...DEFAULT_EXECUTION_POLICY,
    allowedTools: [],
    permissions: ["tool.read", "file.read"],
  };

  switch (level) {
    case "safe":
      // INCHANGÉ (Task 107) : lecture seule par design — AUCUNE sentinelle,
      // whitelist vide ; les outils déclarés du record restent fusionnés par
      // resolveAllowedTools côté personalized-plan.
      return base;

    case "standard":
      return {
        ...base,
        // Sentinelle "*" : catalogue complet. La résolution caps persona /
        // exclusivité ui.components est faite par resolveAllowedTools
        // (personalized-plan.ts), qui repasse en liste explicite quand une
        // exclusion s'applique — contrat inter-lots Task 107 (lot C :
        // unified-agent traite "*" = catalogue GEN3IA_TOOLS complet).
        allowedTools: ["*"],
        permissions: [
          "tool.read",
          "tool.write",
          // Task 107 : tool.external + network.write — les agents standard
          // doivent pouvoir envoyer emails/messages et agir via des services
          // externes. Le risque reste couvert en aval : HITL (approval-policy,
          // jamais contourné par cet élargissement), consentements, audit.
          "tool.external",
          "file.read",
          "file.write",
          "file.create",
          // network.read est requis par web.search (lecture seule) : sans lui,
          // tout agent standard dont la mission active la recherche web
          // echouait immediatement avec « Permission denied: network.read ».
          "network.read",
          // Task 107 : network.write requis par email.send, messaging.send,
          // notion.create_page… (outils classés network dans tool-permissions).
          "network.write",
        ],
        allowNetwork: true,
        allowFileWrite: true,
      };

    case "power":
      return {
        ...base,
        // Sentinelle "*" (Task 107) : la liste explicite historique (11 outils)
        // est remplacée — les barrières réelles sont les permissions + flags
        // ci-dessous, le HITL et les caps persona.
        allowedTools: ["*"],
        permissions: [
          "tool.read",
          "tool.write",
          "tool.external",
          "file.read",
          "file.write",
          "file.create",
          "network.read",
          "network.write",
          "code.execute",
          // Task 107 : permissions publicitaires — ads.read pour la lecture
          // des comptes, ads.write requis par ads.publish côté authorizeTool.
          "ads.read",
          "ads.write",
        ],
        allowNetwork: true,
        allowExternalApps: true,
        allowFileWrite: true,
        allowCodeExecution: true,
      };

    case "admin":
      return {
        ...base,
        // Déjà la sentinelle avant Task 107 — conservée.
        allowedTools: ["*"],
        permissions: [
          "tool.read",
          "tool.write",
          "tool.external",
          "tool.destructive",
          "file.read",
          "file.write",
          "file.create",
          "file.delete",
          "network.read",
          "network.write",
          "code.execute",
          // Task 107 : ads.* manquants — une whitelist "*" sans les
          // permissions correspondantes produirait des refus systématiques
          // côté authorizeTool (ads.read / ads.publish).
          "ads.read",
          "ads.write",
        ],
        allowNetwork: true,
        allowExternalApps: true,
        allowFileWrite: true,
        allowFileDelete: true,
        allowCodeExecution: true,
      };
  }
}
