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
    <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-12 md:py-16">
      <header className="text-center">
        <p className="g3-eyebrow">GEN3IA</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900 md:text-3xl">
          Bon retour.
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-neutral-500">
          Vos conversations persistent : reprenez exactement là où vous vous êtes arrêté, ou lancez un nouvel objectif.
        </p>
      </header>

      <div className="flex flex-col items-center gap-2.5">
        <button
          type="button"
          onClick={() => void newConversation()}
          disabled={creating || unauthenticated}
          className="g3-btn g3-btn-primary w-full max-w-sm text-sm"
        >
          <span aria-hidden>✦</span> {creating ? "Ouverture…" : "Nouvelle conversation"}
        </button>
        {unauthenticated ? (
          <Link href="/" className="text-xs text-neutral-500 underline underline-offset-2">
            Connectez-vous pour retrouver vos conversations
          </Link>
        ) : (
          <Link href="/workspace" className="text-xs text-neutral-500 underline underline-offset-2">
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
                <div key={i} className="h-14 animate-pulse rounded-xl bg-neutral-200/50" />
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <p className="rounded-xl border border-dashed border-neutral-300 p-4 text-center text-xs text-neutral-500">
              Aucune conversation pour l&apos;instant. Lancez votre premier objectif ci-dessus.
            </p>
          ) : (
            <ul className="space-y-2" role="list">
              {conversations.map((conversation) => (
                <li key={conversation.id}>
                  <Link
                    href={`/workspace/conversations/${conversation.id}`}
                    className="g3-card flex items-center justify-between gap-3 !p-3.5 transition-colors hover:border-neutral-400"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-neutral-800">{conversation.title || "Sans titre"}</p>
                      <p className="text-[11px] text-neutral-500">
                        {conversation.messageCount} message(s) · {formatRelative(conversation.updatedAt)}
                      </p>
                    </div>
                    <span className="shrink-0 text-neutral-400" aria-hidden>→</span>
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
              <Link href={link.href} className="g3-card flex flex-col gap-0.5 !p-3 transition-colors hover:border-neutral-400">
                <span className="text-sm font-medium text-neutral-800">
                  <span aria-hidden className="mr-1.5">{link.icon}</span>
                  {link.label}
                </span>
                <span className="text-[10px] text-neutral-500">{link.description}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
