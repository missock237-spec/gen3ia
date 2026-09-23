"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ApprovalCard } from "./approval-card";
import { ArtifactPanel } from "./artifact-panel";
import { Composer } from "./composer/composer";
import { ConversationList } from "./conversation-list";
import { ContextDrawer } from "./context-drawer";
import { MessageThread } from "./message-thread";
import { RunTimeline } from "./run-timeline";
import type {
  Conversation,
  ConversationApproval,
  ConversationArtifact,
  ConversationMessage,
  ConversationRun,
  MessageAttachment,
} from "@/lib/domain/conversations/types";
import type { WorkspaceProject } from "@/lib/domain/projects/repository";

/**
 * Orchestrateur de l'espace conversation (layout 3 colonnes) :
 *  - gauche : conversations récentes, projets, recherche ;
 *  - centre : fil de messages + composer (pièces jointes, mentions projet) ;
 *  - droite : plan d'exécution, outils, validations et livrables.
 *
 * Le dashboard devient une page d'accueil légère ; le centre de gravité est
 * ici : une application de conversations persistantes avec exécution
 * d'agents — « Reprendre une conversation » se fait en un clic.
 */

interface ConversationWorkspaceProps {
  conversationId?: string;
}

interface ConversationDetail {
  conversation: Conversation;
  project: WorkspaceProject | null;
  messages: ConversationMessage[];
  runs: ConversationRun[];
  artifacts: ConversationArtifact[];
  approvals: ConversationApproval[];
}

const STARTER_SUGGESTIONS = [
  "Analyse mes ventes du mois et rédige un compte rendu",
  "Prépare un point hebdo à partir de mes notes",
  "Crée un rapport de suivi avec les prochaines échéances",
  "Recherche les dernières tendances de mon marché",
];

export function ConversationWorkspace({ conversationId }: ConversationWorkspaceProps) {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [listCollapsed, setListCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | undefined>(undefined);

  const loadLists = useCallback(async () => {
    try {
      const [conversationsRes, projectsRes] = await Promise.all([
        fetch("/api/workspace/conversations?limit=50", { cache: "no-store" }),
        fetch("/api/workspace/projects?limit=50", { cache: "no-store" }),
      ]);
      if (conversationsRes.ok) {
        const data = (await conversationsRes.json()) as { conversations: Conversation[] };
        setConversations(data.conversations);
      }
      if (projectsRes.ok) {
        const data = (await projectsRes.json()) as { projects: WorkspaceProject[] };
        setProjects(data.projects);
      }
    } catch {
      /* réseau indisponible : listes conservées */
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string, silent = false) => {
    if (!silent) setLoadingDetail(true);
    try {
      const response = await fetch(`/api/workspace/conversations/${id}`, { cache: "no-store" });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Conversation introuvable.");
      }
      const data = (await response.json()) as ConversationDetail;
      setDetail(data);
      setProjectId(data.conversation.projectId);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Conversation introuvable.");
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  useEffect(() => {
    if (conversationId) {
      void loadDetail(conversationId);
    } else {
      setDetail(null);
    }
  }, [conversationId, loadDetail]);

  const createConversation = useCallback(async () => {
    const response = await fetch("/api/workspace/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(projectId ? { projectId } : {}),
    });
    if (!response.ok) return;
    const data = (await response.json()) as { conversation: Conversation };
    router.push(`/workspace/conversations/${data.conversation.id}`);
  }, [projectId, router]);

  const sendMessage = useCallback(
    async (message: string, attachments: MessageAttachment[]) => {
      if (!conversationId) return;
      setGenerating(true);
      setError("");
      // Affichage immédiat du message utilisateur (optimiste, résilient).
      const optimistic: ConversationMessage = {
        id: `local-${Date.now()}`,
        conversationId,
        userId: "",
        role: "user",
        content: message,
        attachments,
        generationStatus: "complete",
        createdAt: new Date().toISOString(),
      };
      setDetail((current) =>
        current ? { ...current, messages: [...current.messages, optimistic] } : current,
      );
      try {
        const response = await fetch(`/api/workspace/conversations/${conversationId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message, attachments, projectId }),
        });
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? "Le message n'a pas pu être traité.");
        }
        // Le tour complet est rechargé : message utilisateur réel, réponse,
        // timeline, artefacts et validations persistés côté serveur.
        await loadDetail(conversationId, true);
        void loadLists();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Le message n'a pas pu être traité.");
      } finally {
        setGenerating(false);
      }
    },
    [conversationId, loadDetail, loadLists, projectId],
  );

  const decideApproval = useCallback(
    async (approvalId: string, decision: "approved" | "rejected") => {
      if (!conversationId) return;
      const response = await fetch(`/api/workspace/approvals/${approvalId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Décision impossible.");
        return;
      }
      await loadDetail(conversationId, true);
      void loadLists();
    },
    [conversationId, loadDetail, loadLists],
  );

  const resolveFileUrl = useCallback(async (path: string) => {
    const response = await fetch(`/api/storage/permanent?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error("Lien de téléchargement indisponible.");
    const data = (await response.json()) as { url: string };
    return data.url;
  }, []);

  const centerEmpty = !loadingDetail && !detail && !error;

  const welcome = useMemo(
    () => (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
        <div className="grid size-14 place-items-center rounded-2xl bg-neutral-900 text-2xl text-white" aria-hidden>
          ✦
        </div>
        <div>
          <h1 className="text-lg font-semibold text-neutral-900">Que voulez-vous accomplir ?</h1>
          <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-neutral-500">
            Décrivez un objectif : Gen3ia propose un plan lisible, utilise vos applications connectées
            avec votre validation, et range les livrables (documents, images, rapports, fichiers) dans la conversation.
          </p>
        </div>
        <div className="w-full max-w-xl">
          <Composer
            onSend={async (message, attachments) => {
              // Crée la conversation puis envoie le premier message.
              const response = await fetch("/api/workspace/conversations", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  title: message.slice(0, 60),
                  ...(projectId ? { projectId } : {}),
                }),
              });
              if (!response.ok) {
                setError("Création de la conversation impossible.");
                return;
              }
              const data = (await response.json()) as { conversation: Conversation };
              router.push(`/workspace/conversations/${data.conversation.id}`);
              // Premier message après le rendu de la conversation créée.
              await fetch(`/api/workspace/conversations/${data.conversation.id}/messages`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ message, attachments, projectId }),
              });
              router.refresh();
            }}
            projects={projects}
            projectId={projectId}
            onProjectChange={setProjectId}
            suggestions={STARTER_SUGGESTIONS}
          />
        </div>
      </div>
    ),
    [projectId, projects, router],
  );

  return (
    <div className="g3-card flex h-[calc(100dvh-9.5rem)] min-h-[520px] gap-3 !p-3">
      {/* Colonne gauche — conversations récentes, projets, recherche */}
      <div
        className={`shrink-0 transition-all ${listCollapsed ? "w-14" : "w-64"} border-r border-neutral-100 pr-3 max-lg:hidden`}
      >
        <ConversationList
          conversations={conversations}
          projects={projects}
          activeConversationId={conversationId}
          loading={loadingList}
          onNewConversation={() => void createConversation()}
          query={query}
          onQueryChange={setQuery}
          collapsed={listCollapsed}
          onToggleCollapsed={() => setListCollapsed((collapsed) => !collapsed)}
        />
      </div>

      {/* Colonne centrale — conversation */}
      <div className="flex min-w-0 flex-1 flex-col">
        {detail && (
          <div className="mb-2 flex items-center justify-between gap-2 border-b border-neutral-100 pb-2">
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-neutral-900">{detail.conversation.title || "Sans titre"}</h1>
              <p className="text-[11px] text-neutral-500">
                {detail.project ? `Projet : ${detail.project.name}` : "Sans projet"}
                {detail.messages.length > 0 ? ` · ${detail.messages.length} messages` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDrawerOpen((open) => !open)}
              className="g3-btn g3-btn-ghost !min-h-0 !px-2.5 !py-1.5 text-xs"
              title="Plan, outils, validations et livrables"
            >
              ⧉ Contexte
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto pr-1">
          {loadingDetail ? (
            <div className="space-y-3 py-4" aria-busy>
              {[0, 1, 2].map((i) => (
                <div key={i} className={`h-16 animate-pulse rounded-2xl bg-neutral-100 ${i % 2 ? "ml-auto w-2/3" : "w-3/4"}`} />
              ))}
            </div>
          ) : error && !detail ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="g3-card max-w-md text-center">
                <p className="text-sm font-semibold text-neutral-900">{error}</p>
                <p className="mt-1 text-xs text-neutral-500">Choisissez une conversation dans la liste ou créez-en une nouvelle.</p>
              </div>
            </div>
          ) : centerEmpty ? (
            welcome
          ) : detail ? (
            <MessageThread
              messages={detail.messages}
              runs={detail.runs}
              approvals={detail.approvals}
              artifacts={detail.artifacts}
              generating={generating}
              onDecide={decideApproval}
            />
          ) : null}
        </div>

        {error && detail && (
          <p className="mt-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
            {error}
          </p>
        )}

        {detail && (
          <div className="mt-2 border-t border-neutral-100 pt-2">
            <Composer
              onSend={sendMessage}
              disabled={generating}
              projects={projects}
              projectId={projectId}
              onProjectChange={setProjectId}
              autoFocus
            />
          </div>
        )}
      </div>

      {/* Panneau droit optionnel — plan, outils, validations, livrables */}
      <div className={`shrink-0 transition-all ${drawerOpen ? "w-80 border-l border-neutral-100 pl-3" : "w-10"}`}>
        {detail && (
          <ContextDrawer
            open={drawerOpen}
            onToggle={() => setDrawerOpen((open) => !open)}
            conversationTitle={detail.conversation.title}
            project={detail.project}
            runs={detail.runs}
            approvals={detail.approvals}
            artifacts={detail.artifacts}
            onDecide={decideApproval}
          />
        )}
      </div>
    </div>
  );
}

/** Section livrables réutilisable (page Fichiers, projet). */
export function ArtifactsSection({
  artifacts,
  title = "Livrables",
  description,
}: {
  artifacts: ConversationArtifact[];
  title?: string;
  description?: string;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-neutral-500">{description}</p>}
      </div>
      <ArtifactPanel artifacts={artifacts} />
    </section>
  );
}

/** Timeline complète réutilisable (page mission/projet). */
export { RunTimeline, ApprovalCard };
