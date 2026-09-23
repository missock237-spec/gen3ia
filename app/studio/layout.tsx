import type { ReactNode } from "react";

import { WorkspaceShell } from "@/components/shells/workspace-shell";

/**
 * Shell de l'espace utilisateur (/studio/*) — architecture à 3 espaces.
 * WorkspaceShell affiche la navigation primaire (Missions, Créer, Résultats,
 * Connexions, Équipe) issue du NavRegistry unique, plus les outils du Studio.
 * Industrialise le fond crème, le conteneur max-w-7xl et les marges.
 */
export default function StudioLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full bg-[#f6f4ef] text-neutral-900">
      <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-8">
        <WorkspaceShell />
        {children}
      </div>
    </div>
  );
}
