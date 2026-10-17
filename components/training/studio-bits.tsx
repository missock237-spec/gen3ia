"use client";

import type { ReactNode } from "react";

/* ------------------------------------------------------------------ */
/* AI Training Studio — briques UI partagées (thème AURORA OS)          */
/* ------------------------------------------------------------------ */

export function Chip({
  variant = "neutral",
  children,
}: {
  variant?: "valid" | "warn" | "error" | "neutral" | "primary";
  children: ReactNode;
}) {
  return (
    <span className="ts-chip" data-variant={variant}>
      {children}
    </span>
  );
}

const STATUS_LABELS: Record<string, { label: string; variant: "valid" | "warn" | "error" | "neutral" | "primary" }> = {
  pending: { label: "En attente", variant: "neutral" },
  valid: { label: "Validé", variant: "valid" },
  quarantined: { label: "Quarantaine", variant: "warn" },
  rejected: { label: "Refusé", variant: "error" },
  queued: { label: "En file", variant: "neutral" },
  scheduled: { label: "Planifié", variant: "primary" },
  running: { label: "En cours", variant: "primary" },
  completed: { label: "Terminé", variant: "valid" },
  failed: { label: "Échec", variant: "error" },
  cancelled: { label: "Annulé", variant: "neutral" },
  proposed: { label: "Proposé", variant: "primary" },
  accepted: { label: "Accepté", variant: "valid" },
  superseded: { label: "Remplacé", variant: "neutral" },
};

export function StatusChip({ status }: { status: string }) {
  const entry = STATUS_LABELS[status] ?? { label: status, variant: "neutral" as const };
  return <Chip variant={entry.variant}>{entry.label}</Chip>;
}

export function FindingsList({ findings }: { findings: Array<{ level: string; code: string; message: string }> }) {
  if (findings.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {findings.map((finding, index) => (
        <li
          key={`${finding.code}-${index}`}
          className="flex items-start gap-2 text-xs leading-5 text-[var(--g3-muted)]"
        >
          <span aria-hidden="true" className="mt-0.5 shrink-0">
            {finding.level === "error" ? "✕" : finding.level === "warn" ? "!" : "·"}
          </span>
          <span>{finding.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function ProgressBar({ percent }: { percent: number | null | undefined }) {
  const value = typeof percent === "number" ? Math.max(0, Math.min(100, Math.round(percent))) : null;
  return (
    <div className="ts-progress" role="progressbar" aria-valuenow={value ?? undefined} aria-valuemin={0} aria-valuemax={100}>
      <div className="ts-progress-bar" style={{ width: `${value ?? 0}%` }} />
    </div>
  );
}

export function LogViewer({ events }: { events: Array<{ at: string; level: string; message: string }> }) {
  if (events.length === 0) {
    return <p className="text-xs text-[var(--g3-faint)]">Aucun événement enregistré pour l&apos;instant.</p>;
  }
  const ordered = [...events].reverse();
  return (
    <div className="ts-log" role="log" aria-label="Journal de la tâche">
      {ordered.map((event, index) => (
        <div key={`${event.at}-${index}`} className="ts-log-line" data-level={event.level}>
          <time>{event.at.slice(11, 19)}</time>
          <span>{event.message}</span>
        </div>
      ))}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-2xl border border-[var(--g3-danger-border)] bg-[var(--g3-danger-soft)] px-4 py-3 text-sm text-[var(--g3-danger-strong)]"
    >
      {message}
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 o";
  const units = ["o", "Ko", "Mo", "Go"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "—";
  if (minutes < 60) return `~${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest > 0 ? `~${hours} h ${rest} min` : `~${hours} h`;
}
