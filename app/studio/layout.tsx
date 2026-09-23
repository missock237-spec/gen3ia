"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import { WorkspaceShell } from "@/components/shells/workspace-shell";
import { isImmersiveChatRoute } from "@/lib/ui/chat-surface";

/**
 * Shell de l'espace utilisateur (/studio/*) — architecture à 3 espaces.
 * WorkspaceShell affiche la navigation primaire (Missions, Créer, Résultats,
 * Connexions, Équipe) issue du NavRegistry unique, plus les outils du Studio.
 * Industrialise le fond crème, le conteneur max-w-7xl et les marges.
 *
 * Mode immersif (routes de chat) : sur le chat d'agent IA (/studio/agents),
 * l'interface de discussion occupe TOUTE la hauteur de l'appareil — les
 * barres de navigation et les marges disparaissent, le fil défile en
 * interne et le composer reste collé en bas.
 */
export default function StudioLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (isImmersiveChatRoute(pathname)) {
    return <div className="h-full min-h-0 bg-[var(--g3-bg)] text-neutral-900">{children}</div>;
  }

  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-neutral-900">
      <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-8">
        <WorkspaceShell />
        {children}
      </div>
    </div>
  );
}
