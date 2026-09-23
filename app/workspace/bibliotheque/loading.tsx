import { CardGridSkeleton, PageHeaderSkeleton } from "@/components/workspace/skeletons";

export default function Loading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <CardGridSkeleton cards={6} />
    </div>
  );
}
