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
import { NavIcon } from "@/components/ui/nav-icon";
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

const STARTER_CARDS = [
  { icon: "∿", title: "Analyser des données", prompt: "Analyse mes ventes du mois et rédige un compte rendu" },
  { icon: "◷", title: "Préparer un point", prompt: "Prépare un point hebdo à partir de mes notes" },
  { icon: "□", title: "Produire un rapport", prompt: "Crée un rapport de suivi avec les prochaines échéances" },
  { icon: "✦", title: "Faire une veille", prompt: "Recherche les dernières tendances de mon marché" },
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
  const [starterPrompt, setStarterPrompt] = useState<{ text: string; n: number } | undefined>(undefined);
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  // Défilement « collant » : on ne suit le bas du fil que si l'utilisateur
  // y est déjà — s'il remonte lire, on ne lui arrache pas la lecture.
  const stickToBottomRef = useRef(true);

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
    if (!container || !stickToBottomRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [detail?.messages.length, live?.content, live?.run, live?.status]);

  // Nouvelle conversation : on repart du bas et on ferme le tiroir mobile.
  useEffect(() => {
    stickToBottomRef.current = true;
    setMobileListOpen(false);
  }, [conversationId]);

  const onThreadScroll = useCallback(() => {
    const container = threadScrollRef.current;
    if (!container) return;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    stickToBottomRef.current = distance < 80;
    setShowScrollDown(distance > 240);
  }, []);

  const scrollToBottom = useCallback(() => {
    const container = threadScrollRef.current;
    if (!container) return;
    stickToBottomRef.current = true;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, []);

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
      <div className="flex min-h-full flex-1 flex-col items-center justify-center gap-8 px-4 py-10 text-center">
        <div className="anim-fade-up">
          <div className="mx-auto grid size-11 place-items-center rounded-xl bg-[var(--g3-ink)] text-[11px] font-bold text-white shadow-[var(--g3-shadow-md)]" aria-hidden>
            G3
          </div>
          <h1 className="mt-5 text-[28px] font-semibold tracking-[-0.03em] text-[var(--g3-ink)] sm:text-[32px]">Que voulez-vous accomplir ?</h1>
          <p className="mx-auto mt-2 max-w-lg text-[14.5px] leading-relaxed text-[var(--g3-muted)]">
            Décrivez un objectif. Gen3ia propose un plan, agit sur vos applications avec votre accord
            et range les livrables dans la conversation.
          </p>
        </div>
        <div className="anim-fade-up anim-delay-1 w-full max-w-2xl text-left">
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
            autoFocus
            prefill={starterPrompt}
          />
        </div>
        <div className="anim-fade-up anim-delay-2 grid w-full max-w-2xl gap-2 sm:grid-cols-2">
          {STARTER_CARDS.map((card) => (
            <button
              key={card.prompt}
              type="button"
              onClick={() => setStarterPrompt((current) => ({ text: card.prompt, n: (current?.n ?? 0) + 1 }))}
              className="group flex items-start gap-3 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-3.5 text-left shadow-[var(--g3-shadow-xs)] transition-[border-color,box-shadow] hover:border-[var(--g3-border-strong)] hover:shadow-[var(--g3-shadow-md)]"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--g3-surface-2)] text-[var(--g3-muted)] transition-colors group-hover:bg-[var(--g3-accent-soft)] group-hover:text-[var(--g3-accent)]">
                <NavIcon glyph={card.icon} size={15} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-[var(--g3-ink)]">{card.title}</span>
                <span className="mt-0.5 block text-[12px] leading-snug text-[var(--g3-muted)]">{card.prompt}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    ),
    [connectors, projectId, projects, router, starterPrompt],
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
    <div className="relative flex h-full min-h-0 bg-[var(--g3-bg)] pb-[env(safe-area-inset-bottom)]">
      {/* Colonne gauche — conversations récentes, projets, recherche */}
      <div
        className={`shrink-0 border-r border-[var(--g3-border)] bg-[var(--g3-bg)] px-2 py-3 transition-[width] duration-200 max-lg:hidden ${listCollapsed ? "w-14" : "w-72"}`}
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

      {/* Tiroir mobile de la liste */}
      {mobileListOpen && (
        <div className="fixed inset-0 z-[70] lg:hidden" role="dialog" aria-modal="true" aria-label="Conversations">
          <button type="button" aria-label="Fermer" className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={() => setMobileListOpen(false)} />
          <div className="anim-slide-in-right absolute inset-y-0 left-0 w-[86vw] max-w-80 border-r border-[var(--g3-border)] bg-[var(--g3-surface)] px-2 py-3 shadow-[var(--g3-shadow-lg)]">
            <ConversationList
          conversations={conversations}
          projects={projects}
          activeConversationId={conversationId}
          loading={loadingList}
          onNewConversation={() => void createConversation()}
          query={query}
          onQueryChange={setQuery}
              collapsed={false}
              onToggleCollapsed={() => setMobileListOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Colonne centrale — conversation */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--g3-border)] bg-[var(--g3-bg)]/85 px-3 backdrop-blur-md sm:px-5 max-lg:pl-14">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setMobileListOpen(true)}
              className="g3-btn g3-btn-ghost !h-8 !w-8 !px-0 lg:hidden"
              aria-label="Afficher les conversations"
            >
              <NavIcon glyph="✦" size={15} href="/workspace" />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-[14px] font-semibold text-[var(--g3-ink)]">
                {detail ? detail.conversation.title || "Sans titre" : "Nouvelle conversation"}
              </h1>
              {detail && (
                <p className="flex items-center gap-1.5 truncate text-[11.5px] text-[var(--g3-muted)]">
                  {detail.project ? (
                    <span className="inline-flex items-center gap-1"><span aria-hidden className="size-1.5 rounded-[2px] bg-[var(--g3-accent)]" />{detail.project.name}</span>
                  ) : (
                    "Sans projet"
                  )}
                  {detail.messages.length > 0 && <span className="tabular-nums">· {detail.messages.length} messages</span>}
                  {generating && <span className="inline-flex items-center gap-1 text-[var(--g3-accent)]">· <span className="size-1.5 animate-pulse rounded-full bg-current" />en cours</span>}
                </p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {detail && (
              <button
                type="button"
                onClick={() => void createConversation()}
                className="g3-btn g3-btn-ghost !h-8 !px-2.5 text-xs max-sm:!w-8 max-sm:!px-0"
                title="Nouvelle conversation"
                aria-label="Nouvelle conversation"
              >
                <NavIcon glyph="＋" size={14} />
                <span className="max-sm:hidden">Nouvelle</span>
              </button>
            )}
            {detail && (
              <button
                type="button"
                onClick={() => setDrawerOpen((open) => !open)}
                aria-pressed={drawerOpen}
                className={`g3-btn !h-8 !px-2.5 text-xs max-lg:hidden ${drawerOpen ? "g3-btn-cyan" : "g3-btn-ghost"}`}
                title="Plan, outils, validations et livrables"
              >
                <NavIcon glyph="⧉" size={14} href="/integrations" />
                Contexte
                {mergedApprovals.some((a) => a.status === "pending") && (
                  <span className="size-1.5 rounded-full bg-amber-500" aria-label="Validation en attente" />
                )}
              </button>
            )}
          </div>
        </header>

        <div ref={threadScrollRef} onScroll={onThreadScroll} className="g3-scroll relative flex-1 overflow-y-auto">
          <div className={`mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 sm:px-6 ${detail ? "pb-6 pt-6" : ""}`}>
            {loadingDetail ? (
              <div className="space-y-6 py-4" aria-busy aria-label="Chargement de la conversation">
                {[0, 1, 2].map((i) => (
                  <div key={i} className={i % 2 ? "ml-auto h-12 w-2/3 rounded-2xl g3-skeleton" : "flex gap-3"}>
                    {i % 2 ? null : (
                      <>
                        <div className="g3-skeleton size-7 shrink-0 rounded-lg" />
                        <div className="flex-1 space-y-2 pt-1">
                          <div className="g3-skeleton h-3 w-4/5 rounded-full" />
                          <div className="g3-skeleton h-3 w-3/5 rounded-full" />
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            ) : error && !detail ? (
              <div className="flex flex-1 items-center justify-center py-16">
                <div className="g3-card max-w-md p-6 text-center">
                  <p className="text-sm font-semibold text-[var(--g3-ink)]">{error}</p>
                  <p className="mt-1 text-[13px] text-[var(--g3-muted)]">Choisissez une conversation dans la liste ou créez-en une nouvelle.</p>
                  <button type="button" onClick={() => void createConversation()} className="g3-btn g3-btn-primary mt-4">Nouvelle conversation</button>
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
        </div>

        {detail && (
          <div className="relative shrink-0 px-4 pb-3 sm:px-6">
            <div className="g3-thread-fade pointer-events-none absolute inset-x-0 -top-8 h-8" aria-hidden />
            {showScrollDown && (
              <button
                type="button"
                onClick={scrollToBottom}
                className="anim-scale-in absolute -top-12 left-1/2 z-10 grid size-8 -translate-x-1/2 place-items-center rounded-full border border-[var(--g3-border-strong)] bg-[var(--g3-surface)] text-[var(--g3-ink-2)] shadow-[var(--g3-shadow-md)] transition hover:text-[var(--g3-ink)]"
                aria-label="Revenir au dernier message"
              >
                <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
              </button>
            )}
            <div className="mx-auto w-full max-w-3xl">
              {error && (
                <div className="mb-2 flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700" role="alert">
                  <span>{error}</span>
                  <button type="button" onClick={() => setError("")} className="shrink-0 text-red-500 hover:text-red-700" aria-label="Fermer le message d'erreur">✕</button>
                </div>
              )}
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
              <p className="mt-2 text-center text-[11px] text-[var(--g3-subtle)]">
                Les actions sensibles attendent toujours votre validation · Entrée pour envoyer, Maj+Entrée pour une nouvelle ligne
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Panneau droit — plan, outils, validations, livrables (desktop) */}
      {detail && drawerOpen && (
        <div className="anim-slide-in-right w-80 shrink-0 overflow-y-auto border-l border-[var(--g3-border)] bg-[var(--g3-surface)] p-3 max-lg:hidden">
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
        </div>
      )}
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
