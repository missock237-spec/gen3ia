import { PageHeaderSkeleton } from "@/components/workspace/skeletons";
import { AgentGridSkeleton } from "@/components/studio/skeletons";

export default function Loading() {
  return (
    <div>
      <PageHeaderSkeleton />
      {/* Silhouette de la grille d'agents du Studio (couvre aussi les
          sous-sections qui héritent du loading du segment parent). */}
      <AgentGridSkeleton count={6} />
    </div>
  );
}
