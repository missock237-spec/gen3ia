"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import { WorkspaceShell } from "@/components/shells/workspace-shell";
import { isImmersiveChatRoute } from "@/lib/ui/chat-surface";

/**
 * Shell de l'espace Conversation-first (/workspace/*).
 * Navigation primaire : Conversations · Projets · Fichiers · Connecteurs ·
 * Bibliothèque (issue du NavRegistry unique). Les modules métier ne sont
 * plus des destinations de navigation : ce sont des capacités proposées
 * dans les conversations et la Bibliothèque.
 *
 * Mode immersif (routes de chat) : sur les surfaces de conversation,
 * l'interface de discussion occupe TOUTE la surface de l'appareil — les
 * barres de navigation et les marges disparaissent, le fil défile
 * en interne et le composer reste collé en bas.
 */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (isImmersiveChatRoute(pathname)) {
    return <div className="h-full min-h-0 bg-[var(--g3-bg)] text-[var(--g3-text)]">{children}</div>;
  }

  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-8">
        <WorkspaceShell />
        {children}
      </div>
    </div>
  );
}
