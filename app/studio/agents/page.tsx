"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { AgentChatWorkshop } from "@/components/agent/agent-chat-workshop";
import { SectionHeader } from "@/components/shells/section-header";

/**
 * /studio/agents — personnalisation des agents (nom, compétences, mémoire,
 * nature, type) puis chat agent-scopé. La page /studio est désormais le hub
 * « Missions » ; le chat agent reste une surface transverse de l'espace.
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
    <div className="space-y-6">
      <SectionHeader
        eyebrow="ESPACE DE TRAVAIL / AGENTS"
        title="Agents"
        highlight="& chat"
        description="Personnalisez votre agent IA (nom, compétences, mémoire, type), puis dialoguez : il répond ou exécute, sans jamais sortir de son périmètre. Les agents de code accèdent en exclusivité à l'Atelier d'Interfaces propulsé par 21st.dev."
        action={
          <Link href="/studio" className="g3-btn g3-btn-ghost text-xs">
            ← Missions
          </Link>
        }
      />
      {hydrated && <AgentChatWorkshop initialMessage={task} />}
    </div>
  );
}
