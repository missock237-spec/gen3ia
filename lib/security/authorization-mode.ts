/**
 * Mode d'autorisation des agents (Human-in-the-Loop) — sélecteur
 * « Toujours demander ▼ » du composer unifié.
 *
 * Ce module est partagé client + serveur :
 *  - le composer (client) affiche le sélecteur et envoie le mode choisi ;
 *  - /api/agent/chat (serveur) applique le mode au flux d'approbations.
 *
 * Plancher de sécurité INVARIABLE, quel que soit le mode : les outils
 * critiques (publicité payante, suppression de fichiers, appels téléphoniques)
 * exigent TOUJOURS une confirmation humaine explicite. Le mode « auto »
 * n'est jamais un blanc-seing global.
 */

export type AuthorizationMode = "always_ask" | "ask_if_needed" | "auto_allow";

export const AUTHORIZATION_MODES: Array<{
  id: AuthorizationMode;
  label: string;
  description: string;
}> = [
  {
    id: "always_ask",
    label: "Toujours demander",
    description: "L'agent demande votre confirmation avant chaque action sensible.",
  },
  {
    id: "ask_if_needed",
    label: "Demander si nécessaire",
    description: "L'agent ne vous consulte que lorsqu'une action l'exige vraiment.",
  },
  {
    id: "auto_allow",
    label: "Autoriser automatiquement",
    description: "L'agent exécute directement les actions autorisées. Les actions critiques restent confirmées par vous.",
  },
];

export const DEFAULT_AUTHORIZATION_MODE: AuthorizationMode = "always_ask";

export function isAuthorizationMode(value: unknown): value is AuthorizationMode {
  return value === "always_ask" || value === "ask_if_needed" || value === "auto_allow";
}

/** Outils JAMAIS auto-approuvés, même en mode « Autoriser automatiquement ». */
export const NEVER_AUTO_APPROVE_TOOLS: ReadonlySet<string> = new Set([
  "ads.publish",
  "file.delete",
  "phone.call",
]);

export function isNeverAutoApprove(toolSlug: string): boolean {
  return NEVER_AUTO_APPROVE_TOOLS.has(toolSlug);
}

export function authorizationModeLabel(mode: AuthorizationMode): string {
  return AUTHORIZATION_MODES.find((item) => item.id === mode)?.label ?? "Toujours demander";
}

/** Clé de persistance locale (préférence conservée entre les visites). */
export const AUTHORIZATION_MODE_STORAGE_KEY = "g3.authorizationMode";

/** Message d'audit tracé quand une approbation est accordée automatiquement. */
export const AUTO_APPROVAL_AUDIT_REASON = "Approuvé automatiquement — mode d'autorisation choisi par l'utilisateur (auto_allow).";

/**
 * Décide si une étape sensible peut s'exécuter SANS approbation humaine
 * (mode « Autoriser automatiquement » uniquement). Plancher de sécurité
 * INVARIABLE :  - les outils critiques listés (publicité payante, suppression
 * de fichiers, appels téléphoniques) exigent toujours une confirmation ;
 *  - un risque « critical » n'est jamais contourné par le mode auto.
 * Partagé par /api/agent/chat et le moteur conversationnel (workspace).
 */
export function isAutoApprovable(mode: AuthorizationMode | undefined, toolName: string, risk: string): boolean {
  if (mode !== "auto_allow") return false;
  if (risk === "critical") return false;
  return !isNeverAutoApprove(toolName);
}
