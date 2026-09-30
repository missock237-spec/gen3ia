"use client";

/**
 * StatusBadge — étiquette de statut centralisée.
 * Toutes les listes (missions, clés API, extensions, connecteurs, modération)
 * utilisent ce même mapping statut → libellé + couleur, au lieu de dupliquer
 * des ternaires par page.
 */

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "progress";

export interface StatusDefinition {
  label: string;
  tone: BadgeTone;
}

/** Mapping centralisé des statuts métier Gen3ia (fr). */
const STATUS_DEFINITIONS: Record<string, StatusDefinition> = {
  // Missions / tâches workspace
  draft: { label: "Brouillon", tone: "neutral" },
  awaiting_approval: { label: "À valider", tone: "warning" },
  approved: { label: "Validée", tone: "info" },
  running: { label: "En cours", tone: "progress" },
  paused: { label: "En pause", tone: "warning" },
  completed: { label: "Terminée", tone: "success" },
  failed: { label: "Échec", tone: "danger" },
  cancelled: { label: "Annulée", tone: "neutral" },
  // Clés API / ressources développeur
  active: { label: "Active", tone: "success" },
  revoked: { label: "Révoquée", tone: "danger" },
  // Extensions
  published: { label: "Publiée", tone: "success" },
  pending_review: { label: "À revoir", tone: "warning" },
  rejected: { label: "Rejetée", tone: "danger" },
  // Connexions
  connected: { label: "Connecté", tone: "success" },
  disconnected: { label: "Déconnecté", tone: "neutral" },
  unauthorized: { label: "À re-connecter", tone: "warning" },
  error: { label: "Erreur", tone: "danger" },
  // Générique
  enabled: { label: "Activé", tone: "success" },
  disabled: { label: "Désactivé", tone: "neutral" },
  ok: { label: "Opérationnel", tone: "success" },
  degraded: { label: "Dégradé", tone: "warning" },
};

// Tokens sémantiques bithème (étape 4) : plus aucun pastel clair en dur —
// le badge suit le thème sombre ET clair sans couche de compatibilité.
const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "border-[var(--g3-border)] bg-[var(--g3-elevated)] text-[var(--g3-muted)]",
  info: "border-[var(--g3-primary-soft)] bg-[var(--g3-primary-soft)] text-[var(--g3-primary-strong)]",
  success: "border-[var(--g3-success-soft)] bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]",
  warning: "border-[var(--g3-warning-soft)] bg-[var(--g3-warning-soft)] text-[var(--g3-warning-strong)]",
  danger: "border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] text-[var(--g3-danger-strong)]",
  progress: "border-[var(--g3-primary-soft)] bg-[var(--g3-primary-soft)] text-[var(--g3-primary-strong)]",
};

/** Point animé pour les statuts « en cours » (signe de vie visible). */
function PulseDot() {
  return (
    <span className="relative inline-flex h-1.5 w-1.5">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--g3-primary-strong)] opacity-60" />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--g3-primary-strong)]" />
    </span>
  );
}

export function StatusBadge({
  status,
  label,
  className = "",
}: {
  /** Statut brut tel que renvoyé par l'API (ex. "awaiting_approval"). */
  status: string;
  /** Libellé surchargé (défaut : mapping centralisé, sinon le statut brut). */
  label?: string;
  className?: string;
}) {
  const definition = STATUS_DEFINITIONS[status] ?? { label: status, tone: "neutral" as BadgeTone };
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${TONE_CLASSES[definition.tone]} ${className}`}
      data-status={status}
    >
      {definition.tone === "progress" && <PulseDot />}
      {label ?? definition.label}
    </span>
  );
}

/** Renvoie le libellé fr d'un statut (pour les listes non-badges). */
export function statusLabel(status: string): string {
  return STATUS_DEFINITIONS[status]?.label ?? status;
}
