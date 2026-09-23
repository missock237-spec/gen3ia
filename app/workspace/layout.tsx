import type { ReactNode } from "react";

import { WorkspaceShell } from "@/components/shells/workspace-shell";

/**
 * Shell de l'espace Conversation-first (/workspace/*).
 * Navigation primaire : Conversations · Projets · Fichiers · Connecteurs ·
 * Bibliothèque (issue du NavRegistry unique). Les modules métier ne sont
 * plus des destinations de navigation : ce sont des capacités proposées
 * dans les conversations et la Bibliothèque.
 */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full bg-[#f6f4ef] text-neutral-900">
      <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-8">
        <WorkspaceShell />
        {children}
      </div>
    </div>
  );
}
