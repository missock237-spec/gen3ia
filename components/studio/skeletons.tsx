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
          <div className="h-5 w-2/5 animate-pulse rounded-lg bg-neutral-200/80" />
          <div className="h-3.5 w-3/4 animate-pulse rounded bg-neutral-100" />
          <div className="h-3.5 w-1/2 animate-pulse rounded bg-neutral-100" />
        </div>
        <div className="h-8 w-24 animate-pulse rounded-xl bg-neutral-100" />
      </div>
      <div className="mt-4 h-11 animate-pulse rounded-xl bg-neutral-100" />
      <div className="mt-3 h-9 animate-pulse rounded-xl bg-neutral-100" />
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

export function ScheduleCardSkeleton() {
  return (
    <div className="rounded-2xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 p-4" aria-hidden="true">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-4.5 w-1/2 animate-pulse rounded bg-neutral-200/80" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-neutral-200/60" />
        </div>
        <div className="h-6 w-16 animate-pulse rounded-full bg-neutral-200/60" />
      </div>
      <div className="mt-3 h-3.5 w-full animate-pulse rounded bg-neutral-200/50" />
      <div className="mt-2 h-3.5 w-2/3 animate-pulse rounded bg-neutral-200/50" />
      <div className="mt-4 flex gap-2">
        <div className="h-8 w-28 animate-pulse rounded-lg bg-white" />
        <div className="h-8 w-24 animate-pulse rounded-lg bg-white" />
        <div className="h-8 w-24 animate-pulse rounded-lg bg-white" />
      </div>
    </div>
  );
}

export function ResultCardSkeleton() {
  return (
    <div className="g3-card overflow-hidden" aria-hidden="true">
      <div className="aspect-video animate-pulse bg-neutral-100" />
      <div className="p-4">
        <div className="h-4 w-2/3 animate-pulse rounded bg-neutral-200/80" />
        <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-neutral-100" />
        <div className="mt-3 h-8 w-28 animate-pulse rounded-xl bg-neutral-100" />
      </div>
    </div>
  );
}
