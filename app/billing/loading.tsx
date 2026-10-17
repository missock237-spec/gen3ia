import { PageHeaderSkeleton } from "@/components/workspace/skeletons";

export default function Loading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <div className="space-y-6">
        <div className="mx-auto h-44 max-w-xl animate-pulse rounded-2xl bg-[var(--g3-elevated)]/60" aria-busy="true" aria-label="Chargement" />
      </div>
    </div>
  );
}
