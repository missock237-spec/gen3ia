import { redirect } from "next/navigation";

/**
 * /workspace/connectors — Connecteurs de l'espace conversationnel.
 * La surface complète (hub Composio, état vérifié, permissions, services
 * natifs) vit dans /studio/connections : on y redirige directement pour
 * éviter toute duplication de logique.
 */
export default function WorkspaceConnectorsPage() {
  redirect("/studio/connections");
}
