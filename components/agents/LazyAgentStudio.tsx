"use client";

import dynamic from "next/dynamic";

import { ConversationColumnsSkeleton } from "@/components/workspace/skeletons";

/**
 * ATELIER AGENT À CHARGEMENT DIFFÉRÉ (intentions du commit 6406a2d,
 * intégrées aux composants RÉELS du projet).
 *
 * Correctif d'intégration (Task 127) : le module d'origine importait des
 * composants inexistants (./AgentChat, ./LiveAgentPanel, ./MemoryGraph) et
 * `lucide-react` (non installé). Ici : chargement différé du VRAI composant
 * lourd de l'atelier — AgentChatWorkshop (components/agent/) — avec le
 * squelette standard du workspace.
 */

const AgentChatWorkshop = dynamic(
  () => import("@/components/agent/agent-chat-workshop").then((mod) => mod.AgentChatWorkshop),
  {
    loading: () => <ConversationColumnsSkeleton />,
    ssr: false,
  },
);

export function LazyAgentStudio({ initialMessage = "" }: { initialMessage?: string }) {
  return (
    <div className="space-y-4">
      <AgentChatWorkshop initialMessage={initialMessage} />
    </div>
  );
}
