import type { ApprovalStatus, RunStatus, RunStepStatus } from "@/lib/domain/conversations/types";

/**
 * Libellés et styles centralisés des statuts du workspace conversationnel.
 * Complète StatusBadge (shells) avec les statuts spécifiques aux
 * conversations, runs et validations.
 */

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  planning: "Planification",
  awaiting_approval: "Validation requise",
  running: "En cours",
  completed: "Terminé",
  failed: "Échec",
  cancelled: "Annulé",
};

export const RUN_STATUS_STYLES: Record<RunStatus, string> = {
  planning: "bg-[var(--g3-elevated)] text-[var(--g3-text-secondary)] border-[var(--g3-border)]",
  awaiting_approval: "bg-amber-50 text-amber-800 border-amber-200",
  running: "bg-sky-50 text-sky-800 border-sky-200",
  completed: "bg-emerald-50 text-emerald-800 border-emerald-200",
  failed: "bg-red-50 text-red-800 border-red-200",
  cancelled: "bg-[var(--g3-elevated)] text-[var(--g3-muted)] border-[var(--g3-border)]",
};

export const STEP_STATUS_LABELS: Record<RunStepStatus, string> = {
  pending: "À faire",
  in_progress: "En cours",
  done: "Fait",
  failed: "Échec",
  skipped: "Ignoré",
  awaiting: "En attente de validation",
};

export const STEP_STATUS_MARKS: Record<RunStepStatus, string> = {
  pending: "·",
  in_progress: "◐",
  done: "✓",
  failed: "✕",
  skipped: "⤼",
  awaiting: "⏸",
};

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: "En attente de décision",
  approved: "Approuvée",
  rejected: "Rejetée",
  expired: "Expirée (non décidée à temps)",
};

export const APPROVAL_STATUS_STYLES: Record<ApprovalStatus, string> = {
  pending: "bg-amber-50 text-amber-800 border-amber-200",
  approved: "bg-emerald-50 text-emerald-800 border-emerald-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
  expired: "bg-[var(--g3-elevated)] text-[var(--g3-muted)] border-[var(--g3-border)]",
};

export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `il y a ${days} j`;
  return new Date(then).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

export const ARTIFACT_TYPE_LABELS: Record<string, string> = {
  code: "Code",
  document: "Document",
  table: "Tableau",
  image: "Image",
  report: "Rapport",
  file: "Fichier",
};

export const ARTIFACT_TYPE_ICONS: Record<string, string> = {
  code: "{}",
  document: "≡",
  table: "⊞",
  image: "▣",
  report: "▤",
  file: "□",
};
