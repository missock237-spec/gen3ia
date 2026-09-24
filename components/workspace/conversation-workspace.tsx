"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApprovalCard } from "./approval-card";
import { ArtifactPanel } from "./artifact-panel";
import { Composer, readAuthorizationMode, type ComposerSendOptions } from "./composer/composer";
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
import type { ConversationStreamEvent } from "@/lib/domain/conversations/stream-events";
import { streamConversationTurn } from "@/lib/domain/conversations/stream-client";
import type { WorkspaceProject } from "@/lib/domain/projects/repository";
import type { AuthorizationMode } from "@/lib/security/authorization-mode";

/**
 * Orchestrateur de l'espace conversation (layout 3 colonnes) :
 *  - gauche : conversations récentes, projets, recherche ;
 *  - centre : fil de messages + composer (pièces jointes, connecteurs,
 *    mentions projet) — réponse écrite en direct (streaming) ;
 *  - droite : plan d'exécution, outils, validations et livrables.
 *
 * Le tour conversationnel est consommé en flux NDJSON : phases de travail,
 * fragments de texte, étapes d'outils et validations arrivent en direct ;
 * à la fin, l'état serveur (autoritaire) remplace la vue locale.
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

/** État vivant du tour en cours (rendu en direct dans le fil). */
interface LiveTurn {
  status: string;
  content: string;
  run: ConversationRun | null;
  approvals: ConversationApproval[];
  artifacts: ConversationArtifact[];
}

const STARTER_SUGGESTIONS = [
  "Analyse mes ventes du mois et rédige un compte rendu",
  "Prépare un point hebdo à partir de mes notes",
  "Crée un rapport de suivi avec les prochaines échéances",
  "Recherche les dernières tendances de mon marché",
];

/** Message en attente après création depuis l'accueil (hand-off entre pages). */
const PENDING_MESSAGE_PREFIX = "g3-pending-message:";

function emptyLive(): LiveTurn {
  return { status: "", content: "", run: null, approvals: [], artifacts: [] };
}

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
  const [connectors, setConnectors] = useState<string[]>([]);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const threadScrollRef = useRef<HTMLDivElement>(null);

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

  // Défilement automatique pendant l'écriture en direct (et à l'arrivée
  // de nouveaux messages) — l'utilisateur garde la dernière ligne en vue.
  useEffect(() => {
    const container = threadScrollRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [detail?.messages.length, live?.content, live?.run, live?.status]);

  const consumeEvent = useCallback((event: ConversationStreamEvent) => {
    switch (event.type) {
      case "turn_started":
        // Remplace le message optimiste par le message persisté (vrai id).
        setDetail((current) => {
          if (!current) return current;
          const withoutOptimistic = current.messages.filter((m) => !m.id.startsWith("local-"));
          return { ...current, messages: [...withoutOptimistic, event.userMessage] };
        });
        break;
      case "status":
        setLive((current) => ({ ...(current ?? emptyLive()), status: event.label }));
        break;
      case "message_delta":
        setLive((current) => ({ ...(current ?? emptyLive()), content: (current?.content ?? "") + event.delta }));
        break;
      case "run_created":
        setLive((current) => ({ ...(current ?? emptyLive()), run: event.run }));
        break;
      case "run_status":
        setLive((current) => (current?.run ? { ...current, run: { ...current.run, status: event.status } } : current));
        break;
      case "step_update":
        setLive((current) => {
          if (!current?.run) return current;
          const steps = [...current.run.steps];
          const index = steps.findIndex((s) => s.id === event.step.id);
          if (index >= 0) steps[index] = event.step;
          else steps.push(event.step);
          return { ...current, run: { ...current.run, steps } };
        });
        break;
      case "approval_created":
        setLive((current) => ({ ...(current ?? emptyLive()), approvals: [...current?.approvals ?? [], event.approval] }));
        break;
      case "artifact_created":
        setLive((current) => ({ ...(current ?? emptyLive()), artifacts: [...current?.artifacts ?? [], event.artifact] }));
        break;
      case "message_complete":
        // Le texte final remplace le buffer en cours (source de vérité serveur).
        setLive((current) => ({ ...(current ?? emptyLive()), content: event.message.content, status: "" }));
        break;
      case "done":
        break;
      case "error":
        throw new Error(event.message);
      default:
        break;
    }
  }, []);

  const finishTurn = useCallback(
    async (conversationId: string) => {
      setLive(null);
      await loadDetail(conversationId, true);
      void loadLists();
    },
    [loadDetail, loadLists],
  );

  const sendMessage = useCallback(
    async (message: string, attachments: MessageAttachment[], options?: ComposerSendOptions) => {
      if (!conversationId) return;
      const authorizationMode = options?.authorizationMode ?? readAuthorizationMode();
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
      setLive(emptyLive());
      try {
        // 1) Streaming NDJSON — rendu en direct du tour complet.
        await streamConversationTurn({
          conversationId,
          message,
          attachments,
          projectId,
          connectors,
          authorizationMode,
          onEvent: consumeEvent,
        });
      } catch (streamError) {
        // 2) Repli : route classique (résultat complet, même persistance).
        try {
          const response = await fetch(`/api/workspace/conversations/${conversationId}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              message,
              attachments,
              projectId,
              ...(connectors.length > 0 ? { connectors } : {}),
              ...(authorizationMode ? { authorizationMode } : {}),
            }),
          });
          if (!response.ok) {
            const data = (await response.json().catch(() => ({}))) as { error?: string };
            throw new Error(data.error ?? (streamError instanceof Error ? streamError.message : "Le message n'a pas pu être traité."));
          }
        } catch (fallbackError) {
          setError(fallbackError instanceof Error ? fallbackError.message : "Le message n'a pas pu être traité.");
          setLive(null);
          setGenerating(false);
          return;
        }
      }
      await finishTurn(conversationId);
      setGenerating(false);
    },
    [conversationId, connectors, consumeEvent, finishTurn, projectId],
  );

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

  // Premier message envoyé depuis l'accueil : transmis via un marqueur de
  // session, consommé ici pour profiter du même rendu en direct.
  useEffect(() => {
    if (!conversationId || loadingDetail || detail === null) return;
    const key = `${PENDING_MESSAGE_PREFIX}${conversationId}`;
    const raw = sessionStorage.getItem(key);
    if (!raw) return;
    sessionStorage.removeItem(key);
    try {
      const pending = JSON.parse(raw) as { message: string; attachments?: MessageAttachment[]; authorizationMode?: AuthorizationMode };
      if (pending.message) void sendMessage(pending.message, pending.attachments ?? [], { authorizationMode: pending.authorizationMode });
    } catch {
      /* marqueur illisible : ignoré */
    }
    // sendMessage est volontairement hors dépendances : le hand-off ne
    // doit se produire qu'une seule fois, au chargement de la conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, loadingDetail, detail === null]);

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
        <div className="grid size-14 place-items-center rounded-2xl bg-[var(--g3-deep)] text-2xl text-white" aria-hidden>
          ✦
        </div>
        <div>
          <h1 className="text-lg font-semibold text-[var(--g3-text)]">Que voulez-vous accomplir ?</h1>
          <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-[var(--g3-muted)]">
            Décrivez un objectif : Gen3ia propose un plan lisible, utilise vos applications connectées
            avec votre validation, et range les livrables (documents, images, rapports, fichiers) dans la conversation.
          </p>
        </div>
        <div className="w-full max-w-xl">
          <Composer
            onSend={async (message, attachments) => {
              // Crée la conversation puis transmet le premier message au
              // nouveau rendu (hand-off) pour le même streaming que la suite.
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
              try {
                sessionStorage.setItem(
                  `${PENDING_MESSAGE_PREFIX}${data.conversation.id}`,
                  JSON.stringify({ message, attachments, authorizationMode: readAuthorizationMode() }),
                );
              } catch {
                /* stockage indisponible : le message sera simplement renvoyé */
              }
              router.push(`/workspace/conversations/${data.conversation.id}`);
              router.refresh();
            }}
            projects={projects}
            projectId={projectId}
            onProjectChange={setProjectId}
            connectors={connectors}
            onConnectorsChange={setConnectors}
            suggestions={STARTER_SUGGESTIONS}
          />
        </div>
      </div>
    ),
    [connectors, projectId, projects, router],
  );

  // Fusion des entités vivantes (tour en cours) avec l'état serveur.
  const mergedRuns = useMemo(
    () => (live?.run && detail ? [...detail.runs.filter((r) => r.id !== live.run?.id), live.run] : detail?.runs ?? []),
    [detail, live],
  );
  const mergedApprovals = useMemo(
    () => (live && live.approvals.length > 0 && detail ? [...detail.approvals, ...live.approvals] : detail?.approvals ?? []),
    [detail, live],
  );
  const mergedArtifacts = useMemo(
    () => (live && live.artifacts.length > 0 && detail ? [...detail.artifacts, ...live.artifacts] : detail?.artifacts ?? []),
    [detail, live],
  );

  return (
    <div className="relative flex h-full min-h-0 gap-2 bg-[var(--g3-surface)] p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:gap-3 sm:p-3">
      {/* Colonne gauche — conversations récentes, projets, recherche */}
      <div
        className={`shrink-0 transition-all ${listCollapsed ? "w-14" : "w-64"} border-r border-[var(--g3-border)] pr-3 max-lg:hidden`}
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
          <div className="mb-2 flex items-center justify-between gap-2 border-b border-[var(--g3-border)] pb-2">
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-[var(--g3-text)]">{detail.conversation.title || "Sans titre"}</h1>
              <p className="text-[11px] text-[var(--g3-muted)]">
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

        <div ref={threadScrollRef} className="flex-1 overflow-y-auto pr-1">
          {loadingDetail ? (
            <div className="space-y-3 py-4" aria-busy>
              {[0, 1, 2].map((i) => (
                <div key={i} className={`h-16 animate-pulse rounded-2xl bg-[var(--g3-elevated)] ${i % 2 ? "ml-auto w-2/3" : "w-3/4"}`} />
              ))}
            </div>
          ) : error && !detail ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="g3-card max-w-md text-center">
                <p className="text-sm font-semibold text-[var(--g3-text)]">{error}</p>
                <p className="mt-1 text-xs text-[var(--g3-muted)]">Choisissez une conversation dans la liste ou créez-en une nouvelle.</p>
              </div>
            </div>
          ) : centerEmpty ? (
            welcome
          ) : detail ? (
            <MessageThread
              messages={detail.messages}
              runs={mergedRuns}
              approvals={mergedApprovals}
              artifacts={mergedArtifacts}
              generating={generating}
              streamingContent={live ? live.content : undefined}
              streamingStatus={live?.status}
              liveRun={live?.run}
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
          <div className="mt-2 border-t border-[var(--g3-border)] pt-2">
            <Composer
              onSend={sendMessage}
              disabled={generating}
              projects={projects}
              projectId={projectId}
              onProjectChange={setProjectId}
              connectors={connectors}
              onConnectorsChange={setConnectors}
              autoFocus
            />
          </div>
        )}
      </div>

      {/* Panneau droit optionnel — plan, outils, validations, livrables
          (desktop uniquement : sur mobile le fil occupe toute la largeur) */}
      <div className={`shrink-0 transition-all max-lg:hidden ${drawerOpen ? "w-80 border-l border-[var(--g3-border)] pl-3" : "w-10"}`}>
        {detail && (
          <ContextDrawer
            open={drawerOpen}
            onToggle={() => setDrawerOpen((open) => !open)}
            conversationTitle={detail.conversation.title}
            project={detail.project}
            runs={mergedRuns}
            approvals={mergedApprovals}
            artifacts={mergedArtifacts}
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
        <h2 className="text-sm font-semibold text-[var(--g3-text)]">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-[var(--g3-muted)]">{description}</p>}
      </div>
      <ArtifactPanel artifacts={artifacts} />
    </section>
  );
}

/** Timeline complète réutilisable (page mission/projet). */
export { RunTimeline, ApprovalCard };
