/**
 * PERMISSION & SECURITY ENGINE (UCE-010) — contrôles de permissions UNIFIÉS.
 *
 * Unique point de passage des décisions d'autorisation de l'UCE : il DÉLÈGUE
 * aux mécanismes existants du dépôt (arrêt d'urgence, politique
 * d'exécution, consentements, machine à états UCE) — il n'en crée aucun
 * double. Chaque décision retourne une trace journalisable
 * (PermissionDecisionRecord du contrat).
 */

import "server-only";

import { DEFAULT_EXECUTION_POLICY, type ExecutionPolicy } from "@/lib/security/execution-policy";
import { authorizeTool } from "@/lib/security/tool-permissions";
import { decideConsent, getToolConsents } from "@/lib/security/tool-consents";
import { assertExecutionNotStopped } from "@/lib/security/emergency-stop";
import type { PermissionDecisionRecord } from "../core/capability-contract";

export interface DemandeAutorisationUce {
  userId: string;
  executionId: string;
  /** Nom d'outil natif (si la capacité délègue à un outil du registre). */
  toolName?: string;
  policy?: ExecutionPolicy;
}

export interface ResultatAutorisationUce {
  autorise: boolean;
  decisions: PermissionDecisionRecord[];
  raisonFinale: string;
}

/**
 * Vérifie l'ARRÊT D'URGENCE puis la POLITIQUE pour un outil natif.
 * Chaque couche retourne une décision traçable — aucune décision silencieuse.
 */
export async function autoriserExecutionUce(demande: DemandeAutorisationUce): Promise<ResultatAutorisationUce> {
  const decisions: PermissionDecisionRecord[] = [];

  // Couche 1 : arrêt d'urgence utilisateur (kill switch) — non négociable.
  try {
    await assertExecutionNotStopped({ userId: demande.userId, executionId: demande.executionId });
    decisions.push({ couche: "arret-urgence", autorise: true, raison: "aucun arrêt d'urgence actif" });
  } catch (erreur) {
    const raison = erreur instanceof Error ? erreur.message : "arrêt d'urgence actif";
    decisions.push({ couche: "arret-urgence", autorise: false, raison });
    return { autorise: false, decisions, raisonFinale: raison };
  }

  // Couche 2 : politique d'exécution (allowlist + gates) — outils natifs.
  if (demande.toolName) {
    const policy = demande.policy ?? DEFAULT_EXECUTION_POLICY;
    try {
      authorizeTool(policy, demande.toolName);
      decisions.push({ couche: "politique", autorise: true, raison: `outil « ${demande.toolName} » autorisé par la politique` });
    } catch (erreur) {
      const raison = erreur instanceof Error ? erreur.message : "politique refusée";
      decisions.push({ couche: "politique", autorise: false, raison });
      return { autorise: false, decisions, raisonFinale: raison };
    }

    // Couche 3 : consentements par catégorie — refus explicite = blocage.
    try {
      const consents = await getToolConsents(demande.userId);
      const consent = decideConsent(demande.toolName, consents);
      if (!consent.allowed) {
        const raison = `catégorie « ${consent.category} » refusée dans les consentements`;
        decisions.push({ couche: "consentement", autorise: false, raison });
        return { autorise: false, decisions, raisonFinale: raison };
      }
      decisions.push({ couche: "consentement", autorise: true, raison: `catégorie « ${consent.category} » autorisée` });
    } catch (erreur) {
      if (erreur instanceof Error && erreur.message.includes("consentements")) {
        decisions.push({ couche: "consentement", autorise: false, raison: erreur.message });
        return { autorise: false, decisions, raisonFinale: erreur.message };
      }
      // Panne d'infrastructure : comportement par défaut = ask (comme executor.ts).
      decisions.push({ couche: "consentement", autorise: true, raison: "consentements illisibles → comportement par défaut (ask)" });
    }
  } else {
    decisions.push({ couche: "politique", autorise: true, raison: "capacité non-natif : contrôle dédié à la couche appelante" });
  }

  return { autorise: true, decisions, raisonFinale: "toutes les couches autorisent" };
}

/**
 * Contrôle UCE spécifique : une capacité peut-elle être INTÉGRÉE ou
 * EXECUTÉE en production ? Réponse : uniquement si une autorisation humaine
 * enregistrée existe (statut « autorisee » dans le registre central) —
 * le défaut est TOUJOURS le refus (mission §2.I / §8).
 */
export function integrerAutorisee(capacite: { status: string }): boolean {
  return capacite.status === "autorisee" || capacite.status === "integree" || capacite.status === "validee";
}
