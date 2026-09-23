import type { Metadata } from "next";

import { ConversationWorkspace } from "@/components/workspace/conversation-workspace";

export const metadata: Metadata = { title: "Conversations — Gen3ia" };

/**
 * Espace conversationnel PLEIN ÉCRAN : colonne gauche (conversations
 * récentes, projets, recherche), zone centrale (écran d'accueil « Que
 * voulez-vous accomplir ? » puis fil de discussion). L'interface de chat
 * occupe toute la hauteur de l'appareil : le fil défile en interne et le
 * composer reste collé en bas. Une conversation précise vit dans
 * /workspace/conversations/[conversationId].
 */
export default function ConversationsPage() {
  return <ConversationWorkspace />;
}
