"use client";

/**
 * États homogènes (vide / chargement) partagés par les 3 espaces.
 * Avant : chaque page avait son propre <div border-dashed> ou spinner.
 */

export function EmptyState({
  icon = "◌",
  title,
  description,
  action,
}: {
  icon?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-[rgba(23,23,20,0.14)] bg-[var(--g3-surface)]/60 px-6 py-14 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-[var(--g3-elevated)] text-xl text-[var(--g3-faint)]" aria-hidden="true">
        {icon}
      </div>
      <p className="mt-4 font-serif text-base font-semibold text-[var(--g3-text)]">{title}</p>
      {description && <p className="mt-1.5 max-w-sm text-sm leading-6 text-[var(--g3-muted)]">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = "Chargement…", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="space-y-3" role="status" aria-live="polite" aria-label={label}>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-4 rounded-2xl border border-[rgba(23,23,20,0.07)] bg-[var(--g3-surface)] p-4">
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-xl bg-[var(--g3-elevated)]" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3.5 w-1/3 animate-pulse rounded-full bg-[var(--g3-elevated)]" />
            <div className="h-3 w-2/3 animate-pulse rounded-full bg-[var(--g3-elevated)]" />
          </div>
          <div className="h-6 w-20 shrink-0 animate-pulse rounded-full bg-[var(--g3-elevated)]" />
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** petite carte de métrique partagée (developer + admin). */
export function MetricCard({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-5 shadow-[0_10px_30px_-20px_rgba(28,27,24,0.25)]">
      <div className="text-xs font-medium uppercase tracking-[.14em] text-[var(--g3-faint)]">{label}</div>
      <div className="mt-2 text-2xl font-bold tracking-tight text-[var(--g3-text)]">{value}</div>
      {hint && <div className="mt-1 text-xs text-[var(--g3-faint)]">{hint}</div>}
    </div>
  );
}
