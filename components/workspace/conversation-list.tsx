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

  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-2 py-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="g3-btn g3-btn-ghost h-9 w-9 justify-center !px-0 text-lg"
          title="Afficher la liste des conversations"
          aria-label="Afficher la liste des conversations"
        >
          »
        </button>
        <button
          type="button"
          onClick={onNewConversation}
          className="g3-btn g3-btn-primary h-9 w-9 justify-center !px-0 text-lg"
          title="Nouvelle conversation"
          aria-label="Nouvelle conversation"
        >
          +
        </button>
      </div>
    );
  }

  return (
    <aside className="flex h-full w-full flex-col gap-3 overflow-hidden">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onNewConversation} className="g3-btn g3-btn-primary flex-1 text-sm">
          <span aria-hidden>＋</span> Nouvelle conversation
        </button>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="g3-btn g3-btn-ghost h-9 w-9 justify-center !px-0"
          title="Replier la liste"
          aria-label="Replier la liste"
        >
          «
        </button>
      </div>

      <div className="relative">
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Rechercher (titre ou contenu)…"
          className="g3-input !min-h-0 !py-2 text-sm"
          aria-label="Rechercher une conversation par titre ou par contenu"
        />
        {searching && (
          <span
            aria-hidden
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-[var(--g3-faint)]"
          >
            <span className="inline-block h-3 w-3 animate-spin rounded-full border border-[var(--g3-border-strong)] border-t-neutral-600" />
          </span>
        )}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
        {semanticActive && (
          <section>
            <p className="g3-eyebrow !text-[10px]">
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
                      <span className="line-clamp-2 text-[10px] leading-snug text-[var(--g3-muted)]">
                        « {result.excerpt} »
                      </span>
                    )}
                    <span className="flex items-center gap-1 text-[10px] text-[var(--g3-muted)]">
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
              className="g3-eyebrow flex w-full items-center justify-between !text-[10px]"
              aria-expanded={projectsOpen}
            >
              Projets
              <span aria-hidden className="text-[var(--g3-faint)]">{projectsOpen ? "▾" : "▸"}</span>
            </button>
            {projectsOpen && (
              <ul className="mt-1.5 space-y-0.5">
                {projects.slice(0, 8).map((project) => (
                  <li key={project.id}>
                    <Link
                      href={`/workspace/projects/${project.id}`}
                      className="g3-side-link flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs text-[var(--g3-text-secondary)]"
                      title={project.name}
                    >
                      <span className="truncate">▦ {project.name}</span>
                      <span className="ml-2 shrink-0 rounded-full bg-[var(--g3-elevated)] px-1.5 text-[10px] text-[var(--g3-muted)]">
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
          <p className="g3-eyebrow !text-[10px]">Conversations récentes</p>
          {loading && conversations.length === 0 ? (
            <div className="mt-2 space-y-2" aria-busy="true" aria-label="Chargement des conversations">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-9 animate-pulse rounded-lg bg-[var(--g3-elevated)]/60" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <p className="mt-2 text-xs leading-relaxed text-[var(--g3-muted)]">
              {query
                ? semanticActive
                  ? "Les conversations listées ci-dessus correspondent à votre recherche."
                  : "Aucune conversation ne correspond à la recherche."
                : "Aucune conversation pour le moment. Lancez-vous !"}
            </p>
          ) : (
            <ul className="mt-1.5 space-y-0.5">
              {filtered.map((conversation) => {
                const active = conversation.id === activeConversationId;
                const project = conversation.projectId ? projects.find((p) => p.id === conversation.projectId) : undefined;
                return (
                  <li key={conversation.id}>
                    <Link
                      href={`/workspace/conversations/${conversation.id}`}
                      data-active={active}
                      className={`g3-side-link flex flex-col gap-0.5 rounded-lg px-2.5 py-2 text-xs ${active ? "is-active" : ""}`}
                      title={conversation.title}
                    >
                      <span className="truncate font-medium">{conversation.title || "Sans titre"}</span>
                      <span className={`flex items-center gap-1 text-[10px] ${active ? "text-[var(--g3-faint)]" : "text-[var(--g3-muted)]"}`}>
                        {formatRelative(conversation.updatedAt)}
                        {project ? ` · ${project.name}` : ""}
                        {conversation.messageCount > 0 ? ` · ${conversation.messageCount} msg` : ""}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <div className="border-t border-[var(--g3-border)] pt-2 text-[11px] leading-relaxed text-[var(--g3-muted)]">
        <Link href="/workspace/projects" className="hover:text-[var(--g3-text)]">
          Gérer les projets →
        </Link>
      </div>
    </aside>
  );
}
