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
    <div className="flex flex-col items-center justify-center rounded-[var(--g3-radius-lg)] border border-dashed border-[var(--g3-border-strong)] bg-[var(--g3-surface)] px-6 py-16 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] text-lg text-[var(--g3-muted)] shadow-[var(--g3-shadow-sm)]" aria-hidden="true">
        {icon}
      </div>
      <p className="mt-4 text-sm font-semibold text-[var(--g3-ink)]">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm leading-6 text-[var(--g3-muted)]">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = "Chargement…", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="space-y-3" role="status" aria-live="polite" aria-label={label}>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-4 rounded-[var(--g3-radius-lg)] border border-[var(--g3-border)] bg-[var(--g3-surface)] p-4">
          <div className="h-9 w-9 shrink-0 g3-skeleton rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3.5 w-1/3 g3-skeleton rounded-full" />
            <div className="h-3 w-2/3 g3-skeleton rounded-full" />
          </div>
          <div className="h-6 w-20 shrink-0 g3-skeleton rounded-full" />
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** petite carte de métrique partagée (developer + admin). */
export function MetricCard({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-[var(--g3-radius-lg)] border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5 shadow-[var(--g3-shadow-xs)] transition-shadow hover:shadow-[var(--g3-shadow-md)]">
      <div className="text-[13px] font-medium text-[var(--g3-muted)]">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-[-0.025em] text-[var(--g3-ink)]">{value}</div>
      {hint && <div className="mt-1 text-xs text-neutral-400">{hint}</div>}
    </div>
  );
}
