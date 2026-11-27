/**
 * PP SERVEUR — routeur de commandes branché sur le CERVEAU GEN3 RÉEL.
 *
 * Chaque commande PP passe par les cheminements RÉELS du dépôt (aucune
 * logique parallèle) :
 *  · BRAIN_CHAT       → lib/ai/router.generate — LE moteur neuronal Gen3 ;
 *  · EXECUTE_TOOL     → authorizeTool (politique de sécurité réelle) puis
 *                       executeTool (pipeline sécurisé partagé, audit) —
 *                       HITL : risk destructive/external ⇒
 *                       confirmationRequired=true, exécution suspendue ;
 *  · DEPLOY_WORKFLOW  → workflow.run via le même chemin EXECUTE_TOOL ;
 *  · PP_STATUS        → état réel du processus (aucune donnée sensible).
 */

import { generate } from "@/lib/ai/router";
import type { AIRequest } from "@/lib/ai/models";
import { authorizeTool, getToolSecurityDefinition } from "@/lib/security/tool-permissions";
import { DEFAULT_EXECUTION_POLICY, type ExecutionPolicy } from "@/lib/security/execution-policy";
import { executerOutilViaGateway } from "@/lib/capabilities/execution/pont-legacy";

export interface PpCommandContext {
  /** Identité du pair demandeur (peerId du registre, approuvé). */
  peerId: string;
  appId: string;
  /** Chemin d'audit — l'exécution outil doit porter l'identité d'origine. */
  userId: string;
}

export interface PpCommandResult {
  ok: boolean;
  data?: unknown;
  errorCode?: string;
  errorMessage?: string;
  /** HITL niveau ÉLEVÉ : outil à risque exigeant une confirmation humaine. */
  confirmationRequired?: boolean;
  securityDefinition?: { name: string; risk: string; network?: boolean; destructive?: boolean; externalApp?: boolean };
}

/** Politique d'exécution pour les pairs PP :_tools autorisés explicitement. */
function ppExecutionPolicy(toolName: string, allowNetwork: boolean): ExecutionPolicy {
  return {
    ...DEFAULT_EXECUTION_POLICY,
    allowedTools: [toolName],
    permissions: ["tool.read", "tool.write", "file.read", "memory.read"],
    allowNetwork,
  };
}

export function createGen3CommandRouter(options: { allowNetworkTools?: boolean } = {}) {
  return async function handleCommand(command: string, payloadBytes: Uint8Array, context: PpCommandContext): Promise<PpCommandResult> {
    let payload: Record<string, unknown> = {};
    if (payloadBytes && payloadBytes.length > 0) {
      try {
        payload = JSON.parse(Buffer.from(payloadBytes).toString("utf8")) as Record<string, unknown>;
      } catch {
        return { ok: false, errorCode: "payload_invalide", errorMessage: "charge JSON invalide" };
      }
    }

    switch (command) {
      case "BRAIN_CHAT": {
        const messages = (payload.messages as Array<{ role: "system" | "user" | "assistant"; content: string }> | undefined) ?? [];
        if (!Array.isArray(messages) || messages.length === 0) {
          return { ok: false, errorCode: "messages_absents", errorMessage: "BRAIN_CHAT exige messages[] non vide" };
        }
        const request: AIRequest = {
          task: "chat",
          messages,
          temperature: typeof payload.temperature === "number" ? payload.temperature : undefined,
          maxTokens: typeof payload.maxTokens === "number" ? payload.maxTokens : undefined,
        };
        const response = await generate(request);
        return { ok: true, data: { texte: response.text, modele: response.model ?? null, usage: response.usage ?? null } };
      }

      case "EXECUTE_TOOL":
      case "DEPLOY_WORKFLOW": {
        const toolName = command === "DEPLOY_WORKFLOW" ? "workflow.run" : String(payload.toolName ?? "");
        if (!toolName) return { ok: false, errorCode: "outil_absent", errorMessage: "EXECUTE_TOOL exige toolName" };
        let definition;
        try {
          definition = getToolSecurityDefinition(toolName);
        } catch {
          return { ok: false, errorCode: "outil_inconnu", errorMessage: `outil inconnu du registre de sécurité : ${toolName}` };
        }
        // HITL — politique 3 niveaux du projet, vérifiée AVANT toute porte de
        // politique : un outil destructive/external (ÉLEVÉ) exige une
        // confirmation humaine explicite, même si la politique l'aurait
        // de toute façon refusé — la réponse ne révèle pas le pourquoi.
        const risky = definition.risk === "destructive" || definition.risk === "external";
        if (risky && payload.confirmation !== true) {
          return {
            ok: false,
            errorCode: "confirmation_requise",
            errorMessage: `outil ${toolName} (risk=${definition.risk}) exige une confirmation humaine explicite (confirmation: true)`,
            confirmationRequired: true,
            securityDefinition: { name: definition.name, risk: definition.risk, network: definition.network, destructive: definition.destructive, externalApp: definition.externalApp },
          };
        }
        try {
          authorizeTool(ppExecutionPolicy(toolName, Boolean(options.allowNetworkTools)), toolName);
        } catch (error) {
          return { ok: false, errorCode: "outil_refuse", errorMessage: error instanceof Error ? error.message : String(error) };
        }
        const input = command === "DEPLOY_WORKFLOW" ? payload : payload.input;
        // Doctrine du dépôt : 100 % des outils passent par le Universal
        // Execution Gateway (garde lib/capabilities/tests/gateway-monopole) —
        // PP n'y échappe pas : origine « pp » tracée dans la chaîne UCE.
        const result = await executerOutilViaGateway({
          userId: context.userId,
          executionId: `pp_${context.peerId.slice(0, 12)}_${Date.now()}`,
          toolName,
          input,
          policy: ppExecutionPolicy(toolName, Boolean(options.allowNetworkTools)),
          origine: "pp",
        });
        return {
          ok: result.success,
          data: result.output,
          errorCode: result.success ? undefined : "execution_echouee",
          errorMessage: result.error,
          securityDefinition: { name: definition.name, risk: definition.risk },
        };
      }

      case "PP_STATUS": {
        return {
          ok: true,
          data: {
            service: "gen3-pp-system-node",
            node: process.version,
            uptimeMs: Math.round(process.uptime() * 1000),
            memoryRssMb: Math.round(process.memoryUsage().rss / 1_048_576),
            peerId: context.peerId.slice(0, 12) + "…",
            appId: context.appId,
          },
        };
      }

      default:
        return { ok: false, errorCode: "commande_inconnue", errorMessage: `commande PP inconnue : ${command} — aucune énumération des services disponible` };
    }
  };
}
