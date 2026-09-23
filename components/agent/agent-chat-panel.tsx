"use client";

import * as React from "react";

import { CommandComposer, type CommandComposerHandle } from "@/components/ui/command-composer";
import type { MentionItem } from "@/lib/ui/command-composer-helpers";
import { uploadPermanentFiles } from "@/lib/storage/upload-client";
import { Callout } from "@/components/studio/callout";
import { labelForAgent } from "@/lib/agents/charter";
import type { AgentSummary } from "@/lib/agents/schema";
import type { AuthorizationMode } from "@/lib/security/authorization-mode";

/**
 * Chat d'un agent IA personnalisé. Chaque message passe par la classification
 * serveur : réponse claire et simple (mode "chat") ou exécution de la tâche
 * (mode "task"), toujours dans le périmètre strict de l'agent.
 *
 * Interface sombre unifiée : le composer est le CommandComposer commun à tous
 * les chats Gen3ia (réplique de la maquette : @ compétences/connecteurs,
 * / commandes, « Toujours demander ▼ », 🎙, bouton ↑) — à l'identique du chat IA.
 */

type PlanStep = {
  id: string;
  type: string;
  name?: string;
  description?: string;
  toolName?: string;
  status?: string;
};

type Approval = {
  id: string;
  toolSlug: string;
  reason: string;
  status: string;
  expiresAt: number;
  stepId?: string;
};

type AgentResult = {
  mode: "agent";
  status: string;
  executionId: string;
  conversationId?: string;
  plan: { steps: PlanStep[]; maxIterations: number };
  outputs?: Record<string, unknown>;
  approvals?: Approval[];
  error?: string;
  finalText?: string;
};

type Message = {
  id: string;
  role: "user" | "agent";
  text: string;
  mode?: "chat" | "task";
  /** URL d'une image générée par l'agent (Agnes AI), affichée sous le texte. */
  imageUrl?: string;
  result?: AgentResult;
};

type ConversationSummary = {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
};

type MentionConnector = MentionItem;

const QUICK_PROMPTS: Record<string, string[]> = {
  code: ["Corrige ce code et explique chaque correction.", "Crée un composant React réutilisable et documenté.", "Explique-moi cette erreur et comment la résoudre."],
  marketing: ["Prépare une stratégie de lancement pour mon produit.", "Rédige un email de prospection percutant.", "Analyse ma cible et propose un positionnement."],
  research: ["Fais une veille sur un sujet et synthétise les tendances.", "Compare deux solutions et recommande la meilleure.", "Prépare un rapport d'analyse structuré."],
  content: ["Rédige un article de blog optimisé SEO.", "Crée 5 posts LinkedIn sur mon activité.", "Écris un script vidéo de 60 secondes."],
  automation: ["Documente un processus métier étape par étape.", "Propose un workflow de relance client.", "Planifie mes tâches hebdomadaires récurrentes."],
  universal: ["Résume ce document en points clés.", "Réponds à ma question avec un raisonnement structuré.", "Prépare un compte-rendu professionnel."],
  custom: ["Présente ton périmètre et tes compétences.", "Aide-moi sur une tâche de ton domaine.", "Propose un plan d'action adapté à mon besoin."],
};

function statusLabel(status?: string) {
  switch (status) {
    case "completed": return "Terminé";
    case "running": return "En cours";
    case "waiting_approval": return "Confirmation requise";
    case "failed": return "Échec";
    case "cancelled": return "Annulé";
    default: return status ?? "En attente";
  }
}

function statusClass(status?: string) {
  if (status === "completed") return "text-emerald-700";
  if (status === "failed" || status === "blocked") return "text-red-600";
  if (status === "running") return "text-[var(--g3-accent)]";
  if (status === "waiting_approval") return "text-amber-700";
  return "text-[var(--g3-muted)]";
}

function Avatar({ name, size = "md" }: { name: string; size?: "md" | "lg" }) {
  const initial = name.trim().charAt(0).toUpperCase() || "A";
  const dimension = size === "lg" ? "h-14 w-14 text-xl rounded-2xl" : "h-9 w-9 text-sm rounded-xl";
  return <span className={`grid shrink-0 place-items-center bg-gradient-to-br from-indigo-500 to-violet-500 font-semibold text-white shadow-[var(--g3-shadow-sm)] ring-1 ring-inset ring-white/20 ${dimension}`}>{initial}</span>;
}

export function AgentChatPanel({
  agent,
  onEdit,
  onAgentsChanged,
  initialMessage = "",
}: {
  agent: AgentSummary;
  onEdit: () => void;
  onAgentsChanged: () => void;
  initialMessage?: string;
}) {
  const [message, setMessage] = React.useState("");
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [active, setActive] = React.useState<AgentResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [attachment, setAttachment] = React.useState<File | null>(null);
  const [attachmentPath, setAttachmentPath] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [showTrace, setShowTrace] = React.useState(true);
  const [conversations, setConversations] = React.useState<ConversationSummary[]>([]);
  const [showHistory, setShowHistory] = React.useState(false);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  // Sélecteur « @ » : activation de connecteurs dans la conversation.
  const [activated, setActivated] = React.useState<MentionConnector[]>([]);
  // Mode d'autorisation (sélecteur « Toujours demander ▼ » du composer) :
  // appliqué à chaque mission envoyée à /api/agent/chat.
  const [authorizationMode, setAuthorizationMode] = React.useState<AuthorizationMode>("always_ask");
  const composerRef = React.useRef<CommandComposerHandle | null>(null);
  const logRef = React.useRef<HTMLDivElement | null>(null);

  const typeLabel = labelForAgent(agent);
  const quickPrompts = QUICK_PROMPTS[agent.type] ?? QUICK_PROMPTS.custom;

  React.useEffect(() => {
    // Suivi du bas du fil : c'est le CONTENEUR défilant (parent du log,
    // marqué .g3-agent-thread-scroll) qui doit défiler — le log lui-même
    // ne défile pas. Indispensable en chat plein écran (h-[100dvh]).
    const node = logRef.current;
    if (!node) return;
    const scroller = node.closest<HTMLElement>(".g3-agent-thread-scroll");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [messages, loading]);

  const loadConversations = React.useCallback(async () => {
    setHistoryLoading(true);
    try {
      const response = await fetch("/api/chat/conversations?limit=20", { cache: "no-store" });
      if (response.ok) setConversations(((await response.json()).conversations ?? []) as ConversationSummary[]);
    } catch { /* historique indisponible */ } finally {
      setHistoryLoading(false);
    }
  }, []);

  React.useEffect(() => { void loadConversations(); }, [loadConversations]);

  // Nouvelle conversation à chaque changement d'agent : le contexte du chat
  // appartient à l'agent sélectionné.
  React.useEffect(() => {
    setConversationId(null);
    setMessages([]);
    setActive(null);
    setError("");
  }, [agent.id]);

  React.useEffect(() => {
    if (initialMessage.trim() && !message.trim()) setMessage(initialMessage.trim());
  }, [initialMessage, message]);

  async function loadMentions(query: string): Promise<MentionConnector[]> {
    try {
      const response = await fetch(`/api/integrations/mention?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      const data = await response.json();
      return (data.connectors ?? []) as MentionConnector[];
    } catch {
      return [];
    }
  }

  function activateConnector(connector: MentionConnector) {
    setActivated((current) => current.some((item) => item.toolkit === connector.toolkit) ? current : [...current, connector]);
  }

  function deactivateConnector(toolkit: string) {
    setActivated((current) => current.filter((item) => item.toolkit !== toolkit));
  }

  async function openConversation(id: string) {
    if (loading) return;
    setError("");
    setHistoryLoading(true);
    try {
      const response = await fetch(`/api/chat/conversations/${id}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Conversation introuvable.");
      const items = ((data.messages ?? []) as Array<{ id: string; role: string; content: string; imageUrl?: string }>).map((item): Message => ({
        id: item.id,
        role: item.role === "user" ? "user" : "agent",
        text: item.content,
        imageUrl: item.imageUrl,
      }));
      setConversationId(id);
      setActive(null);
      setMessages(items);
      setShowHistory(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conversation introuvable.");
    } finally { setHistoryLoading(false); }
  }

  function resetConversation() {
    if (loading) return;
    setConversationId(null);
    setMessages([]);
    setActive(null);
    setError("");
    setAttachment(null);
    setAttachmentPath(null);
    setMessage("");
  }

  async function handleAttachment(file: File) {
    setAttachment(file);
    setAttachmentPath(null);
    setError("");
    setUploading(true);
    try {
      const result = await uploadPermanentFiles([file]);
      const uploaded = result.uploaded[0];
      if (!uploaded) throw new Error(result.failed[0]?.error || "Téléversement impossible.");
      const path = uploaded.path || uploaded.filename;
      if (!path) throw new Error("Le stockage n'a pas retourné le chemin du fichier.");
      setAttachmentPath(path);
    } catch (e) {
      setAttachment(null);
      setError(e instanceof Error ? e.message : "Le fichier n'a pas pu être téléversé.");
    } finally {
      setUploading(false);
    }
  }

  async function sendMessage(objective: string) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: objective,
          agentId: agent.id,
          authorizationMode,
          ...(conversationId ? { conversationId } : {}),
          ...(attachmentPath ? { attachmentPath, attachmentName: attachment?.name } : {}),
          ...(activated.length > 0 ? { activatedConnectors: activated.map((item) => item.toolkit) } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "L'agent n'a pas pu répondre.");

      if (data.conversationId) setConversationId(data.conversationId);

      if (data.mode === "chat") {
        setMessages((items) => [...items, {
          id: crypto.randomUUID(),
          role: "agent",
          text: String(data.reply ?? ""),
          ...(data.imageUrl ? { imageUrl: String(data.imageUrl) } : {}),
          mode: "chat",
        }]);
        setActive(null);
      } else {
        const result = data as AgentResult;
        setActive(result);
        setMessages((items) => [...items, {
          id: crypto.randomUUID(),
          role: "agent",
          text: result.finalText
            || (result.status === "waiting_approval"
              ? "J'ai préparé le plan d'exécution et mis les actions sensibles en attente de votre confirmation."
              : result.status === "completed"
                ? "Mission terminée. Les résultats affichés correspondent aux étapes réellement exécutées."
                : "Mission en cours d'exécution dans mon périmètre."),
          mode: "task",
          result,
        }]);
      }
      void loadConversations();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur de l'agent.");
    } finally {
      setLoading(false);
    }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const objective = message.trim();
    if (!objective || loading) return;
    setMessages((items) => [...items, { id: crypto.randomUUID(), role: "user", text: objective }]);
    setMessage("");
    void sendMessage(objective);
  }

  async function decideApproval(approvalId: string, action: "approve" | "reject") {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/agent/chat/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId, action }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Approbation impossible.");
      if (data.conversationId) setConversationId(data.conversationId);
      const result = data as AgentResult;
      setActive(result);
      setMessages((items) => [...items, {
        id: crypto.randomUUID(),
        role: "agent",
        text: result.finalText
          || (result.status === "waiting_approval"
            ? "Une autre autorisation est nécessaire avant de continuer."
            : "Autorisation appliquée. J'ai repris l'exécution et vérifié le résultat."),
        mode: "task",
        result,
      }]);
      void loadConversations();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur pendant l'approbation.");
    } finally {
      setLoading(false);
    }
  }

  const pendingApprovals = (active?.approvals ?? []).filter((item) => item.status === "pending");

  const composerCommands = React.useMemo(() => ([
    {
      id: "nouvelle",
      label: "Nouvelle conversation",
      description: "Repart d'un fil vierge avec cet agent.",
      run: () => resetConversation(),
    },
    {
      id: "historique",
      label: "Historique",
      description: "Rouvre une conversation passée avec vos agents.",
      run: () => { void loadConversations(); setShowHistory(true); },
    },
    {
      id: "personnaliser",
      label: "Personnaliser cet agent",
      description: "Compétences, mémoire, nature et type de l'agent.",
      run: () => onEdit(),
    },
    {
      id: "connecteurs",
      label: "Choisir des connecteurs",
      description: "Active une application connectée pour cette conversation (@).",
      run: () => composerRef.current?.openMentions(),
    },
    {
      id: "fichier",
      label: "Joindre un fichier",
      description: "Image, PDF, ZIP ou document texte téléversé dans votre espace.",
      run: () => composerRef.current?.openFilePicker(),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stables du composant
  ]), [agent.id]);

  return (
    // Chat PLEIN ÉCRAN : la section remplit toute la hauteur disponible
    // (100dvh via la chaîne AppShell → layout → atelier) ; le fil défile
    // en interne (flex-1 + min-h-0) et le composer reste collé en bas.
    <section
      className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--g3-radius-lg)] border border-[var(--g3-border)] bg-[var(--g3-surface)] shadow-[var(--g3-shadow-sm)]"
      aria-label={`Chat avec ${agent.name}`}
    >

      {/* En-tête : identité de l'agent */}
      <header className="relative flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--g3-border)] px-4 py-3.5 md:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative">
            <Avatar name={agent.name} />
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-sm font-bold text-[var(--g3-ink)]">{agent.name}</h2>
              <span className="rounded-full border border-indigo-200 bg-[var(--g3-accent-soft)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--g3-accent-hover)]">{typeLabel}</span>
              <span className="rounded-full border border-[var(--g3-border)] bg-[var(--g3-bg)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--g3-muted)]">{agent.agentMode === "call" ? "Agent d'appel" : "Agent standard"}</span>
            </div>
            <p className="mt-0.5 hidden truncate text-[11px] text-[var(--g3-muted)] sm:block">{agent.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onEdit} className="g3-btn g3-btn-ghost !h-8 !px-3 text-xs">Personnaliser</button>
          <button type="button" onClick={() => { void loadConversations(); setShowHistory((current) => !current); }} aria-expanded={showHistory} className="g3-btn g3-btn-ghost !h-8 !px-3 text-xs">Historique</button>
          <button type="button" onClick={resetConversation} disabled={loading} className="g3-btn g3-btn-ghost !h-8 !px-3 text-xs disabled:opacity-30">Nouveau</button>
        </div>
      </header>

      {agent.skills.length > 0 && (
        <div className="relative flex shrink-0 flex-wrap gap-1.5 border-b border-[var(--g3-border)] bg-[var(--g3-bg)] px-4 py-2.5 md:px-5" aria-label="Compétences de l'agent">
          {agent.skills.slice(0, 8).map((skill) => (
            <span key={skill} className="rounded-full border border-[var(--g3-border)] bg-[var(--g3-surface-2)] px-2.5 py-1 text-[10px] font-medium text-[var(--g3-ink-2)]">{skill}</span>
          ))}
          {agent.skills.length > 8 && <span className="rounded-full px-2 py-1 text-[10px] text-[var(--g3-muted)]">+{agent.skills.length - 8}</span>}
          {agent.memoryFile && (
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10.5px] font-medium text-emerald-700">Mémoire : {agent.memoryFile.name}</span>
          )}
        </div>
      )}

      {showHistory && (
        <div className="relative shrink-0 border-b border-[var(--g3-border)] bg-[var(--g3-bg)] px-4 py-3 md:px-5" role="region" aria-label="Historique des conversations">
          {historyLoading && conversations.length === 0 ? (
            <p className="text-xs text-[var(--g3-muted)]">Chargement de l&apos;historique…</p>
          ) : conversations.length === 0 ? (
            <p className="text-xs text-[var(--g3-muted)]">Aucune conversation enregistrée pour le moment.</p>
          ) : (
            <ul className="grid max-h-56 gap-1.5 overflow-y-auto">
              {conversations.map((conversation) => (
                <li key={conversation.id} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openConversation(conversation.id)}
                    className={`min-w-0 flex-1 rounded-xl px-3 py-2 text-left text-xs transition ${conversation.id === conversationId ? "bg-[var(--g3-surface)] text-[var(--g3-ink)] shadow-[var(--g3-shadow-sm)] ring-1 ring-[var(--g3-border)]" : "text-[var(--g3-ink-2)] hover:bg-[var(--g3-surface-2)]"}`}
                  >
                    <span className="block truncate font-semibold">{conversation.title || "Sans titre"}</span>
                    <span className="block text-[10px] text-[var(--g3-muted)]">{conversation.messageCount} message{conversation.messageCount > 1 ? "s" : ""} · {new Date(conversation.updatedAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Fil de conversation — défile en interne sur toute la hauteur restante
          (plus de plafond arbitraire 58vh ni de hauteur minimale fixe) */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="g3-agent-thread-scroll min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
          {messages.length === 0 && (
            <div className="flex min-h-[380px] items-center justify-center">
              <div className="w-full max-w-2xl text-center">
                <div className="relative mx-auto grid h-20 w-20 place-items-center rounded-[22px] border border-[var(--g3-border)] bg-[var(--g3-bg)] shadow-[var(--g3-shadow-md)]">
                  <Avatar name={agent.name} size="lg" />
                </div>
                <h3 className="mt-5 text-2xl font-semibold tracking-[-0.03em] text-[var(--g3-ink)] md:text-[28px]">Bonjour, je suis {agent.name}.</h3>
                <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-[var(--g3-muted)]">
                  {agent.description || "Votre agent IA personnalisé."} Je réponds de manière professionnelle et j&apos;exécute vos tâches{" "}
                  <strong className="font-medium text-[var(--g3-ink)]">exclusivement dans mon domaine : {typeLabel}</strong>.
                </p>
                <div className="mt-6 grid gap-2 sm:grid-cols-2">
                  {quickPrompts.map((prompt) => (
                    <button key={prompt} type="button" onClick={() => { setMessage(prompt); composerRef.current?.focus(); }} className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-3.5 text-left text-[13px] leading-5 text-[var(--g3-ink-2)] shadow-[var(--g3-shadow-xs)] transition-[border-color,box-shadow,color] hover:border-[var(--g3-border-strong)] hover:text-[var(--g3-ink)] hover:shadow-[var(--g3-shadow-md)]">
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div ref={logRef} className="mx-auto max-w-3xl space-y-5" role="log" aria-live="polite" aria-label="Fil de conversation avec l'agent">
            {messages.map((item) => (
              <div key={item.id} className={item.role === "user" ? "ml-auto max-w-[88%] md:max-w-[78%]" : "mr-auto max-w-[96%]"}>
                <div className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-[var(--g3-muted)]">
                  <span>{item.role === "user" ? "Vous" : agent.name}</span>
                  {item.role === "agent" && item.mode === "chat" && (
                    <span className="rounded-full border border-[var(--g3-border)] bg-[var(--g3-surface-2)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--g3-muted)]">Réponse directe</span>
                  )}
                  {item.role === "agent" && item.mode === "task" && (
                    <span className="rounded-full border border-[var(--g3-border-strong)] bg-[var(--g3-surface-2)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--g3-accent)]">Mission exécutée</span>
                  )}
                </div>
                <div className={item.role === "user"
                  ? "whitespace-pre-wrap rounded-[18px] rounded-br-md bg-[var(--g3-surface-2)] px-4 py-2.5 text-[14.5px] leading-relaxed text-[var(--g3-ink)]"
                  : "whitespace-pre-wrap text-[14.5px] leading-7 text-[var(--g3-ink-2)]"}>{item.text}</div>

                {/* Image générée par l'agent (Agnes AI) — cliquable en plein écran. */}
                {item.imageUrl && (
                  <a href={item.imageUrl} target="_blank" rel="noopener noreferrer" className="mt-2 block overflow-hidden rounded-2xl border border-[var(--g3-border)] shadow-[var(--g3-shadow-sm)]" aria-label="Ouvrir l'image générée en plein écran">
                    {/* eslint-disable-next-line @next/next/no-img-element -- URL externe (CDN Agnes) signée par le provider, pas de domaine fixe pour next/image */}
                    <img src={item.imageUrl} alt="Image générée par IA" loading="lazy" className="max-h-96 w-auto max-w-full bg-[var(--g3-bg)] object-contain" />
                  </a>
                )}

                {/* Trace d'exécution + approbations (mode task uniquement) */}
                {item.result && (
                  <div className="mt-3 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-3 shadow-[var(--g3-shadow-xs)]">
                    <button type="button" onClick={() => setShowTrace((current) => !current)} aria-expanded={showTrace} className="flex w-full items-center justify-between text-[12px] font-medium text-[var(--g3-ink-2)] hover:text-[var(--g3-ink)]">
                      <span>Plan d&apos;exécution · {statusLabel(item.result.status)}</span>
                      <span aria-hidden="true">{showTrace ? "−" : "+"}</span>
                    </button>
                    {showTrace && (
                      <ol className="mt-2 space-y-1.5">
                        {item.result.plan.steps.map((step) => (
                          <li key={step.id} className="flex items-start gap-2 text-xs">
                            <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${step.status === "completed" ? "bg-emerald-500" : step.status === "failed" ? "bg-red-500" : step.status === "waiting_approval" ? "bg-amber-500" : "bg-neutral-300"}`} aria-hidden="true" />
                            <span className="min-w-0">
                              <span className="block truncate font-medium text-[var(--g3-ink)]">{step.name || step.id}</span>
                              {step.toolName && <span className="block text-[10px] text-[var(--g3-muted)]">Outil : {step.toolName}</span>}
                            </span>
                            <span className={`ml-auto shrink-0 text-[10px] font-semibold ${statusClass(step.status)}`}>{statusLabel(step.status)}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                    {item.result.status === "waiting_approval" && pendingApprovals.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {pendingApprovals.map((approval) => (
                          <div key={approval.id} className="rounded-xl border border-amber-300 bg-amber-50 p-3 ring-4 ring-amber-100/60">
                            <p className="text-xs font-semibold text-amber-900">Action sensible : {approval.toolSlug}</p>
                            {approval.reason && <p className="mt-0.5 text-[11px] leading-5 text-amber-800">{approval.reason}</p>}
                            <div className="mt-2 flex gap-2">
                              <button type="button" onClick={() => void decideApproval(approval.id, "approve")} disabled={loading} className="g3-btn g3-btn-primary !h-8 text-xs disabled:opacity-40">Approuver</button>
                              <button type="button" onClick={() => void decideApproval(approval.id, "reject")} disabled={loading} className="g3-btn g3-btn-ghost !h-8 text-xs disabled:opacity-40">Rejeter</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}

            {loading && (
              <div className="mr-auto flex items-center gap-3 px-1 py-2 text-[13px] text-[var(--g3-muted)]">
                <span className="flex gap-1" aria-hidden="true"><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--g3-accent)]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-indigo-300 [animation-delay:120ms]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--g3-accent)] [animation-delay:240ms]" /></span>
                J&apos;analyse votre demande — réponse ou exécution selon le besoin…
              </div>
            )}
          </div>
        </div>

        {/* Zone de saisie : CommandComposer unifié (identique au chat IA) —
            collée en bas, au-dessus de la zone sûre (encoche/barre iOS) */}
        <div className="shrink-0 border-t border-[var(--g3-border)] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:p-4 md:pb-[max(1rem,env(safe-area-inset-bottom))]">
          {error && <Callout tone="error" className="mb-3 rounded-2xl">{error}</Callout>}
          <CommandComposer
            ref={composerRef}
            value={message}
            onValueChange={setMessage}
            onSubmit={submit}
            disabled={loading || uploading}
            maxLength={20_000}
            placeholder="Posez n'importe quelle question… Tapez @ pour mentionner des compétences ou connecteurs, ou / pour les commandes"
            loadMentions={loadMentions}
            activatedMentions={activated}
            onActivateMention={activateConnector}
            onDeactivateMention={deactivateConnector}
            commands={composerCommands}
            plusAction="file"
            attachmentName={attachment?.name ?? null}
            attachmentUploading={uploading}
            onRemoveAttachment={() => { setAttachment(null); setAttachmentPath(null); }}
            onFile={(file) => void handleAttachment(file)}
            authorizationMode={authorizationMode}
            onAuthorizationModeChange={setAuthorizationMode}
          />
          <p className="mt-2 text-center text-[10px] text-[var(--g3-muted)]">
            {agent.name} répond et agit uniquement en {typeLabel.toLowerCase()} · Entrée envoie · Maj+Entrée nouvelle ligne
          </p>
        </div>
      </div>
    </section>
  );
}
