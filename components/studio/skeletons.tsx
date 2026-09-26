"use client";

/**
 * Skeletons de chargement du Studio.
 * Remplacent les anciens indicateurs « Chargement… » par des
 * placeholders structurels (perception de performance).
 */

export function AgentCardSkeleton() {
  return (
    <div className="g3-card p-5" aria-hidden="true">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-5 w-2/5 animate-pulse rounded-lg bg-[var(--g3-elevated)]/80" />
          <div className="h-3.5 w-3/4 animate-pulse rounded bg-[var(--g3-elevated)]" />
          <div className="h-3.5 w-1/2 animate-pulse rounded bg-[var(--g3-elevated)]" />
        </div>
        <div className="h-8 w-24 animate-pulse rounded-xl bg-[var(--g3-elevated)]" />
      </div>
      <div className="mt-4 h-11 animate-pulse rounded-xl bg-[var(--g3-elevated)]" />
      <div className="mt-3 h-9 animate-pulse rounded-xl bg-[var(--g3-elevated)]" />
    </div>
  );
}

export function AgentGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2" role="status" aria-label="Chargement de vos agents">
      {Array.from({ length: count }, (_, index) => (
        <AgentCardSkeleton key={index} />
      ))}
    </div>
  );
}
export function ResultCardSkeleton() {
  return (
    <div className="g3-card overflow-hidden" aria-hidden="true">
      <div className="aspect-video animate-pulse bg-[var(--g3-elevated)]" />
      <div className="p-4">
        <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--g3-elevated)]/80" />
        <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-[var(--g3-elevated)]" />
        <div className="mt-3 h-8 w-28 animate-pulse rounded-xl bg-[var(--g3-elevated)]" />
      </div>
    </div>
  );
}
