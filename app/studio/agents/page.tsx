"use client";

import { useEffect, useState } from "react";

import { AgentChatWorkshop } from "@/components/agent/agent-chat-workshop";

/**
 * /studio/agents — CHAT D'AGENT IA « GEN IA » PLEIN ÉCRAN (demande
 * utilisateur : la création d'agents est supprimée). L'utilisateur donne
 * n'importe quel prompt, Gen IA — agent IA universel provisionné
 * automatiquement — résout le problème de bout en bout. L'historique des
 * chats est disponible dans le rail latéral (ouvertures, suppressions).
 * Sur mobile et tablette le chat est bord à bord ; l'identité de l'agent
 * est portée par le rail (logo Gen3ia + « Gen IA »).
 */
export default function AgentsPage() {
  const [task, setTask] = useState("");
  const [hydrated, setHydrated] = useState(false);

  // Lecture des paramètres d'URL après montage (évite la suspension
  // useSearchParams et le double-montage du panneau).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setTask(params.get("task") ?? "");
    setHydrated(true);
  }, []);

  return (
    <div className="h-full min-h-0 p-0 lg:p-3">
      {hydrated && <AgentChatWorkshop initialMessage={task} />}
    </div>
  );
}
