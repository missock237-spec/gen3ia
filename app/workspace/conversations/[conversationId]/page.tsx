import type { Metadata } from "next";

import { ConversationWorkspace } from "@/components/workspace/conversation-workspace";

export const metadata: Metadata = { title: "Conversation — Gen3ia" };

/**
 * Conversation complète : fil de messages, timeline d'exécution repliable,
 * validations inline et livrables standardisés. L'espace est repris
 * exactement là où il s'est arrêté (conversations persistantes).
 */
export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  return <ConversationWorkspace conversationId={conversationId} />;
}
