import type { Metadata } from "next";

import { ConversationWorkspace } from "@/components/workspace/conversation-workspace";
import { SectionHeader } from "@/components/shells/section-header";

export const metadata: Metadata = { title: "Conversations — Gen3ia" };

/**
 * Espace conversationnel : colonne gauche (conversations récentes, projets,
 * recherche), zone centrale (écran d'accueil : « Que voulez-vous accomplir ? »).
 * Une conversation précise vit dans /workspace/conversations/[conversationId].
 */
export default function ConversationsPage() {
  return (
    <div className="space-y-4">
      <SectionHeader
        eyebrow="ESPACE DE TRAVAIL"
        title="Conversations"
        description="Vos discussions persistent : reprenez exactement là où vous vous êtes arrêté. Chaque demande peut produire un plan, des outils exécutés avec validation et des livrables."
      />
      <ConversationWorkspace />
    </div>
  );
}
