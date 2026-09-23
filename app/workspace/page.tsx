import { redirect } from "next/navigation";

/**
 * /workspace — centre de gravité de l'application : conversations
 * persistantes avec exécution d'agents. La racine ouvre directement
 * l'espace conversationnel (liste gauche + écran d'accueil central).
 */
export default function WorkspacePage() {
  redirect("/workspace/conversations");
}
