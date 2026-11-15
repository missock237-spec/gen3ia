import { ListSkeleton, PageHeaderSkeleton } from "@/components/workspace/skeletons";

export default function Loading() {
  return (
    <div>
      <PageHeaderSkeleton />
      {/* Silhouette des listes de l'espace développeur (projets, clés API,
          extensions) — couvre aussi les sous-sections héritant du loading
          du segment parent. */}
      <ListSkeleton rows={5} />
    </div>
  );
}
