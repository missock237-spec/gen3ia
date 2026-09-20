import type { ReactNode } from "react";

import { StudioSectionNav } from "@/components/studio/studio-section-nav";

/**
 * Shell commun de toutes les pages Studio (/studio, /studio/interface-lab,
 * /studio/schedules). Industrialise le fond crème, le conteneur max-w-7xl,
 * les marges et la navigation de section — auparavant dupliqués par page
 * avec des largeurs incohérentes (7xl / 6xl / 2xl).
 */
export default function StudioLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full bg-[#f6f4ef] text-neutral-900">
      <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-8">
        <StudioSectionNav />
        {children}
      </div>
    </div>
  );
}
