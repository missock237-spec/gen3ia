"use client";

import * as React from "react";

import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";
import { AgentChatPanel } from "@/components/agent/agent-chat-panel";
import { CreateAgentDialog } from "@/components/agent/create-agent-dialog";
import { Callout } from "@/components/studio/callout";
import { Gen3iaLogo } from "@/components/brand/gen3ia-logo";
import type { AgentSummary } from "@/lib/agents/schema";

/**
 * Chat d'agent IA « Gen IA » (Studio Gen3ia) — DEMANDE UTILISATEUR :
 * la création d'agents IA est supprimée. L'utilisateur donne N'IMPORTE QUEL
 * prompt et Gen IA (agent IA universel, créé automatiquement une seule fois)
 * résout le problème. Le rail affiche l'HISTORIQUE des chats (conversations
 * réelles persistées), avec ouverture et suppression.
 */

type ConversationSummary = {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
};

const GEN_IA_PAYLOAD = {
  name: "Agent universel Gen3ia",
  description:
    "Agent IA universel de Gen3ia : donnez-lui n'importe quel prompt (code, rédaction, analyse, recherche, automatisation, données, présentations…) et il résout le problème de bout en bout. Capable de déployer jusqu'à 10 sous-agents spécialisés pour une tâche complexe.",
  type: "universal" as const,
  typeLabel: "Agent IA universel",
  skills: [
    "Résolution de problèmes",
    "Développement & code",
    "Rédaction professionnelle",
    "Analyse de données",
    "Recherche web",
    "Automatisations & API",
  ],
  agentMode: "standard" as const,
  tools: ["web.search", "web.api", "web.api.write", "artifact.create", "file.create", "code.execute"],
  status: "active" as const,
  voiceEnabled: false,
};

function formatRelativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `il y a ${days} j`;
  return new Date(then).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

export function AgentChatWorkshop({ initialMessage = "" }: { initialMessage?: string }) {
  const sessionDisponible = useSessionAvailable();
  const [agent, setAgent] = React.useState<AgentSummary | null>(null);
  const [agents, setAgents] = React.useState<AgentSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [bootstrapping, setBootstrapping] = React.useState(false);
  const [conversations, setConversations] = React.useState<ConversationSummary[]>([]);
  const [pendingConversationId, setPendingConversationId] = React.useState<string | null>(null);
  const [showRailMobile, setShowRailMobile] = React.useState(false);
  // MODE ZEN : masque le rail historique sur desktop pour un chat plein
  // écran sans distraction (le rail reste accessible via le bouton).
  const [zen, setZen] = React.useState(false);
  const [error, setError] = React.useState("");
  const [_loadFailed, setLoadFailed] = React.useState(false);
  // Historique MOMENTANÉMENT indisponible (erreur serveur/infra) — distinct
  // d'une liste vide : sous quota de base de données l'utilisateur ne doit
  // pas croire qu'il n'a AUCUN chat (Task 96-c).
  const [historyUnavailable, setHistoryUnavailable] = React.useState(false);
  const [showCreateAgent, setShowCreateAgent] = React.useState(false);

  const refreshConversations = React.useCallback(async () => {
    if (!agent) return;
    try {
      const response = await authFetch(`/api/chat/conversations?limit=30&agentId=${encodeURIComponent(agent.id)}`, { cache: "no-store" });
      if (response.ok) {
        const data = await response.json();
        setConversations((data.conversations ?? []) as ConversationSummary[]);
        setHistoryUnavailable(false);
      } else if (response.status >= 500) {
        // 503 dégradé (quota de base de données…) : l'historique existe mais
        // est momentanément illisible — JAMAIS confondu avec « Aucun chat ».
        setHistoryUnavailable(true);
      }
    } catch {
      setHistoryUnavailable(true);
    }
  }, [agent]);

  // Charge l'agent « Gen IA » (créé automatiquement au premier usage —
  // aucune interface de création d'agent : l'utilisateur discute directement).
  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const response = await authFetch("/api/agents", { cache: "no-store" });
      if (response.ok) {
        const data = await response.json();
        const agents = (data.agents ?? []) as AgentSummary[];
        setAgents(agents);
        const genIa = agents.find((item) => item.name?.toLowerCase() === "gen ia") ?? agents[0] ?? null;
        if (genIa) {
          setAgent(genIa);
          setLoadFailed(false);
          setError("");
        } else {
          // Provisionnement automatique de « Gen IA » (une seule fois).
          setBootstrapping(true);
          const created = await authFetch("/api/agents", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(GEN_IA_PAYLOAD),
          });
          if (created.ok) {
            const payload = await created.json();
            setAgent((payload.agent ?? null) as AgentSummary | null);
            setLoadFailed(false);
            setError("");
          } else if (created.status === 429) {
            setError("Préparation de l'agent universel momentanément indisponible (limite de création). Réessayez dans un instant.");
          } else {
            setLoadFailed(true);
            setError("Impossible de préparer l'agent universel. Vérifiez votre connexion puis réessayez.");
          }
          setBootstrapping(false);
        }
      } else {
        setLoadFailed(true);
        if (response.status !== 401) setError("Impossible de charger l'agent universel. Vérifiez votre connexion puis réessayez.");
      }
    } catch {
      setLoadFailed(true);
      setError("Connexion au serveur impossible. L'agent universel réapparaîtra au réessai.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void refresh(); }, [refresh]);
  React.useEffect(() => { void refreshConversations(); }, [refreshConversations]);

  async function deleteConversation(id: string) {
    if (!window.confirm("Supprimer définitivement ce chat de l'historique ?")) return;
    const response = await authFetch(`/api/chat/conversations/${id}`, { method: "DELETE" });
    if (response.ok) {
      setConversations((current) => current.filter((item) => item.id !== id));
      if (id === pendingConversationId) setPendingConversationId(null);
    } else {
      // Échec serveur (session expirée, quota, stockage) : l'item reste — on
      // l'explique au lieu d'un silence que l'utilisateur prend pour un bug.
      setError(response.status === 401 ? "Session expirée — reconnectez-vous pour supprimer ce chat." : "Suppression impossible pour le moment. Réessayez dans un instant.");
    }
  }

  /** Suppression d'un agent possédé (route ouverte aux propriétaires,
   *  cloisonnement propriétaire/org assuré par deleteAgentForUser). */
  async function deleteAgent(id: string) {
    const cible = agents.find((item) => item.id === id);
    if (!cible) return;
    if (!window.confirm(`Supprimer définitivement l'agent « ${cible.name || id} » ? Ses chats resteront dans l'historique.`)) return;
    const response = await authFetch(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (response.ok) {
      setAgents((current) => current.filter((item) => item.id !== id));
      if (agent?.id === id) {
        // L'agent actif vient d'être supprimé : recharger (le système
        // re-provisionne automatiquement l'agent universel « Gen IA »).
        setAgent(null);
        await refresh();
      }
    } else {
      setError(response.status === 401 ? "Session expirée — reconnectez-vous pour supprimer cet agent." : "Suppression de l'agent impossible pour le moment. Réessayez dans un instant.");
    }
  }

  const rail = (
    <aside className="flex h-full min-h-0 flex-col rounded-[26px] border border-[var(--g3-border)] bg-[var(--g3-surface)] p-4 shadow-[0_14px_40px_-18px_rgba(28,27,24,0.14)]" aria-label="Chats de l'agent universel">
      <div className="flex items-center gap-3">
        <span className="g3-brand-mark" aria-hidden="true"><Gen3iaLogo size={31} /></span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-black text-[var(--g3-text)]">Agent universel</span>
          <span className="block truncate text-[10px] font-semibold uppercase tracking-[.18em] text-[var(--g3-primary-strong)]">Agent IA universel</span>
        </span>
      </div>

      <button
        type="button"
        className="g3-btn g3-btn-primary mt-3 w-full text-xs"
        onClick={() => { setPendingConversationId(null); setShowRailMobile(false); }}
      >
        + Nouveau chat
      </button>
      <button type="button" className="mt-2 w-full rounded-xl border border-[var(--g3-border)] px-3 py-2 text-xs font-semibold text-[var(--g3-muted)] hover:bg-[var(--g3-elevated)] hover:text-[var(--g3-text)]" onClick={() => setShowCreateAgent(true)}>
        + Créer un agent
      </button>

      <p className="mt-4 text-[10px] font-black uppercase tracking-[.24em] text-[var(--g3-muted)]">Vos agents</p>
      <div className="mt-2 space-y-1.5">
        {agents.length === 0 ? (
          <p className="rounded-xl bg-[var(--g3-elevated)] px-3 py-3 text-center text-xs leading-5 text-[var(--g3-faint)]">
            Aucun agent. Créez-en un ou discutez avec l&apos;agent universel.
          </p>
        ) : (
          agents.map((item) => {
            const actif = item.id === agent?.id;
            return (
              <div key={item.id} className="group flex items-center gap-2 rounded-2xl bg-[var(--g3-elevated)]/60 px-3 py-2">
                <span aria-hidden="true" className="text-sm">🤖</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-bold text-[var(--g3-text)]">{item.name || item.id}</span>
                  <span className="block truncate text-[10px] text-[var(--g3-faint)]">
                    {item.typeLabel || item.type} · {item.status}
                    {actif ? " · actif" : ""}
                  </span>
                </span>
                {!actif && (
                  <button
                    type="button"
                    onClick={() => void deleteAgent(item.id)}
                    aria-label={`Supprimer l'agent ${item.name || item.id}`}
                    className="shrink-0 rounded-lg px-1.5 py-1 text-[9px] text-[var(--g3-faint)] transition hover:text-[var(--g3-danger-strong)]"
                  >
                    Suppr.
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      <p className="mt-4 text-[10px] font-black uppercase tracking-[.24em] text-[var(--g3-muted)]">Historique des chats</p>
      <div className="mt-2 max-h-[420px] min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5 lg:max-h-none">
        {conversations.length === 0 ? (
          historyUnavailable ? (
            <p className="rounded-xl bg-[var(--g3-elevated)] px-3 py-4 text-center text-xs leading-5 text-[var(--g3-faint)]">
              Historique momentanément indisponible (le stockage est en limite de quota). Vos chats réapparaissent dès le retour du service — réessayez dans un instant.
            </p>
          ) : (
            <p className="rounded-xl bg-[var(--g3-elevated)] px-3 py-4 text-center text-xs leading-5 text-[var(--g3-faint)]">
              Aucun chat pour l&apos;instant. Donnez votre premier prompt à l&apos;agent universel : il résout le problème de bout en bout.
            </p>
          )
        ) : (
          conversations.map((conversation) => {
            const selected = conversation.id === pendingConversationId;
            return (
              <div
                key={conversation.id}
                className={`group relative rounded-2xl transition ${selected ? "bg-[var(--g3-elevated)] shadow-[0_8px_24px_-12px_rgba(28,27,24,0.35)]" : "bg-transparent hover:bg-[var(--g3-elevated)]"}`}
              >
                <button
                  type="button"
                  onClick={() => { setPendingConversationId(conversation.id); setShowRailMobile(false); }}
                  className="flex w-full items-start gap-2 p-3 text-left"
                  aria-pressed={selected}
                >
                  <span aria-hidden="true" className="mt-0.5 text-sm">💬</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-bold text-[var(--g3-text)]">{conversation.title || "Nouveau chat"}</span>
                    <span className="mt-0.5 block truncate text-[10px] text-[var(--g3-faint)]">
                      {formatRelativeDate(conversation.updatedAt)} · {conversation.messageCount} message{conversation.messageCount > 1 ? "s" : ""}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void deleteConversation(conversation.id)}
                  aria-label={`Supprimer le chat ${conversation.title || ""}`}
                  className="absolute right-2 top-2 hidden rounded-lg bg-[var(--g3-surface)] px-1.5 py-1 text-[9px] text-[var(--g3-faint)] transition hover:text-[var(--g3-danger-strong)] group-hover:block"
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

  if (loading || bootstrapping) {
    return (
      <div className="g3-agent-light g3-card grid place-items-center rounded-[26px] p-16 text-sm text-[var(--g3-muted)]" role="status">
        <span className="flex items-center gap-3">
          <Gen3iaLogo size={30} working />
          {bootstrapping ? "Préparation de l'agent universel…" : "Chargement…"}
        </span>
      </div>
    );
  }

  return (
    // FRAGMENT RACINE : le dialogue « Créer un agent » est un frère du layout
    // principal (portail de modal) — il doit être rendu HORS de la colonne
    // flex, d'où le fragment englobant (build cassé du 3 oct. réparé : le
    // </> de fermeture existait sans ouverture).
    <>
    <div className="g3-agent-light flex h-full min-h-0 flex-col gap-2 lg:gap-4">
      {sessionDisponible === false && <Callout tone="warning" className="rounded-2xl">Session expirée — reconnectez-vous pour discuter avec Gen IA.</Callout>}
      {error && <Callout tone="error" className="rounded-2xl"><span className="flex items-center justify-between gap-3"><span>{error}</span><button type="button" onClick={() => void refresh()} className="shrink-0 rounded-full border border-[rgba(177,138,255,0.45)] px-3 py-1.5 text-xs font-semibold text-[var(--g3-danger-strong)] hover:bg-[var(--g3-danger-soft)]">Réessayer</button></span></Callout>}

      {/* Mode ZEN (plein écran avancé) : masque le rail historique sur desktop */}
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={() => setZen((current) => !current)}
          aria-pressed={zen}
          title={zen ? "Réafficher l'historique des chats" : "Mode zen : masquer l'historique pour un chat plein écran"}
          className="hidden rounded-full border border-[var(--g3-border)] px-3 py-1.5 text-[11px] font-semibold text-[var(--g3-muted)] transition hover:bg-[var(--g3-elevated)] lg:block"
        >
          {zen ? "▤ Historique" : "▭ Mode zen"}
        </button>
      </div>

      {/* Sélecteur mobile : le rail se replie sous lg */}
      <button
        type="button"
        onClick={() => setShowRailMobile((current) => !current)}
        aria-expanded={showRailMobile}
        className="flex w-full items-center justify-between rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-4 py-3 text-sm lg:hidden"
      >
        <span className="flex items-center gap-2">
          <Gen3iaLogo size={28} />
          <span className="font-bold">Gen IA</span>
          <span className="text-xs text-[var(--g3-primary-strong)]">Agent IA universel</span>
        </span>
        <span className="text-xs text-[var(--g3-faint)]">{showRailMobile ? "Fermer" : "Historique"}</span>
      </button>
      {showRailMobile && <div className="lg:hidden">{rail}</div>}

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-4 lg:grid-cols-[290px_minmax(0,1fr)]">
        <div className={zen ? "hidden" : "hidden min-h-0 lg:block"}>{rail}</div>
        <div className="min-h-0 min-w-0">
          {agent ? (
            <AgentChatPanel
              agent={agent}
              onAgentsChanged={() => void refresh()}
              initialMessage={initialMessage}
              pendingConversationId={pendingConversationId}
              onPendingConversationConsumed={() => setPendingConversationId(null)}
              onConversationsChanged={() => void refreshConversations()}
            />
          ) : (
            <div className="g3-card grid place-items-center p-10 text-sm text-[var(--g3-muted)]">Gen IA est indisponible pour le moment.</div>
          )}
        </div>
      </div>
    </div>
    {showCreateAgent && <CreateAgentDialog onClose={() => setShowCreateAgent(false)} onCreated={() => void refresh()} />}
    </>
  );
}
