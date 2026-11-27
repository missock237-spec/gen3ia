import { isExternalAppConnected, NEVER_BYPASSED_TOOLS } from "@/lib/security/connected-apps";
import type { RuntimeStep } from "@/lib/agents/runtime/types";

/**
 * Politique d'approbation (directive utilisateur 10-10, amendée v2.1 —
 * vague post-audit) :
 *
 *   « aucune approbation n'est demandée pour une utilisation d'un outil
 *    interne ; une validation n'est demandée que pour des actions qui
 *    manipulent des secrets utilisateurs. »
 *
 * AMENDEMENT v2.1 (audit externe P1 : « la politique de validation humaine
 * est trop permissive pour certaines opérations ») — classification à
 * TROIS NIVEAUX :
 *   - FAIBLE (lecture, recherche, analyse)             → exécution directe ;
 *   - MOYEN  (création interne, génération média)       → exécution directe
 *             (directive 10-10 : outils internes scopés propriétaire) ;
 *   - ÉLEVÉ  (suppression, envoi émis, commande arbitraire) → confirmation
 *             humaine explicite MÊME quand l'outil est « interne » : un
 *             email envoyé depuis l'infrastructure reste reçu par une
 *             personne extérieure ; une suppression est irréversible ; une
 *             commande arbitraire peut tout affecter.
 * Les planchers invariants (ads.publish, phone.call, custom_api.write)
 * restent inchangés. Dans les missions d'agents, le lancement explicite de
 * la mission par l'utilisateur vaut autorisation spécifique (le runtime
 * missions garde son propre contrôle d'autonomie — autonomy-guard).
 */

/** Outils INTERNES promus au niveau ÉLEVÉ par l'amendement v2.1
 *  (confirmation humaine requise). Audit P1 : file.delete /
 *  schedule.delete / workflow.delete (irréversibles), email.send (effet
 *  externe réel — le message atteint une personne hors plateforme),
 *  terminal.run (commande arbitraire sur l'infrastructure). */
export const OUTILS_INTERNES_NIVEAU_ELEVE = new Set([
  "file.delete",
  "schedule.delete",
  "workflow.delete",
  "email.send",
  "terminal.run",
]);

/** Classification à trois niveaux d'un outil (audit externe P1, v2.1).
 *  - "eleve"  : destructif / effet externe / commande arbitraire →
 *               confirmation humaine explicite (même outil interne) ;
 *  - "moyen"  : création interne avec effet de bord scopé propriétaire ;
 *  - "faible" : lecture, recherche, analyse → exécution directe.
 *  Les mutations externes (composio.execute, ads.publish…) restent gérées
 *  par autonomy-guard en plus de cette classification. */
export function niveauRisqueOutil(toolName: string): "faible" | "moyen" | "eleve" {
  if (OUTILS_INTERNES_NIVEAU_ELEVE.has(toolName)) return "eleve";
  if (INTERNAL_ACTION_TOOLS.has(toolName)) return "moyen";
  return "faible";
}

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
  // TERMINAL INTÉGRÉ (Task 122) : terminal.run exécute des commandes réelles
  // dans la microVM serverless DE LA PLATEFORME — environnement de subprocess
  // NETTOYÉ (aucun secret hérité : PATH standard + HOME=/tmp + LANG, jamais
  // process.env), cwd dans un workspace /tmp éphémère, deny-list durcie
  // (lib/sandbox/policy.ts), timeout dur, sortie plafonnée. Il ne manipule
  // NI secret utilisateur NI app externe → les règles d'approbation
  // (directive 10-10 : validation UNIQUEMENT pour les secrets utilisateurs)
  // ne l'exigent pas → OUTIL INTERNE, comme files. Les commandes dangereuses
  // sont rejetées AVANT exécution par la politique partagée ; l'audit et la
  // facturation restent appliqués. (terminal.execute, lui, reste l'ancien
  // flux « commande autorisée » à validation explicite.)
  "terminal.run",
  // Task 140 — SUITE « OUTILS PILOTÉS PAR LES AGENTS IA » : les outils
  // INTERNES de la suite (LLM facturé, artefacts, registres, calcul pur —
  // aucune app externe ciblée, aucun secret utilisateur manipulé) suivent
  // la directive 10-10 : JAMAIS de carte de validation. Les trois outils
  // EXTERNES de la suite (build.autofix : PR GitHub réelle ;
  // voicemail.respond : envoi email/SMS ; webhook.heal : re-soumission
  // POST) restent hors de cet ensemble → validation humaine du flux HITL.
  "handover.compose",
  "terminal.shield",
  "simulation.run",
  "watchdog.track",
  "terminal.guide",
  "content.package",
  "knowledge.graph",
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
      // AMENDEMENT v2.1 : les outils internes de niveau ÉLEVÉ (suppression,
      // envoi émis, commande arbitraire) exigent la confirmation humaine.
      if (OUTILS_INTERNES_NIVEAU_ELEVE.has(toolName)) return step;
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
  // AMENDEMENT v2.1 : niveau ÉLEVÉ interne → confirmation explicite.
  if (OUTILS_INTERNES_NIVEAU_ELEVE.has(toolName)) return true;
  if (INTERNAL_ACTION_TOOLS.has(toolName)) return false;
  if (options?.risk === "critical") return true;
  if (NEVER_BYPASSED_TOOLS.has(toolName)) return true;
  if (options?.sensitive === false) return false;
  const connected = await isExternalAppConnected(userId, toolName, input);
  return !connected;
}
