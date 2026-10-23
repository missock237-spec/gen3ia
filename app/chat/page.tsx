import type { Metadata } from "next";

import NovaChat from "@/components/chat/nova-chat";

export const metadata: Metadata = {
  title: "Chat — Gen3ia",
  description:
    "Conversation directe avec l'IA Gen3ia : historique, pièces jointes, outils, effort de réflexion et recherche web.",
};

/**
 * Chat IA — route principale de conversation, servie par l'interface
 * canonique NovaChat (Task C — consolidation chat unique).
 *
 * Le projet avait TROIS interfaces de chat concurrentes (/chat + aurora,
 * /chat-v4, dashboard + nova) : chaque bug était corrigé trois fois.
 * L'expérience retenue est NovaChat — la plus récente (créée le 2026-10-19,
 * « le dashboard EST le chat IA »), la plus complète (composer 5 commandes :
 * envoi/arrêt, import de fichiers, outils Composio, effort de réflexion,
 * recherche web — agents pilotés par l'IA, écriture progressive, carte
 * d'auto-apprentissage, voix) et celle vers laquelle la navigation du shell
 * pointe (« Chat IA » → /dashboard, verrous structurels nova-dashboard.test).
 *
 * /chat et /dashboard rendent donc le MÊME composant — une seule
 * implémentation à maintenir. Les anciennes routes /chat-v4 (supprimée) et
 * /chat Aurora (supprimée) redirigent vers ici (voir next.config.ts).
 *
 * Route autonome plein écran : l'interface embarque sa propre sidebar
 * d'historique — aucune navigation projet autour (voir AppShell,
 * isStandaloneChat + isImmersiveChatRoute).
 */
export default function ChatPage() {
  return <NovaChat />;
}
