"use client";

import * as React from "react";

import { PromptBox } from "@/components/ui/chatgpt-prompt-input";
import { uploadPermanentFiles } from "@/lib/storage/upload-client";
import { Callout } from "@/components/studio/callout";
import { labelForAgent } from "@/lib/agents/charter";
import type { AgentSummary } from "@/lib/agents/schema";

/**
 * Chat d'un agent IA personnalisé. Chaque message passe par la classification
 * serveur : réponse claire et simple (mode "chat") ou exécution de la tâche
 * (mode "task"), toujours dans le périmètre strict de l'agent.
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
  result?: AgentResult;
};

type ConversationSummary = {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
};

type MentionConnector = {
  toolkit: string;
  label: string;
  description: string;
  category: string;
  connected: boolean;
};

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
  if (status === "completed") return "text-emerald-600";
  if (status === "failed" || status === "blocked") return "text-red-600";
  if (status === "running") return "text-sky-700";
  if (status === "waiting_approval") return "text-amber-700";
  return "text-neutral-400";
}

function Avatar({ name, size = "md" }: { name: string; size?: "md" | "lg" }) {
  const initial = name.trim().charAt(0).toUpperCase() || "A";
  const dimension = size === "lg" ? "h-14 w-14 text-xl" : "h-9 w-9 text-sm";
  return <span className={`grid shrink-0 place-items-center rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-100 to-sky-100 font-serif font-bold text-violet-700 ${dimension}`}>{initial}</span>;
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
  const [isListening, setIsListening] = React.useState(false);
  const [showTrace, setShowTrace] = React.useState(true);
  const [conversations, setConversations] = React.useState<ConversationSummary[]>([]);
  const [showHistory, setShowHistory] = React.useState(false);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  // Sélecteur « @ » : activation de connecteurs dans la conversation.
  const [activated, setActivated] = React.useState<MentionConnector[]>([]);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pickerManual, setPickerManual] = React.useState(false);
  const [pickerQuery, setPickerQuery] = React.useState("");
  const [pickerItems, setPickerItems] = React.useState<MentionConnector[]>([]);
  const [pickerLoading, setPickerLoading] = React.useState(false);
  const logRef = React.useRef<HTMLDivElement | null>(null);

  const typeLabel = labelForAgent(agent);
  const quickPrompts = QUICK_PROMPTS[agent.type] ?? QUICK_PROMPTS.custom;

  React.useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
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

  // Détection de « @ » en fin de saisie : ouvre le sélecteur de connecteurs.
  const mentionMatch = /(?:^|\s)@([a-z0-9_-]{0,32})$/i.exec(message);
  React.useEffect(() => {
    if (pickerManual) return;
    if (mentionMatch) {
      setPickerOpen(true);
      setPickerQuery(mentionMatch[1]);
    } else {
      setPickerOpen(false);
      setPickerQuery("");
    }
  }, [mentionMatch, pickerManual]);

  React.useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setPickerLoading(true);
      try {
        const response = await fetch(`/api/integrations/mention?q=${encodeURIComponent(pickerQuery)}`, { cache: "no-store" });
        const data = await response.json();
        if (!cancelled) setPickerItems(((data.connectors ?? []) as MentionConnector[]));
      } catch {
        if (!cancelled) setPickerItems([]);
      } finally {
        if (!cancelled) setPickerLoading(false);
      }
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pickerOpen, pickerQuery]);

  function activateConnector(connector: MentionConnector) {
    setActivated((current) => current.some((item) => item.toolkit === connector.toolkit) ? current : [...current, connector]);
    if (mentionMatch) setMessage((current) => current.replace(/@([a-z0-9_-]{0,32})$/i, "").trimEnd());
    setPickerManual(false);
    setPickerOpen(false);
    setPickerQuery("");
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
      const items = ((data.messages ?? []) as Array<{ id: string; role: string; content: string }>).map((item): Message => ({
        id: item.id,
        role: item.role === "user" ? "user" : "agent",
        text: item.content,
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

  function startVoice() {
    type Recognition = {
      lang: string;
      continuous: boolean;
      interimResults: boolean;
      start: () => void;
      stop: () => void;
      onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
      onend: (() => void) | null;
      onerror: (() => void) | null;
    };
    type RecognitionConstructor = new () => Recognition;
    const speechWindow = window as unknown as {
      SpeechRecognition?: RecognitionConstructor;
      webkitSpeechRecognition?: RecognitionConstructor;
    };
    const SpeechRecognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError("La saisie vocale n'est pas disponible dans ce navigateur.");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = "fr-FR";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results).map((result) => result[0]?.transcript ?? "").join(" ");
      setMessage((current) => current ? current + " " + transcript : transcript);
    };
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => {
      setIsListening(false);
      setError("La saisie vocale a rencontré un problème.");
    };
    setIsListening(true);
    recognition.start();
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

  return (
    <section className="relative overflow-hidden rounded-[30px] border border-[rgba(23,23,20,0.09)] bg-white shadow-[0_14px_40px_-18px_rgba(28,27,24,0.22)]" aria-label={`Chat avec ${agent.name}`}>
      <div className="pointer-events-none absolute -left-32 -top-32 h-72 w-72 rounded-full bg-violet-100 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-20 h-80 w-80 rounded-full bg-sky-100 blur-3xl" />

      {/* En-tête : identité de l'agent */}
      <header className="relative flex flex-wrap items-center justify-between gap-3 border-b border-[rgba(23,23,20,0.09)] px-4 py-3.5 md:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative">
            <Avatar name={agent.name} />
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-sm font-bold text-neutral-900">{agent.name}</h2>
              <span className="rounded-full border border-violet-200 bg-violet-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-violet-700">{typeLabel}</span>
              <span className="rounded-full border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-neutral-600">{agent.agentMode === "call" ? "Agent d'appel" : "Agent standard"}</span>
            </div>
            <p className="mt-0.5 hidden truncate text-[11px] text-neutral-500 sm:block">{agent.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onEdit} className="rounded-xl border border-[rgba(23,23,20,0.09)] px-3 py-2 text-[11px] text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900">Personnaliser</button>
          <button type="button" onClick={() => { void loadConversations(); setShowHistory((current) => !current); }} aria-expanded={showHistory} className="rounded-xl border border-[rgba(23,23,20,0.09)] px-3 py-2 text-[11px] text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900">Historique</button>
          <button type="button" onClick={resetConversation} disabled={loading} className="rounded-xl border border-[rgba(23,23,20,0.09)] px-3 py-2 text-[11px] text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-30">Nouveau</button>
        </div>
      </header>

      {agent.skills.length > 0 && (
        <div className="relative flex flex-wrap gap-1.5 border-b border-[rgba(23,23,20,0.09)] bg-neutral-50/60 px-4 py-2.5 md:px-5" aria-label="Compétences de l'agent">
          {agent.skills.slice(0, 8).map((skill) => (
            <span key={skill} className="rounded-full border border-[rgba(23,23,20,0.09)] bg-white px-2.5 py-1 text-[10px] font-medium text-neutral-600">{skill}</span>
          ))}
          {agent.skills.length > 8 && <span className="rounded-full px-2 py-1 text-[10px] text-neutral-400">+{agent.skills.length - 8}</span>}
          {agent.memoryFile && (
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-medium text-emerald-700">Mémoire : {agent.memoryFile.name}</span>
          )}
        </div>
      )}

      {showHistory && (
        <div className="relative border-b border-[rgba(23,23,20,0.09)] bg-neutral-50/70 px-4 py-3 md:px-5" role="region" aria-label="Historique des conversations">
          {historyLoading && conversations.length === 0 ? (
            <p className="text-xs text-neutral-400">Chargement de l&apos;historique…</p>
          ) : conversations.length === 0 ? (
            <p className="text-xs text-neutral-400">Aucune conversation enregistrée pour le moment.</p>
          ) : (
            <ul className="grid max-h-56 gap-1.5 overflow-y-auto">
              {conversations.map((conversation) => (
                <li key={conversation.id} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openConversation(conversation.id)}
                    className={`min-w-0 flex-1 rounded-xl px-3 py-2 text-left text-xs transition ${conversation.id === conversationId ? "bg-sky-100 text-sky-800" : "bg-white text-neutral-700 hover:bg-neutral-100"}`}
                  >
                    <span className="block truncate font-semibold">{conversation.title || "Sans titre"}</span>
                    <span className="block text-[10px] text-neutral-400">{conversation.messageCount} message{conversation.messageCount > 1 ? "s" : ""} · {new Date(conversation.updatedAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Fil de conversation */}
      <div className="relative flex min-h-[520px] flex-col">
        <div className="flex-1 overflow-y-auto p-4 md:p-5" style={{ maxHeight: "58vh" }}>
          {messages.length === 0 && (
            <div className="flex min-h-[380px] items-center justify-center">
              <div className="w-full max-w-2xl text-center">
                <div className="relative mx-auto grid h-20 w-20 place-items-center rounded-[24px] border border-violet-200 bg-gradient-to-br from-violet-100 to-sky-100 shadow-xl shadow-violet-100/60">
                  <Avatar name={agent.name} size="lg" />
                </div>
                <h3 className="mt-5 font-serif text-2xl font-bold tracking-tight text-neutral-900 md:text-3xl">Bonjour, je suis {agent.name}.</h3>
                <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-neutral-500">
                  {agent.description || "Votre agent IA personnalisé."} Je réponds de manière professionnelle et j&apos;exécute vos tâches{" "}
                  <strong>exclusivement dans mon domaine : {typeLabel}</strong>.
                </p>
                <div className="mt-6 grid gap-2 sm:grid-cols-2">
                  {quickPrompts.map((prompt) => (
                    <button key={prompt} type="button" onClick={() => setMessage(prompt)} className="group rounded-2xl border border-[rgba(23,23,20,0.09)] bg-white p-3 text-left text-xs leading-5 text-neutral-600 transition duration-300 hover:-translate-y-0.5 hover:border-violet-200 hover:bg-violet-50 hover:text-neutral-900">
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
                <div className="mb-1.5 flex items-center gap-2 text-[9px] font-bold uppercase tracking-[.2em] text-neutral-400">
                  <span>{item.role === "user" ? "Vous" : agent.name}</span>
                  {item.role === "agent" && item.mode === "chat" && (
                    <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[8px] font-bold tracking-wider text-sky-700 normal-case">Réponse directe</span>
                  )}
                  {item.role === "agent" && item.mode === "task" && (
                    <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[8px] font-bold tracking-wider text-violet-700 normal-case">Mission exécutée</span>
                  )}
                </div>
                <div className={item.role === "user"
                  ? "whitespace-pre-wrap rounded-2xl rounded-br-md bg-neutral-900 px-4 py-3.5 text-sm leading-6 text-white shadow-lg shadow-neutral-900/10"
                  : "whitespace-pre-wrap rounded-2xl rounded-bl-md border border-[rgba(23,23,20,0.09)] bg-white px-4 py-3.5 text-sm leading-6 text-neutral-800"}>{item.text}</div>

                {/* Trace d'exécution + approbations (mode task uniquement) */}
                {item.result && (
                  <div className="mt-2 rounded-2xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 p-3">
                    <button type="button" onClick={() => setShowTrace((current) => !current)} aria-expanded={showTrace} className="flex w-full items-center justify-between text-[11px] font-bold uppercase tracking-wider text-neutral-500 hover:text-neutral-800">
                      <span>Plan d&apos;exécution · {statusLabel(item.result.status)}</span>
                      <span aria-hidden="true">{showTrace ? "−" : "+"}</span>
                    </button>
                    {showTrace && (
                      <ol className="mt-2 space-y-1.5">
                        {item.result.plan.steps.map((step) => (
                          <li key={step.id} className="flex items-start gap-2 text-xs">
                            <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${step.status === "completed" ? "bg-emerald-500" : step.status === "failed" ? "bg-red-500" : step.status === "waiting_approval" ? "bg-amber-500" : "bg-neutral-300"}`} aria-hidden="true" />
                            <span className="min-w-0">
                              <span className="block truncate font-medium text-neutral-700">{step.name || step.id}</span>
                              {step.toolName && <span className="block text-[10px] text-neutral-400">Outil : {step.toolName}</span>}
                            </span>
                            <span className={`ml-auto shrink-0 text-[10px] font-semibold ${statusClass(step.status)}`}>{statusLabel(step.status)}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                    {item.result.status === "waiting_approval" && pendingApprovals.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {pendingApprovals.map((approval) => (
                          <div key={approval.id} className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                            <p className="text-xs font-semibold text-amber-800">Action sensible : {approval.toolSlug}</p>
                            {approval.reason && <p className="mt-0.5 text-[11px] leading-5 text-amber-700">{approval.reason}</p>}
                            <div className="mt-2 flex gap-2">
                              <button type="button" onClick={() => void decideApproval(approval.id, "approve")} disabled={loading} className="rounded-lg bg-neutral-900 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-neutral-800 disabled:opacity-40">Approuver</button>
                              <button type="button" onClick={() => void decideApproval(approval.id, "reject")} disabled={loading} className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-[11px] font-semibold text-amber-700 transition hover:bg-amber-100 disabled:opacity-40">Rejeter</button>
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
              <div className="mr-auto flex items-center gap-3 rounded-2xl border border-[rgba(23,23,20,0.09)] bg-white px-4 py-3 text-xs text-neutral-500">
                <span className="flex gap-1"><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-400 [animation-delay:120ms]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500 [animation-delay:240ms]" /></span>
                J&apos;analyse votre demande — réponse ou exécution selon le besoin…
              </div>
            )}
          </div>
        </div>

        {/* Zone de saisie */}
        <div className="border-t border-[rgba(23,23,20,0.09)] p-3 md:p-4">
          {error && <Callout tone="error" className="mb-3 rounded-2xl">{error}</Callout>}
          {attachment && (
            <div className="mb-2 flex items-center gap-2 text-xs text-neutral-500">
              <span className="rounded-full border border-[rgba(23,23,20,0.09)] bg-neutral-50 px-2.5 py-1">{uploading ? "Téléversement…" : attachment.name}</span>
              {attachmentPath && <span className="text-emerald-600">prêt</span>}
              <button type="button" onClick={() => { setAttachment(null); setAttachmentPath(null); }} className="text-neutral-400 hover:text-neutral-900" aria-label="Retirer la pièce jointe">Retirer</button>
            </div>
          )}
          {activated.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label="Connecteurs activés pour cette conversation">
              {activated.map((connector) => (
                <span key={connector.toolkit} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${connector.connected ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
                  <span aria-hidden="true">@</span>{connector.label}
                  <span className="text-[9px] uppercase tracking-wide opacity-70">{connector.connected ? "connecté" : "à connecter"}</span>
                  <button type="button" onClick={() => deactivateConnector(connector.toolkit)} className="ml-0.5 rounded-full p-0.5 hover:bg-black/5" aria-label={`Désactiver ${connector.label}`}>×</button>
                </span>
              ))}
            </div>
          )}
          <div className="relative">
            {pickerOpen && (
              <div className="absolute bottom-full left-0 z-50 mb-2 w-full max-w-md overflow-hidden rounded-2xl border border-[rgba(23,23,20,0.09)] bg-white p-2 shadow-[0_14px_40px_-18px_rgba(28,27,24,0.35)]" role="listbox" aria-label="Choisir un connecteur à activer">
                <div className="flex items-center justify-between px-2 py-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-[.2em] text-neutral-400">Connecteurs · activables avec @</span>
                  <button type="button" onClick={() => { setPickerOpen(false); setPickerManual(false); }} className="rounded-full p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900" aria-label="Fermer le sélecteur">×</button>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {pickerLoading && pickerItems.length === 0 ? (
                    <p className="px-3 py-4 text-xs text-neutral-400">Chargement des connecteurs…</p>
                  ) : pickerItems.length === 0 ? (
                    <p className="px-3 py-4 text-xs text-neutral-400">Aucun connecteur ne correspond.</p>
                  ) : (
                    pickerItems.map((connector) => {
                      const isActive = activated.some((item) => item.toolkit === connector.toolkit);
                      return (
                        <button
                          key={connector.toolkit}
                          type="button"
                          onClick={() => activateConnector(connector)}
                          disabled={isActive}
                          className="flex w-full items-start gap-3 rounded-xl p-2.5 text-left transition hover:bg-neutral-100 disabled:opacity-40"
                          role="option"
                          aria-selected={isActive}
                        >
                          <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-xs font-bold ${connector.connected ? "bg-emerald-100 text-emerald-700" : "bg-neutral-100 text-neutral-500"}`}>@</span>
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5 text-xs font-semibold text-neutral-800">
                              {connector.label}
                              <span className={`rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide ${connector.connected ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{connector.connected ? "connecté" : "à connecter"}</span>
                            </span>
                            <span className="mt-0.5 block truncate text-[10px] leading-4 text-neutral-400">{connector.description}</span>
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
            <PromptBox
              value={message}
              onValueChange={setMessage}
              onSubmit={submit}
              disabled={loading || uploading}
              placeholder={`Message pour ${agent.name} — tapez @ pour activer un connecteur…`}
              onFile={(file) => void handleAttachment(file)}
              onVoice={startVoice}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-[10px] text-neutral-400">
            <span>{agent.name} répond et agit uniquement en {typeLabel.toLowerCase()}</span>
            <button
              type="button"
              onClick={() => { setPickerManual(true); setPickerOpen(true); setPickerQuery(""); }}
              className="rounded-full border border-[rgba(23,23,20,0.09)] bg-white px-2.5 py-1 font-semibold text-neutral-600 transition hover:border-violet-200 hover:bg-violet-50 hover:text-violet-700"
              aria-expanded={pickerOpen}
            >@ Connecteur</button>
            <span>saisie vocale {isListening ? "active" : "disponible"} · pièces jointes acceptées</span>
          </div>
        </div>
      </div>
    </section>
  );
}
