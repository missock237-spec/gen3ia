"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { formatRelative } from "@/components/workspace/labels";
import type { Conversation, ConversationRun } from "@/lib/domain/conversations/types";
import type { WorkspaceProject } from "@/lib/domain/projects/repository";

/**
 * /dashboard — page d'accueil légère du workspace conversationnel.
 * Deux actions dominent : « Nouvelle conversation » et « Reprendre une
 * conversation ». Le reste (Projets, Fichiers, Connecteurs, Bibliothèque,
 * Missions) est un accès rapide. Le centre de gravité vit désormais dans
 * /workspace (conversations persistantes avec exécution d'agents).
 */

export default function DashboardPage() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [unauthenticated, setUnauthenticated] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [conversationsRes, projectsRes] = await Promise.allSettled([
        authFetch("/api/workspace/conversations?limit=5", { cache: "no-store" }),
        authFetch("/api/workspace/projects?limit=6", { cache: "no-store" }),
      ]);
      if (conversationsRes.status === "fulfilled") {
        if (conversationsRes.value.status === 401) {
          setUnauthenticated(true);
          return;
        }
        if (conversationsRes.value.ok) {
          const data = (await conversationsRes.value.json()) as { conversations: Conversation[] };
          setConversations(data.conversations);
        }
      }
      if (projectsRes.status === "fulfilled" && projectsRes.value.ok) {
        const data = (await projectsRes.value.json()) as { projects: WorkspaceProject[] };
        setProjects(data.projects);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const newConversation = async () => {
    setCreating(true);
    try {
      const response = await authFetch("/api/workspace/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error();
      const data = (await response.json()) as { conversation: Conversation };
      router.push(`/workspace/conversations/${data.conversation.id}`);
    } catch {
      router.push("/workspace");
    } finally {
      setCreating(false);
    }
  };

  const quickLinks = [
    { href: "/workspace/projects", label: "Projets", icon: "▦", description: "Contextes persistants" },
    { href: "/workspace/files", label: "Fichiers", icon: "□", description: "Livrables et stockage" },
    { href: "/workspace/connectors", label: "Connecteurs", icon: "⧉", description: "Applications connectées" },
    { href: "/workspace/bibliotheque", label: "Bibliothèque", icon: "◈", description: "Capacités métier" },
    { href: "/studio", label: "Missions", icon: "◷", description: "Tâches et validations" },
  ];

  return (
    <div className="relative mx-auto w-full max-w-3xl space-y-8 px-4 py-12 md:py-16">
      {/* Halo Aurora d'accueil */}
      <div className="aurora opacity-50" aria-hidden="true" />
      <header className="relative text-center">
        <p className="mx-auto inline-flex items-center gap-2 rounded-full border border-[rgba(124,92,255,0.35)] bg-[var(--g3-primary-soft)] px-3.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--g3-primary-strong)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--g3-gradient)]" aria-hidden /> Interface V2 · Aurora
        </p>
        <h1 className="mt-4 font-[family-name:var(--font-display)] text-2xl font-bold tracking-tight text-[var(--g3-text)] md:text-4xl">
          Bon retour. <span className="gradient-text">Que fait-on aujourd&apos;hui ?</span>
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-[var(--g3-muted)]">
          Vos conversations persistent : reprenez exactement là où vous vous êtes arrêté, ou lancez un nouvel objectif.
        </p>
      </header>

      <div className="relative flex flex-col items-center gap-2.5">
        <button
          type="button"
          onClick={() => void newConversation()}
          disabled={creating || unauthenticated}
          className="g3-btn g3-btn-primary w-full max-w-sm text-sm"
        >
          <span aria-hidden>✦</span> {creating ? "Ouverture…" : "Nouvelle conversation"}
        </button>
        {unauthenticated ? (
          <Link href="/" className="text-xs text-[var(--g3-muted)] underline underline-offset-2">
            Connectez-vous pour retrouver vos conversations
          </Link>
        ) : (
          <Link href="/workspace" className="text-xs text-[var(--g3-muted)] underline underline-offset-2">
            Ouvrir l&apos;espace conversationnel complet
          </Link>
        )}
      </div>

      {!unauthenticated && (
        <section className="space-y-2.5">
          <h2 className="g3-eyebrow !text-[10px]">Reprendre une conversation</h2>
          {loading ? (
            <div className="space-y-2" aria-busy>
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-xl bg-[var(--g3-elevated)]/50" />
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <p className="p-4 text-center text-xs text-[var(--g3-muted)]">
              Aucune conversation pour l&apos;instant. Lancez votre premier objectif ci-dessus.
            </p>
          ) : (
            <ul className="space-y-2" role="list">
              {conversations.map((conversation) => (
                <li key={conversation.id}>
                  <Link
                    href={`/workspace/conversations/${conversation.id}`}
                    className="g3-card flex items-center justify-between gap-3 !p-3.5 transition-all hover:-translate-y-0.5 hover:border-[rgba(124,92,255,0.45)] hover:shadow-[0_12px_36px_-18px_rgba(124,92,255,0.5)]"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-[var(--g3-text)]">{conversation.title || "Sans titre"}</p>
                      <p className="text-[11px] text-[var(--g3-muted)]">
                        {conversation.messageCount} message(s) · {formatRelative(conversation.updatedAt)}
                      </p>
                    </div>
                    <span className="shrink-0 text-[var(--g3-primary-strong)]" aria-hidden>→</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!unauthenticated && projects.length > 0 && (
        <section className="space-y-2.5">
          <h2 className="g3-eyebrow !text-[10px]">Vos projets</h2>
          <ul className="flex flex-wrap gap-2" role="list">
            {projects.slice(0, 6).map((project) => (
              <li key={project.id}>
                <Link href={`/workspace/projects/${project.id}`} className="g3-chip text-xs">
                  ▦ {project.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2.5">
        <h2 className="g3-eyebrow !text-[10px]">Accès rapide</h2>
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="list">
          {quickLinks.map((link) => (
            <li key={link.href}>
              <Link href={link.href} className="g3-card flex flex-col gap-0.5 !p-3 transition-all hover:-translate-y-0.5 hover:border-[rgba(124,92,255,0.45)] hover:shadow-[0_12px_36px_-18px_rgba(124,92,255,0.5)]">
                <span className="text-sm font-medium text-[var(--g3-text)]">
                  <span aria-hidden className="mr-1.5 text-[var(--g3-primary-strong)]">{link.icon}</span>
                  {link.label}
                </span>
                <span className="text-[10px] text-[var(--g3-muted)]">{link.description}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
