"use client";

import * as React from "react";

import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";
import { AgentWizard } from "@/components/agent/agent-wizard";
import { AgentChatPanel } from "@/components/agent/agent-chat-panel";
import { VoiceAgentSetup } from "@/components/agent/voice-agent-setup";
import { Callout } from "@/components/studio/callout";
import { AgentGridSkeleton } from "@/components/studio/skeletons";
import { labelForAgent } from "@/lib/agents/charter";
import type { AgentSummary } from "@/lib/agents/schema";

/**
 * Atelier de chat d'agents IA personnalisés (Studio Gen3ia).
 * Remplace l'ancien couple « formulaire de création » + « chat universel » :
 *  - rail latéral : liste des agents, création, sélection, suppression ;
 *  - assistant de personnalisation OBLIGATOIRE avant toute exécution
 *    (nom, description, compétences, mémoire, nature, type + type libre) ;
 *  - chat agent-scopé : réponses professionnelles, classification des
 *    requêtes (réponse simple ou exécution), périmètre strict.
 */

function AgentAvatar({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "A";
  return <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-violet-200 bg-gradient-to-br from-violet-100 to-sky-100 font-serif text-sm font-bold text-violet-700">{initial}</span>;
}

export function AgentChatWorkshop({ initialMessage = "" }: { initialMessage?: string }) {
  const sessionDisponible = useSessionAvailable();
  const [agents, setAgents] = React.useState<AgentSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [view, setView] = React.useState<"chat" | "wizard">("chat");
  const [editing, setEditing] = React.useState<AgentSummary | null>(null);
  const [voiceSetupAgentId, setVoiceSetupAgentId] = React.useState<string | null>(null);
  const [showRailMobile, setShowRailMobile] = React.useState(false);
  const [error, setError] = React.useState("");

  const refresh = React.useCallback(async () => {
    try {
      const response = await authFetch("/api/agents", { cache: "no-store" });
      if (response.ok) {
        const data = await response.json();
        setAgents((data.agents ?? []) as AgentSummary[]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void refresh(); }, [refresh]);

  const activeAgent = agents.find((agent) => agent.id === activeId) ?? null;

  // Pas encore d'agent : l'assistant de personnalisation s'ouvre d'office.
  React.useEffect(() => {
    if (!loading && agents.length === 0) setView("wizard");
    if (!loading && agents.length > 0 && !activeId) setActiveId(agents[0].id);
  }, [loading, agents, activeId]);

  async function deleteAgent(agent: AgentSummary) {
    if (!window.confirm(`Supprimer définitivement l'agent « ${agent.name} » ?`)) return;
    const response = await authFetch(`/api/agents/${agent.id}`, { method: "DELETE" });
    if (response.ok) {
      setAgents((current) => current.filter((item) => item.id !== agent.id));
      if (agent.id === activeId) setActiveId(null);
    } else {
      setError("Suppression impossible.");
    }
  }

  function handleSaved(agent: AgentSummary) {
    setAgents((current) => {
      const exists = current.some((item) => item.id === agent.id);
      return exists ? current.map((item) => (item.id === agent.id ? agent : item)) : [agent, ...current];
    });
    setActiveId(agent.id);
    setView("chat");
    setEditing(null);
    setShowRailMobile(false);
    if (agent.agentMode === "call" && !editing) setVoiceSetupAgentId(agent.id);
  }

  const rail = (
    <aside className="rounded-[26px] border border-[rgba(23,23,20,0.09)] bg-white p-4 shadow-[0_14px_40px_-18px_rgba(28,27,24,0.18)]" aria-label="Mes agents IA">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-black uppercase tracking-[.24em] text-neutral-500">Mes agents</h2>
        <span className="rounded-full border border-[rgba(23,23,20,0.09)] bg-neutral-50 px-2 py-0.5 text-[10px] font-bold text-neutral-500">{agents.length}</span>
      </div>

      <button
        type="button"
        className="g3-btn g3-btn-primary mt-3 w-full text-xs"
        onClick={() => { setEditing(null); setView("wizard"); setShowRailMobile(false); }}
      >
        + Nouvel agent personnalisé
      </button>

      <div className="mt-3 max-h-[420px] space-y-2 overflow-y-auto pr-0.5">
        {loading ? (
          <AgentGridSkeleton count={2} />
        ) : agents.length === 0 ? (
          <p className="rounded-xl bg-neutral-50 px-3 py-4 text-center text-xs leading-5 text-neutral-400">Aucun agent pour l&apos;instant. Personnalisez le premier : cela prend moins d&apos;une minute.</p>
        ) : (
          agents.map((agent) => {
            const selected = agent.id === activeId && view === "chat";
            return (
              <div key={agent.id} className={`group relative rounded-2xl border p-3 transition ${selected ? "border-neutral-900 bg-neutral-50 shadow-[0_8px_24px_-12px_rgba(28,27,24,0.35)]" : "border-[rgba(23,23,20,0.09)] bg-white hover:border-neutral-300"}`}>
                <button
                  type="button"
                  onClick={() => { setActiveId(agent.id); setView("chat"); setShowRailMobile(false); }}
                  className="flex w-full items-start gap-2.5 text-left"
                  aria-pressed={selected}
                >
                  <AgentAvatar name={agent.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-neutral-900">{agent.name}</span>
                    <span className="mt-0.5 block truncate text-[10px] font-semibold uppercase tracking-wide text-violet-600">{labelForAgent(agent)}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1 text-[9px] text-neutral-400">
                      <span className="rounded border border-[rgba(23,23,20,0.09)] px-1 py-0.5">{agent.agentMode === "call" ? "Appel" : "Standard"}</span>
                      <span className="rounded border border-[rgba(23,23,20,0.09)] px-1 py-0.5">{agent.skills.length} compétence{agent.skills.length > 1 ? "s" : ""}</span>
                      {agent.memoryFile && <span className="rounded border border-emerald-200 bg-emerald-50 px-1 py-0.5 text-emerald-600">Mémoire</span>}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void deleteAgent(agent)}
                  aria-label={`Supprimer ${agent.name}`}
                  className="absolute right-2 top-2 hidden rounded-lg border border-[rgba(23,23,20,0.09)] bg-white px-1.5 py-1 text-[9px] text-neutral-400 transition hover:border-red-200 hover:text-red-600 group-hover:block"
                >
                  Suppr.
                </button>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );

  return (
    <div className="space-y-5">
      {sessionDisponible === false && <Callout tone="warning" className="rounded-2xl">Session expirée — reconnectez-vous pour discuter avec vos agents.</Callout>}
      {error && <Callout tone="error" className="rounded-2xl">{error}</Callout>}

      {/* Sélecteur mobile : le rail se replie sous lg */}
      <button
        type="button"
        onClick={() => setShowRailMobile((current) => !current)}
        aria-expanded={showRailMobile}
        className="flex w-full items-center justify-between rounded-2xl border border-[rgba(23,23,20,0.09)] bg-white px-4 py-3 text-sm lg:hidden"
      >
        <span className="flex items-center gap-2">
          {activeAgent ? (
            <>
              <AgentAvatar name={activeAgent.name} />
              <span className="font-bold">{activeAgent.name}</span>
              <span className="text-xs text-violet-600">{labelForAgent(activeAgent)}</span>
            </>
          ) : (
            <span className="text-neutral-500">Mes agents IA</span>
          )}
        </span>
        <span className="text-xs text-neutral-400">{showRailMobile ? "Fermer" : "Changer d'agent"}</span>
      </button>
      {showRailMobile && <div className="lg:hidden">{rail}</div>}

      <div className="grid gap-5 lg:grid-cols-[290px_minmax(0,1fr)]">
        <div className="hidden lg:block">{rail}</div>

        <div className="min-w-0">
          {loading ? (
            <div className="g3-card p-10"><AgentGridSkeleton count={2} /></div>
          ) : view === "wizard" || !activeAgent ? (
            <AgentWizard
              editing={editing}
              onSaved={handleSaved}
              onCancel={() => {
                setEditing(null);
                if (activeAgent) setView("chat");
                else if (agents.length > 0) { setActiveId(agents[0].id); setView("chat"); }
              }}
            />
          ) : (
            <AgentChatPanel
              agent={activeAgent}
              onEdit={() => { setEditing(activeAgent); setView("wizard"); }}
              onAgentsChanged={() => void refresh()}
              initialMessage={initialMessage}
            />
          )}
        </div>
      </div>

      {voiceSetupAgentId && (
        <VoiceAgentSetup agentId={voiceSetupAgentId} onDone={() => { setVoiceSetupAgentId(null); void refresh(); }} />
      )}
    </div>
  );
}
