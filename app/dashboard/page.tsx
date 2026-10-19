import type { Metadata } from "next";

import NovaChat from "@/components/chat/nova-chat";

export const metadata: Metadata = {
  title: "Dashboard — Chat IA Gen3ia",
  description:
    "Le dashboard EST le chat IA : prompt, fichiers, outils, effort et recherche web — Gen3ia pilote toute la plateforme en langage naturel.",
};

/**
 * /dashboard — LE DASHBOARD EST LE CHAT IA.
 *
 * Simplification demandée par l'utilisateur : plus de page d'accueil
 * intermédiaire — l'utilisateur arrive directement dans la conversation
 * avec Gen3ia. Le composer réunit les 5 commandes : envoi du prompt,
 * import de fichiers, outils (plugins), sélection d'effort et recherche
 * web. Toutes les fonctionnalités d'agents IA passent sous la commande de
 * l'IA (langage naturel → exécution réelle) ; l'IA écrit sa réponse
 * progressivement, mot à mot.
 *
 * Route autonome plein écran : l'interface embarque sa propre sidebar
 * d'historique — aucune navigation projet autour.
 */
export default function DashboardPage() {
  return <NovaChat />;
}
