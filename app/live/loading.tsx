import { ListSkeleton, PageHeaderSkeleton } from "@/components/workspace/skeletons";

export default function Loading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <div className="space-y-6">
        {/* Silhouette du flux vidéo live (console réservée aux écrans larges) */}
        <div className="aspect-video w-full animate-pulse rounded-2xl bg-[var(--g3-elevated)]/60" aria-busy="true" aria-label="Chargement de la console live" />
        <ListSkeleton rows={3} />
      </div>
    </div>
  );
}
