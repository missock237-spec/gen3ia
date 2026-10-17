import type { Metadata } from "next";

import { AuroraChat } from "@/components/chat/aurora-chat";

export const metadata: Metadata = {
  title: "Chat — Gen3ia",
  description:
    "Conversation directe avec l'IA Gen3ia : historique, pièces jointes, modèles au choix et applications externes.",
};

/**
 * Chat Aurora — interface de conversation directe fournie par l'utilisateur,
 * adaptée aux couleurs Aurora OS du projet (identité 2 couleurs violet → cyan,
 * thèmes sombre/clair) et câblée au moteur conversationnel réel : streaming
 * NDJSON, mémoire serveur par utilisateur, pièces jointes R2 et connecteurs
 * d'applications externes (Composio).
 *
 * Route autonome plein écran : l'interface embarque sa propre sidebar
 * d'historique — aucune navigation projet autour (voir AppShell).
 */
export default function ChatPage() {
  return <AuroraChat />;
}
