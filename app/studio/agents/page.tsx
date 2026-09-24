"use client";

import { useEffect, useState } from "react";

import { AgentChatWorkshop } from "@/components/agent/agent-chat-workshop";

/**
 * /studio/agents — chat agent-scopé PLEIN ÉCRAN : l'interface de discussion
 * occupe TOUTE la surface de l'appareil (rail des agents à gauche, fil +
 * composer à droite). Sur mobile et tablette le chat est bord à bord (aucune
 * marge extérieure, pas d'arrondi) ; sur grand écran un cadre léger est
 * conservé. La personnalisation (assistant obligatoire avant toute
 * exécution) s'affiche dans la même surface, en défilement normal.
 * L'identité de l'agent est portée par l'en-tête du panneau de chat.
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
