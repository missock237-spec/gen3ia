import { isExternalAppConnected, NEVER_BYPASSED_TOOLS } from "@/lib/security/connected-apps";
import type { RuntimeStep } from "@/lib/agents/runtime/types";

/**
 * Politique d'approbation conditionnelle (demande explicite utilisateur) :
 * une validation humaine n'est requise QUE si l'app externe ciblée par
 * l'agent est NON connectée. Si l'app est déjà connectée (statut actif),
 * l'agent agit directement — sans carte de validation.
 *
 * Plancher de sécurité invariant (jamais contourné, quel que soit l'état de
 * connexion) : ads.publish, file.delete, phone.call — et tout risque
 * critical. Les actions purement internes (stockage Gen3ia, mémoire,
 * automatisations propres à la plateforme) n'appellent aucune app externe :
 * elles s'exécutent toujours directement.
 */

/** Outils agissant uniquement sur les données Gen3ia de l'utilisateur. */
export const INTERNAL_ACTION_TOOLS = new Set([
  "file.create",
  "file.modify",
  "artifact.create",
  "memory.write",
  "schedule.create",
  "schedule.update",
  "schedule.delete",
  "workflow.create",
  "workflow.update",
  "workflow.delete",
  "workflow.run",
]);

/** Décide, pour une liste d'étapes de plan, lesquelles exigent une approbation. */
export async function selectApprovalRequiredSteps(
  userId: string,
  steps: RuntimeStep[],
): Promise<RuntimeStep[]> {
  const decisions = await Promise.all(
    steps.map(async (step) => {
      if (step.type !== "tool" || !(step.requiresApproval || step.sideEffect)) return null;
      const toolName = step.toolName ?? "";
      if (!toolName) return null;
      if (NEVER_BYPASSED_TOOLS.has(toolName)) return step;
      if (INTERNAL_ACTION_TOOLS.has(toolName)) return null;
      const connected = await isExternalAppConnected(userId, toolName, (step.input ?? {}) as Record<string, unknown>);
      return connected ? null : step;
    }),
  );
  return decisions.filter((step): step is RuntimeStep => step !== null);
}

/** Une étape donnée exige-t-elle une approbation (logique partagée) ? */
export async function stepRequiresHumanApproval(
  userId: string,
  toolName: string,
  input: Record<string, unknown>,
  options?: { sensitive?: boolean; risk?: string },
): Promise<boolean> {
  if (options?.risk === "critical") return true;
  if (NEVER_BYPASSED_TOOLS.has(toolName)) return true;
  if (INTERNAL_ACTION_TOOLS.has(toolName)) return false;
  if (options?.sensitive === false) return false;
  const connected = await isExternalAppConnected(userId, toolName, input);
  return !connected;
}
