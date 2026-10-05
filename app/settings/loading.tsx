import { ListSkeleton, PageHeaderSkeleton } from "@/components/workspace/skeletons";

export default function Loading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <ListSkeleton rows={5} />
    </div>
  );
}
