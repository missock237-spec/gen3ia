import { isExternalAppConnected, NEVER_BYPASSED_TOOLS } from "@/lib/security/connected-apps";
import type { RuntimeStep } from "@/lib/agents/runtime/types";

/**
 * Politique d'approbation (directive utilisateur 10-10) :
 *
 *   « aucune approbation n'est demandée pour une utilisation d'un outil
 *    interne ; une validation n'est demandée que pour des actions qui
 *    manipulent des secrets utilisateurs. »
 *
 * Traduction opérationnelle :
 *   1. OUTILS INTERNES (tout ce qui opère sur l'infrastructure et les
 *      données Gen3ia de l'utilisateur — génération image/vidéo/audio,
 *      fichiers, artefacts, mémoires, automatisations, équipes d'agents,
 *      lectures web) → JAMAIS d'approbation, quel que soit le mode.
 *   2. APPS EXTERNES → régime « connecté = agir » : validation uniquement
 *      si l'app ciblée n'est PAS connectée (une app connectée a déjà été
 *      autorisée par l'utilisateur — redemander serait de la friction).
 *   3. PLANCHER INVARIANT : ads.publish, phone.call (actions externes
 *      irréversibles et payantes — pas des outils internes) et custom_api.write
 *      (écrit avec les identifiants/secrets API de l'utilisateur) passent
 *      TOUJOURS par l'humain.
 */

/** Outils agissant uniquement sur les données Gen3ia de l'utilisateur. */
export const INTERNAL_ACTION_TOOLS = new Set([
  // Fichiers & artefacts (stockage Gen3ia)
  "file.create",
  "file.modify",
  "file.delete",
  "artifact.create",
  // Mémoire utilisateur
  "memory.write",
  // Automatisations internes
  "schedule.create",
  "schedule.update",
  "schedule.delete",
  "workflow.create",
  "workflow.update",
  "workflow.delete",
  "workflow.run",
  // Équipes d'agents : messagerie interne propriétaire-scopée (aucune app
  // externe, destinataire revérifié membre du MÊME réseau au dépôt).
  "network.send_message",
  "network.mark_read",
  // MÉDIAS & VOIX — génération/analyse sur l'infrastructure Gen3ia
  // (directive 10-10 : la génération ne doit JAMAIS être bloquée par une
  // carte « Confirmation requise » — captures production 07:24).
  "image.generate",
  "video.create",
  "video.status",
  "video.revise",
  "media.analyze",
  "voice.speak",
  "voice.list",
  // Communications émises depuis l'infrastructure de la plateforme
  // (Resend côté serveur — aucune app utilisateur ciblée).
  "email.send",
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
      if (INTERNAL_ACTION_TOOLS.has(toolName)) return null;
      if (NEVER_BYPASSED_TOOLS.has(toolName)) return step;
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
  if (INTERNAL_ACTION_TOOLS.has(toolName)) return false;
  if (options?.risk === "critical") return true;
  if (NEVER_BYPASSED_TOOLS.has(toolName)) return true;
  if (options?.sensitive === false) return false;
  const connected = await isExternalAppConnected(userId, toolName, input);
  return !connected;
}
