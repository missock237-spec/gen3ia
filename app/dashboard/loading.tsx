import { CardGridSkeleton, PageHeaderSkeleton } from "@/components/workspace/skeletons";

export default function Loading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <div className="space-y-6">
        <div className="h-32 animate-pulse rounded-2xl bg-[var(--g3-elevated)]/60" aria-busy="true" aria-label="Chargement du tableau de bord" />
        <CardGridSkeleton cards={4} />
      </div>
    </div>
  );
}
