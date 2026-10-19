import type { Metadata } from "next";

import ConsoleEssaim from "@/components/essaim/console-essaim";

/**
 * L'Essaim d'Agents Décentralisés.
 *
 * Page publique : chaque navigateur devient un nœud complet de l'essaim
 * — cinq mini-agents spécialisés connectés à l'IA principale Gen3,
 * RAG zéro-connaissance (coffre chiffré + onde sémantique), injection de
 * compétences par ondes exécutables, auto-réparation par résonance de
 * phase, passerelle vocale. Tout le calcul est local ou P2P : le
 * serveur ne fait que la signalisation.
 */
export const metadata: Metadata = {
  title: "Essaim d'agents décentralisés — chaque navigateur est un nœud | Gen3ia",
  description:
    "Cinq mini-agents spécialisés (veille, tri, calcul, code, automatisation) connectés à l'IA principale Gen3, RAG zéro-connaissance chiffré, injection de compétences par ondes exécutables, auto-réparation par résonance de phase et passerelle vocale — tout en WebRTC direct, zéro frais de cloud.",
};

export default function PageEssaim() {
  return <ConsoleEssaim />;
}
