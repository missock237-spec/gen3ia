import { ListSkeleton, PageHeaderSkeleton } from "@/components/workspace/skeletons";

export default function Loading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <div className="space-y-6">
        <section className="space-y-3">
          <div className="h-4 w-44 animate-pulse rounded bg-neutral-200/60" />
          <ListSkeleton rows={3} />
        </section>
        <section className="space-y-3">
          <div className="h-4 w-40 animate-pulse rounded bg-neutral-200/60" />
          <ListSkeleton rows={4} />
        </section>
      </div>
    </div>
  );
}
