"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { AgentManager } from "@/components/agent/agent-manager";
import { UniversalAgentChat } from "@/components/agent/universal-agent-chat";
import { AnimatedTabs } from "@/components/ui/animated-tabs";
import { WorkspaceTaskPanel } from "@/components/agent/workspace-task-panel";
import { AdsWorkshop } from "@/components/studio/ads-workshop";
import { StudioHeader } from "@/components/studio/studio-header";

type StudioTab = "agents" | "ads";

function isStudioTab(value: string | null): value is StudioTab {
  return value === "agents" || value === "ads";
}

/**
 * Page principale du Studio.
 * Architecture entreprise :
 *  - en-tête unifié via StudioHeader, navigation de section via le layout ;
 *  - onglet synchronisé avec l'URL (?tab=ads) — partageable et restaurable ;
 *  - les deux panneaux restent montés (hidden) : la conversation de l'agent
 *    et le formulaire Ads ne perdent plus leur état au changement d'onglet ;
 *  - AdsWorkshop extrait dans components/studio/ads-workshop.tsx.
 */
export default function StudioPage() {
  const [tab, setTab] = useState<StudioTab>("agents");
  const [task, setTask] = useState("");
  const [taskId, setTaskId] = useState("");
  const [hydrated, setHydrated] = useState(false);

  // Lecture des paramètres d'URL après montage (évite la suspension
  // useSearchParams et le double-montage du panneau agents).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlTab = params.get("tab");
    if (isStudioTab(urlTab)) setTab(urlTab);
    setTask(params.get("task") ?? "");
    setTaskId(params.get("taskId") ?? "");
    setHydrated(true);
  }, []);

  const switchTab = (key: string) => {
    const next = isStudioTab(key) ? key : "agents";
    setTab(next);
    const url = new URL(window.location.href);
    if (next === "ads") url.searchParams.set("tab", "ads");
    else url.searchParams.delete("tab");
    window.history.replaceState(null, "", url);
  };

  return (
    <div className="space-y-6">
      <StudioHeader
        eyebrow="GEN3IA AI STUDIO"
        title="Studio"
        highlight="d'agents IA"
        description="Créez un agent, personnalisez-le, exécutez-le immédiatement. Les agents de code accèdent en exclusivité à l'Atelier d'Interfaces propulsé par 21st.dev."
        actions={
          <>
            <Link href="/memory" className="g3-btn g3-btn-ghost text-xs">
              Mémoire
              <span className="rounded-md border border-emerald-200 bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-emerald-700">Nouveau</span>
            </Link>
            <Link href="/marketplace" className="g3-btn g3-btn-ghost text-xs">Marketplace</Link>
            <Link href="/live" className="g3-btn g3-btn-ghost text-xs">
              Agent Live
              <span className="rounded-md border border-amber-200 bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-amber-700">PC</span>
            </Link>
          </>
        }
      />

      <AnimatedTabs
        ariaLabel="Sections du studio"
        active={tab}
        onChange={switchTab}
        tabs={[
          { key: "agents", label: "🤖 Mes agents" },
          { key: "ads", label: "📣 Studio Ads" },
        ]}
      />

      {/* Panneaux maintenus montés pour préserver l'état entre les onglets. */}
      <div role="tabpanel" aria-label="Mes agents" hidden={tab !== "agents"} className="space-y-6">
        {hydrated && (
          <>
            {taskId ? <WorkspaceTaskPanel taskId={taskId} /> : <AgentManager />}
            <UniversalAgentChat initialMessage={taskId ? "" : task} />
          </>
        )}
      </div>
      <div role="tabpanel" aria-label="Studio Ads" hidden={tab !== "ads"}>
        {hydrated && <AdsWorkshop />}
      </div>
    </div>
  );
}
