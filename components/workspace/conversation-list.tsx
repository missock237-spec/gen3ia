"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { formatRelative } from "./labels";
import type { Conversation } from "@/lib/domain/conversations/types";
import type { WorkspaceProject } from "@/lib/domain/projects/repository";

/**
 * Colonne gauche de l'espace conversation : conversations récentes, projets
 * et recherche. Le bouton « Nouvelle conversation » est toujours accessible
 * en haut.
 */

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

      <input
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Rechercher une conversation…"
        className="g3-input !min-h-0 !py-2 text-sm"
        aria-label="Rechercher une conversation"
      />

      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
        {projects.length > 0 && (
          <section>
            <button
              type="button"
              onClick={() => setProjectsOpen((open) => !open)}
              className="g3-eyebrow flex w-full items-center justify-between !text-[10px]"
              aria-expanded={projectsOpen}
            >
              Projets
              <span aria-hidden className="text-neutral-400">{projectsOpen ? "▾" : "▸"}</span>
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
                      <span className="truncate">▦ {project.name}</span>
                      <span className="ml-2 shrink-0 rounded-full bg-neutral-100 px-1.5 text-[10px] text-neutral-500">
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
            <div className="mt-2 space-y-2" aria-busy>
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-9 animate-pulse rounded-lg bg-neutral-200/60" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <p className="mt-2 text-xs leading-relaxed text-neutral-500">
              {query ? "Aucune conversation ne correspond à la recherche." : "Aucune conversation pour le moment. Lancez-vous !"}
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
                      <span className={`flex items-center gap-1 text-[10px] ${active ? "text-neutral-300" : "text-neutral-500"}`}>
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

      <div className="border-t border-neutral-200 pt-2 text-[11px] leading-relaxed text-neutral-500">
        <Link href="/workspace/projects" className="hover:text-neutral-800">
          Gérer les projets →
        </Link>
      </div>
    </aside>
  );
}
