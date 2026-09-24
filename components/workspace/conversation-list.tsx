"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { formatRelative } from "./labels";
import type { Conversation } from "@/lib/domain/conversations/types";
import type { WorkspaceProject } from "@/lib/domain/projects/repository";

/**
 * Colonne gauche de l'espace conversation : conversations récentes, projets
 * et recherche. Le bouton « Nouvelle conversation » est toujours accessible
 * en haut.
 *
 * Recherche en deux étages :
 *  - filtrage instantané local sur les titres (aucune latence) ;
 *  - recherche sémantique serveur (Qdrant) au debounce de 350 ms : retrouve
 *    les conversations par le SENS de leur contenu, avec l'extrait du
 *    message correspondant. Échec API = silencieux, le filtrage local reste
 *    affiché (jamais de blocage de l'usage pour une panne d'index).
 */

interface SemanticResult {
  conversationId: string;

  title: string;

  updatedAt: string;

  messageCount: number;

  excerpt?: string;

  role?: string;

  score?: number;
}

interface ConversationListProps {
  conversations: Conversation[];
  projects: WorkspaceProject[];
  activeConversationId?: string;
  loading: boolean;
  onNewConversation: () => void;
  query: string;
  onQueryChange: (value: string) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export function ConversationList({
  conversations,
  projects,
  activeConversationId,
  loading,
  onNewConversation,
  query,
  onQueryChange,
  collapsed = false,
  onToggleCollapsed,
}: ConversationListProps) {
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [semanticResults, setSemanticResults] = useState<SemanticResult[]>([]);
  const [semanticMode, setSemanticMode] = useState<"semantic" | "text" | null>(null);
  const [searching, setSearching] = useState(false);
  const searchSequence = useRef(0);

  const trimmedQuery = query.trim();

  // Recherche sémantique débouncée — uniquement pour les requêtes d'au
  // moins 3 caractères. Les réponses hors-séquence (frappe rapide) sont
  // ignorées grâce à un compteur de séquence.
  useEffect(() => {
    const currentQuery = trimmedQuery;
    if (currentQuery.length < 3) {
      setSemanticResults([]);
      setSemanticMode(null);
      setSearching(false);
      return;
    }

    const sequence = ++searchSequence.current;
    setSearching(true);

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/workspace/conversations/search?q=${encodeURIComponent(currentQuery)}`,
          { headers: { Accept: "application/json" } },
        );
        if (!response.ok) throw new Error(`search ${response.status}`);
        const data = (await response.json()) as { mode?: "semantic" | "text"; results?: SemanticResult[] };
        if (searchSequence.current !== sequence) return; // requête dépassée
        setSemanticResults(Array.isArray(data.results) ? data.results : []);
        setSemanticMode(data.mode ?? null);
      } catch {
        if (searchSequence.current !== sequence) return;
        // Repli silencieux : le filtrage local continue de fonctionner.
        setSemanticResults([]);
        setSemanticMode(null);
      } finally {
        if (searchSequence.current === sequence) setSearching(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [trimmedQuery]);

  const conversationsByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const conversation of conversations) {
      if (conversation.projectId) {
        counts.set(conversation.projectId, (counts.get(conversation.projectId) ?? 0) + 1);
      }
    }
    return counts;
  }, [conversations]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) => c.title.toLowerCase().includes(q) || (c.projectId && projects.find((p) => p.id === c.projectId)?.name.toLowerCase().includes(q)),
    );
  }, [conversations, projects, query]);

  const semanticActive = trimmedQuery.length >= 3 && semanticResults.length > 0;

  // Regroupement chronologique (Aujourd'hui, Hier, 7 jours, 30 jours, Plus ancien).
  const grouped = useMemo(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const day = 86_400_000;
    const buckets: Array<{ label: string; items: Conversation[] }> = [
      { label: "Aujourd'hui", items: [] },
      { label: "Hier", items: [] },
      { label: "7 derniers jours", items: [] },
      { label: "30 derniers jours", items: [] },
      { label: "Plus ancien", items: [] },
    ];
    for (const conversation of filtered) {
      const t = new Date(conversation.updatedAt).getTime();
      const diff = startOfToday.getTime() - t;
      const index = diff <= 0 ? 0 : diff <= day ? 1 : diff <= 7 * day ? 2 : diff <= 30 * day ? 3 : 4;
      buckets[index].items.push(conversation);
    }
    return buckets.filter((bucket) => bucket.items.length > 0);
  }, [filtered]);

  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-2 py-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="g3-btn g3-btn-ghost h-9 w-9 justify-center !px-0"
          title="Afficher la liste des conversations"
          aria-label="Afficher la liste des conversations"
        >
          <PanelIcon />
        </button>
        <button
          type="button"
          onClick={onNewConversation}
          className="g3-btn g3-btn-primary h-9 w-9 justify-center !px-0 text-lg"
          title="Nouvelle conversation"
          aria-label="Nouvelle conversation"
        >
          <PlusIcon />
        </button>
      </div>
    );
  }

  return (
    <aside className="flex h-full w-full flex-col gap-3 overflow-hidden">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onNewConversation} className="g3-btn g3-btn-primary flex-1 text-sm">
          <PlusIcon /> Nouvelle conversation
        </button>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="g3-btn g3-btn-ghost h-9 w-9 justify-center !px-0"
          title="Replier la liste"
          aria-label="Replier la liste"
        >
          <PanelIcon />
        </button>
      </div>

      <div className="relative">
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--g3-subtle)]"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Rechercher (titre ou contenu)…"
          className="g3-input !min-h-0 !py-1.5 !pl-8 text-[13px]"
          aria-label="Rechercher une conversation par titre ou par contenu"
        />
        {searching && (
          <span
            aria-hidden
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-neutral-400"
          >
            <span className="inline-block h-3 w-3 animate-spin rounded-full border border-neutral-300 border-t-neutral-600" />
          </span>
        )}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
        {semanticActive && (
          <section>
            <p className="px-2.5 text-[11px] font-semibold text-[var(--g3-ink-2)]">
              {semanticMode === "semantic" ? "Correspondances dans le contenu" : "Titres correspondants"}
            </p>
            <ul className="mt-1.5 space-y-1">
              {semanticResults.map((result) => (
                <li key={`${result.conversationId}-${result.excerpt ?? result.title}`}>
                  <Link
                    href={`/workspace/conversations/${result.conversationId}`}
                    data-active={result.conversationId === activeConversationId}
                    className="g3-side-link flex flex-col gap-0.5 rounded-lg px-2.5 py-2 text-xs"
                    title={result.title}
                  >
                    <span className="truncate font-medium">{result.title || "Sans titre"}</span>
                    {result.excerpt && (
                      <span className="line-clamp-2 text-[10px] leading-snug text-neutral-500">
                        « {result.excerpt} »
                      </span>
                    )}
                    <span className="flex items-center gap-1 text-[10px] text-neutral-500">
                      {formatRelative(result.updatedAt)}
                      {typeof result.score === "number" ? ` · pertinence ${Math.round(result.score * 100)}%` : ""}
                      {result.messageCount > 0 ? ` · ${result.messageCount} msg` : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {projects.length > 0 && (
          <section>
            <button
              type="button"
              onClick={() => setProjectsOpen((open) => !open)}
              className="flex w-full items-center justify-between px-2.5 text-[11px] font-semibold text-[var(--g3-ink-2)]"
              aria-expanded={projectsOpen}
            >
              Projets
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`text-[var(--g3-subtle)] transition-transform ${projectsOpen ? "" : "-rotate-90"}`}><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {projectsOpen && (
              <ul className="mt-1.5 space-y-0.5">
                {projects.slice(0, 8).map((project) => (
                  <li key={project.id}>
                    <Link
                      href={`/workspace/projects/${project.id}`}
                      className="g3-side-link flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs text-neutral-700"
                      title={project.name}
                    >
                      <span className="flex min-w-0 items-center gap-2"><span aria-hidden="true" className="size-2 shrink-0 rounded-[3px] bg-[var(--g3-accent)] opacity-70" /><span className="truncate">{project.name}</span></span>
                      <span className="ml-2 shrink-0 rounded-full bg-[var(--g3-surface-2)] px-1.5 text-[10px] tabular-nums text-[var(--g3-muted)]">
                        {conversationsByProject.get(project.id) ?? 0}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section>
          <p className="px-2.5 text-[11px] font-semibold text-[var(--g3-ink-2)]">Conversations</p>
          {loading && conversations.length === 0 ? (
            <div className="mt-2 space-y-2" aria-busy="true" aria-label="Chargement des conversations">
              {[0, 1, 2].map((i) => (
                <div key={i} className="g3-skeleton h-9 rounded-lg" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <p className="mt-2 text-xs leading-relaxed text-neutral-500">
              {query
                ? semanticActive
                  ? "Les conversations listées ci-dessus correspondent à votre recherche."
                  : "Aucune conversation ne correspond à la recherche."
                : "Aucune conversation pour le moment. Lancez-vous !"}
            </p>
          ) : (
            <div className="mt-1 space-y-3">
              {grouped.map((bucket) => (
                <div key={bucket.label}>
                  <p className="px-2.5 pb-1 text-[11px] font-medium text-[var(--g3-subtle)]">{bucket.label}</p>
                  <ul className="space-y-px">
                    {bucket.items.map((conversation) => {
                      const active = conversation.id === activeConversationId;
                      const project = conversation.projectId ? projects.find((p) => p.id === conversation.projectId) : undefined;
                      return (
                        <li key={conversation.id}>
                          <Link
                            href={`/workspace/conversations/${conversation.id}`}
                            data-active={active}
                            aria-current={active ? "page" : undefined}
                            className={`g3-side-link flex flex-col !items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-xs ${active ? "is-active" : ""}`}
                            title={conversation.title}
                          >
                            <span className="w-full truncate font-medium">{conversation.title || "Sans titre"}</span>
                            <span className="flex w-full items-center gap-1 truncate text-[10.5px] font-normal text-[var(--g3-subtle)]">
                              {formatRelative(conversation.updatedAt)}
                              {project ? ` · ${project.name}` : ""}
                              {conversation.messageCount > 0 ? ` · ${conversation.messageCount} msg` : ""}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="border-t border-[var(--g3-border)] px-2.5 pt-2 text-[12px] leading-relaxed text-[var(--g3-muted)]">
        <Link href="/workspace/projects" className="hover:text-neutral-800">
          Gérer les projets →
        </Link>
      </div>
    </aside>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
  );
}

function PanelIcon() {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
  );
}
