"use client";

import * as React from "react";
import { PromptBox, AGENT_TOOLS } from "@/components/ui/chatgpt-prompt-input";

type AgentStep = {
  id: string;
  type: string;
  name?: string;
  description?: string;
  toolName?: string;
  requiresApproval?: boolean;
  sideEffect?: boolean;
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
  objective: string;
  conversationId?: string;
  plan: { steps: AgentStep[]; maxIterations: number };
  observations?: Array<{ stepId: string; success: boolean; error?: string; latencyMs: number }>;
  outputs?: Record<string, unknown>;
  approvals?: Approval[];
  billing?: { totalChargeMinor: number; totalProviderCostEur: number };
  error?: string;
  finalText?: string;
};

type Message = {
  id: string;
  role: "user" | "agent";
  text: string;
  result?: AgentResult;
};

type ConversationSummary = {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
};

const QUICK_ACTIONS = [
  "Analyse mes fichiers et résume les informations importantes.",
  "Fais une recherche web et prépare un rapport structuré.",
  "Analyse mon fichier ZIP et explique son contenu.",
  "Crée un document professionnel à partir de mon objectif.",
];

const capabilityLabels: Record<string, string> = Object.fromEntries(
  AGENT_TOOLS.map((tool) => [tool.id, tool.name]),
);

function statusLabel(status?: string) {
  switch (status) {
    case "completed": return "Terminé";
    case "running": return "En cours";
    case "waiting_approval": return "Confirmation requise";
    case "failed": return "Échec";
    case "cancelled": return "Annulé";
    case "blocked": return "Bloqué";
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

function Icon({ name, className = "h-4 w-4" }: { name: "spark" | "shield" | "activity" | "clock" | "file" | "search" | "code" | "globe" | "check" | "arrow" | "plus" | "stop"; className?: string }) {
  const common = { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (name === "spark") return <svg {...common}><path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7L12 2Z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z"/></svg>;
  if (name === "shield") return <svg {...common}><path d="M12 3 20 6v5c0 5.2-3.3 8.7-8 10-4.7-1.3-8-4.8-8-10V6l8-3Z"/><path d="m9 12 2 2 4-4"/></svg>;
  if (name === "activity") return <svg {...common}><path d="M3 12h4l2-6 4 12 2-6h6"/></svg>;
  if (name === "clock") return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>;
  if (name === "file") return <svg {...common}><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>;
  if (name === "search" || name === "globe") return <svg {...common}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>{name === "globe" && <><path d="M4 11h14"/><path d="M11 4a11 11 0 0 1 0 14"/></>}</svg>;
  if (name === "code") return <svg {...common}><path d="m9 18-6-6 6-6M15 6l6 6-6 6"/></svg>;
  if (name === "check") return <svg {...common}><path d="m5 12 4 4L19 6"/></svg>;
  if (name === "arrow") return <svg {...common}><path d="M5 12h14M13 6l6 6-6 6"/></svg>;
  if (name === "plus") return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
  return <svg {...common}><rect x="7" y="7" width="10" height="10" rx="2"/></svg>;
}

export function UniversalAgentChat({ initialMessage = "" }: { initialMessage?: string }) {
  const [message, setMessage] = React.useState("");
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [active, setActive] = React.useState<AgentResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [selectedTool, setSelectedTool] = React.useState<string | null>(null);
  const [attachment, setAttachment] = React.useState<File | null>(null);
  const [attachmentPath, setAttachmentPath] = React.useState<string | null>(null);
  const [isListening, setIsListening] = React.useState(false);
  const [showTrace, setShowTrace] = React.useState(true);
  const logRef = React.useRef<HTMLDivElement | null>(null);
  const lastObjectiveRef = React.useRef<string | null>(null);
  const [conversations, setConversations] = React.useState<ConversationSummary[]>([]);
  const [showHistory, setShowHistory] = React.useState(false);
  const [historyLoading, setHistoryLoading] = React.useState(false);

  // Suit le bas du fil a chaque nouveau message ou changement d'etat.
  React.useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, loading, active]);

  // Historique des conversations (source unique : /api/chat/conversations).
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

  async function deleteConversation(id: string) {
    try {
      const response = await fetch(`/api/chat/conversations/${id}`, { method: "DELETE" });
      if (!response.ok) return;
      if (id === conversationId) resetConversation();
      await loadConversations();
    } catch { /* suppression best effort */ }
  }

  React.useEffect(() => {
    if (initialMessage.trim() && !message.trim()) setMessage(initialMessage.trim());
  }, [initialMessage, message]);

  const progress = React.useMemo(() => {
    if (!active?.plan.steps.length) return 0;
    const done = active.plan.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
    return Math.round((done / active.plan.steps.length) * 100);
  }, [active]);

  const activeToolName = selectedTool ? capabilityLabels[selectedTool] : "Auto";
  const statusText = loading ? "Agent en cours" : active ? statusLabel(active.status) : "Prêt";

  async function runObjective(objective: string) {
    setLoading(true);
    setError("");
    lastObjectiveRef.current = objective;

    try {
      const enrichedObjective = [
        selectedTool ? `[Capacité prioritaire: ${selectedTool}]` : "",
        attachmentPath ? `[Fichier joint disponible dans le stockage Gen3ia: ${attachmentPath}]` : "",
        objective,
      ].filter(Boolean).join("\n");

      const response = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: enrichedObjective,
          ...(conversationId ? { conversationId } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Impossible de lancer l'agent.");

      const result = data as AgentResult;
      if (result.conversationId) setConversationId(result.conversationId);
      setActive(result);
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "agent",
          text: result.finalText
            || (result.status === "waiting_approval"
              ? "Le plan est actif. J’ai exécuté les étapes autorisées et mis les actions sensibles en attente de votre confirmation."
              : result.status === "completed"
                ? "Mission terminée. Les résultats affichés correspondent aux étapes réellement exécutées."
                : "Mission préparée. L’agent analyse, exécute et vérifie les étapes autorisées."),
          result,
        },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur de l’agent.");
    } finally {
      setLoading(false);
      void loadConversations();
    }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const objective = message.trim();
    if (!objective || loading) return;

    setMessages((items) => [...items, { id: crypto.randomUUID(), role: "user", text: objective }]);
    setMessage("");
    void runObjective(objective);
  }

  function retryLast() {
    const objective = lastObjectiveRef.current;
    if (!objective || loading) return;
    setMessages((items) => [...items, { id: crypto.randomUUID(), role: "user", text: objective }]);
    void runObjective(objective);
  }

  async function approve(approvalId: string, action: "approve" | "reject" = "approve") {
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
      const result = data as AgentResult;
      if (result.conversationId) setConversationId(result.conversationId);
      setActive(result);
      setMessages((items) => [...items, {
        id: crypto.randomUUID(),
        role: "agent",
        text: result.finalText
          || (result.status === "waiting_approval"
            ? "Une autre autorisation est nécessaire avant de continuer."
            : "Autorisation appliquée. L’agent reprend l’exécution et vérifie le résultat."),
        result,
      }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur pendant l’approbation.");
    } finally {
      setLoading(false);
      void loadConversations();
    }
  }

  async function handleAttachment(file: File) {
    setAttachment(file);
    setAttachmentPath(null);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/storage/permanent", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Téléversement impossible.");
      const path = typeof data.file?.path === "string" ? data.file.path : typeof data.file?.filename === "string" ? data.file.filename : null;
      if (!path) throw new Error("Le stockage n’a pas retourné le chemin du fichier.");
      setAttachmentPath(path);
    } catch (e) {
      setAttachment(null);
      setError(e instanceof Error ? e.message : "Le fichier n’a pas pu être téléversé.");
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
      setError("La saisie vocale n’est pas disponible dans ce navigateur.");
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

  function resetConversation() {
    if (loading) return;
    setConversationId(null);
    setMessages([]);
    setActive(null);
    setError("");
    setAttachment(null);
    setAttachmentPath(null);
    setSelectedTool(null);
    lastObjectiveRef.current = null;
    setMessage("");
  }

  return (
    <section className="relative overflow-hidden rounded-[30px] border border-[rgba(23,23,20,0.09)] bg-white shadow-[0_14px_40px_-18px_rgba(28,27,24,0.22)]">
      <div className="pointer-events-none absolute -left-32 -top-32 h-72 w-72 rounded-full bg-sky-100 blur-3xl animate-pulse" />
      <div className="pointer-events-none absolute -bottom-40 -right-20 h-80 w-80 rounded-full bg-violet-100 blur-3xl" />

      <div className="relative grid min-h-[760px] lg:grid-cols-[230px_minmax(0,1fr)_290px]">
        <aside className="hidden border-r border-[rgba(23,23,20,0.09)] bg-neutral-50 p-4 lg:block">
          <div className="flex items-center gap-2 text-[10px] font-black tracking-[.28em] text-sky-700">
            <Icon name="spark" className="h-3.5 w-3.5" /> GEN3IA AGENT
          </div>

          <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-neutral-900">
              <span className="relative flex h-2 w-2"><span className="absolute h-full w-full animate-ping rounded-full bg-emerald-500/60"/><span className="relative h-2 w-2 rounded-full bg-emerald-500"/></span>
              Agent opérationnel
            </div>
            <p className="mt-2 text-[11px] leading-5 text-neutral-500">Un seul chat pour planifier, utiliser les outils, créer, rechercher, coder et agir.</p>
          </div>

          <div className="mt-6 text-[10px] font-bold uppercase tracking-[.2em] text-neutral-400">Capacités</div>
          <div className="mt-2 space-y-1">
            {AGENT_TOOLS.map((tool) => (
              <button
                key={tool.id}
                type="button"
                onClick={() => setSelectedTool((current) => current === tool.id ? null : tool.id)}
                className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[11px] transition ${selectedTool === tool.id ? "bg-sky-100 text-sky-700" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"}`}
              >
                <span className="grid h-6 w-6 place-items-center rounded-lg bg-neutral-100 text-sky-700"><Icon name={tool.id === "web.search" ? "globe" : tool.id === "code.execute" ? "code" : tool.id.includes("file") || tool.id.includes("zip") ? "file" : "spark"} className="h-3.5 w-3.5"/></span>
                <span className="truncate">{tool.name}</span>
              </button>
            ))}
          </div>

          <button type="button" onClick={resetConversation} disabled={loading} className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl border border-[rgba(23,23,20,0.09)] bg-white px-3 py-2.5 text-xs text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-30">
            <Icon name="plus" className="h-3.5 w-3.5"/> Nouvelle mission
          </button>
        </aside>

        <div className="flex min-w-0 flex-col">
          <header className="flex items-center justify-between gap-3 border-b border-[rgba(23,23,20,0.09)] px-4 py-3.5 md:px-5">
            <div className="flex min-w-0 items-center gap-3">
              <div className="relative grid h-10 w-10 shrink-0 place-items-center rounded-2xl border border-sky-200 bg-sky-100 text-sky-700">
                <Icon name="spark" className="h-5 w-5"/>
                <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500"/>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-sm font-bold text-neutral-900">Agent universel</h2>
                  <span className="hidden rounded-full border border-sky-200 bg-sky-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-sky-700 sm:inline">Autonome</span>
                </div>
                <p className="mt-0.5 truncate text-[11px] text-neutral-500">{statusText} · {activeToolName}</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] sm:inline-flex ${loading ? "border-sky-200 bg-sky-100 text-sky-700" : "border-emerald-200 bg-emerald-50 text-emerald-600"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${loading ? "animate-pulse bg-sky-500" : "bg-emerald-500"}`}/>
                {loading ? "Exécution" : "Sécurisé"}
              </span>
              <button type="button" onClick={() => { void loadConversations(); setShowHistory((current) => !current); }} className="rounded-xl border border-[rgba(23,23,20,0.09)] px-3 py-2 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900" aria-expanded={showHistory}>Historique</button>
              <button type="button" onClick={resetConversation} disabled={loading} className="rounded-xl border border-[rgba(23,23,20,0.09)] px-3 py-2 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-30">Nouveau</button>
            </div>
          </header>

          {showHistory && (
            <div className="border-b border-[rgba(23,23,20,0.09)] bg-neutral-50/70 px-4 py-3 md:px-5" role="region" aria-label="Historique des conversations">
              {historyLoading && conversations.length === 0 ? (
                <p className="text-xs text-neutral-400">Chargement de l’historique…</p>
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
                      <button
                        type="button"
                        onClick={() => deleteConversation(conversation.id)}
                        aria-label={`Supprimer ${conversation.title || "la conversation"}`}
                        className="shrink-0 rounded-lg border border-[rgba(23,23,20,0.09)] bg-white px-2 py-1.5 text-[10px] text-neutral-400 hover:border-red-200 hover:text-red-600"
                      >
                        Supprimer
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-4 md:p-5">
            {messages.length === 0 && (
              <div className="flex min-h-[470px] items-center justify-center">
                <div className="w-full max-w-2xl text-center">
                  <div className="mx-auto relative grid h-20 w-20 place-items-center rounded-[24px] border border-sky-200 bg-gradient-to-br from-sky-100 to-violet-100 text-sky-700 shadow-xl shadow-sky-100/80">
                    <Icon name="spark" className="h-9 w-9"/>
                    <span className="absolute inset-0 rounded-[24px] border border-sky-200 animate-ping"/>
                  </div>
                  <h3 className="mt-6 font-serif text-2xl font-bold tracking-tight text-neutral-900 md:text-3xl">Que voulez-vous que je fasse ?</h3>
                  <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-neutral-500">Parlez à Gen3ia comme à un assistant, mais donnez-lui aussi un objectif à exécuter. Il choisit les capacités, orchestre les étapes, vérifie les résultats et demande votre autorisation lorsque nécessaire.</p>

                  <div className="mt-7 grid gap-2 sm:grid-cols-2">
                    {QUICK_ACTIONS.map((action, index) => (
                      <button key={action} type="button" onClick={() => setMessage(action)} className="group flex items-center gap-3 rounded-2xl border border-[rgba(23,23,20,0.09)] bg-white p-3 text-left transition duration-300 hover:-translate-y-0.5 hover:border-sky-200 hover:bg-sky-50">
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-neutral-100 text-sky-700 transition group-hover:scale-110"><Icon name={index === 1 ? "search" : index === 2 ? "file" : index === 3 ? "spark" : "activity"} className="h-4 w-4"/></span>
                        <span className="text-xs leading-5 text-neutral-600 group-hover:text-neutral-900">{action}</span>
                        <Icon name="arrow" className="ml-auto h-3.5 w-3.5 shrink-0 text-neutral-300 transition group-hover:translate-x-1 group-hover:text-sky-700"/>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div ref={logRef} className="mx-auto max-w-3xl space-y-5 overflow-y-auto" role="log" aria-live="polite" aria-label="Fil de conversation avec l'agent">
              {messages.map((item) => (
                <div key={item.id} className={item.role === "user" ? "ml-auto max-w-[88%] md:max-w-[78%]" : "mr-auto max-w-[96%]"}>
                  <div className="mb-1.5 flex items-center gap-2 text-[9px] font-bold uppercase tracking-[.2em] text-neutral-400">
                    <span>{item.role === "user" ? "Vous" : "Gen3ia Agent"}</span>
                    <time className="font-medium normal-case tracking-normal text-neutral-300">
                      {new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                    </time>
                  </div>
                  <div className={item.role === "user"
                    ? "whitespace-pre-wrap rounded-2xl rounded-br-md bg-neutral-900 px-4 py-3.5 text-sm leading-6 text-white shadow-lg shadow-neutral-900/10"
                    : "whitespace-pre-wrap rounded-2xl rounded-bl-md border border-[rgba(23,23,20,0.09)] bg-white px-4 py-3.5 text-sm leading-6 text-neutral-800"}>{item.text}</div>
                </div>
              ))}

              {loading && (
                <div className="mr-auto flex items-center gap-3 rounded-2xl border border-[rgba(23,23,20,0.09)] bg-white px-4 py-3 text-xs text-neutral-500">
                  <span className="flex gap-1"><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-500"/><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:120ms]"/><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-500 [animation-delay:240ms]"/></span>
                  L’agent analyse votre objectif…
                </div>
              )}

              {error && !loading && (
                <div role="alert" className="mr-auto max-w-[96%]">
                  <div className="mb-1.5 flex items-center gap-2 text-[9px] font-bold uppercase tracking-[.2em] text-red-400">
                    <span>Gen3ia Agent</span>
                  </div>
                  <div className="rounded-2xl rounded-bl-md border border-red-200 bg-red-50 px-4 py-3.5 text-sm leading-6 text-red-700">
                    {error}
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={retryLast}
                        className="rounded-full border border-red-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-100"
                      >
                        Réessayer
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {active && (
                <div className="overflow-hidden rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white shadow-[0_14px_40px_-18px_rgba(28,27,24,0.22)] anim-fade-up">
                  <div className="border-b border-[rgba(23,23,20,0.09)] p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="grid h-9 w-9 place-items-center rounded-xl bg-sky-100 text-sky-700"><Icon name="activity" className="h-4 w-4"/></div>
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-[.2em] text-neutral-400">Mission</div>
                          <div className="mt-1 font-mono text-[10px] text-neutral-500">{active.executionId}</div>
                        </div>
                      </div>
                      <span className={`rounded-full border border-[rgba(23,23,20,0.09)] bg-neutral-50 px-2.5 py-1 text-[10px] font-semibold ${statusClass(active.status)}`}>{statusLabel(active.status)}</span>
                    </div>

                    <div className="mt-4 flex items-center justify-between text-[10px] text-neutral-400"><span>Progression</span><span>{progress}%</span></div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neutral-100">
                      <div className="relative h-full rounded-full bg-gradient-to-r from-sky-500 via-violet-500 to-sky-400 transition-all duration-700" style={{ width: `${Math.max(progress, active.status === "waiting_approval" ? 12 : 0)}%` }}>
                        <span className="absolute right-0 top-0 h-full w-12 animate-pulse bg-white/60 blur-sm"/>
                      </div>
                    </div>

                    {active.billing && (
                      <div className="mt-2.5 flex items-center justify-between text-[10px] text-neutral-400">
                        <span>Coût de la mission</span>
                        <span className="font-mono font-semibold text-neutral-600">{(active.billing.totalChargeMinor / 100).toFixed(4)} EUR</span>
                      </div>
                    )}
                  </div>

                  <div className="p-4">
                    <div className="space-y-2">
                      {active.plan.steps.map((step, index) => (
                        <div key={step.id} className="group flex items-center gap-3 rounded-2xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 p-3 transition hover:bg-neutral-100">
                          <div className={`grid h-7 w-7 shrink-0 place-items-center rounded-xl border ${step.status === "completed" ? "border-emerald-200 bg-emerald-50 text-emerald-600" : step.status === "running" ? "border-sky-200 bg-sky-50 text-sky-700" : step.requiresApproval ? "border-amber-200 bg-amber-50 text-amber-700" : "border-[rgba(23,23,20,0.09)] bg-white text-neutral-400"}`}>
                            {step.status === "completed" ? <Icon name="check" className="h-3.5 w-3.5"/> : step.status === "running" ? <span className="h-2 w-2 animate-pulse rounded-full bg-sky-500"/> : index + 1}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-semibold text-neutral-800">{step.name || capabilityLabels[step.toolName || ""] || step.toolName || step.type}</div>
                            <div className="mt-0.5 truncate text-[10px] text-neutral-400">{step.toolName || step.type}{step.sideEffect ? " · action externe" : ""}</div>
                          </div>
                          <span className={`shrink-0 text-[10px] font-semibold ${statusClass(step.status)}`}>{step.requiresApproval ? "Autorisation" : statusLabel(step.status)}</span>
                        </div>
                      ))}
                    </div>

                    {active.approvals?.some((approval) => approval.status === "pending") && (
                      <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                        <div className="flex items-start gap-3">
                          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-100 text-amber-700"><Icon name="shield" className="h-4 w-4"/></div>
                          <div>
                            <div className="text-xs font-bold text-amber-900">Votre confirmation est requise</div>
                            <p className="mt-1 text-[11px] leading-5 text-amber-700">Les actions sensibles, externes, destructives ou irréversibles ne sont jamais exécutées silencieusement.</p>
                          </div>
                        </div>
                        <div className="mt-3 space-y-2">
                          {active.approvals.filter((approval) => approval.status === "pending").map((approval) => (
                            <div key={approval.id} className="flex items-center gap-3 rounded-xl border border-[rgba(23,23,20,0.09)] bg-white p-3">
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-xs font-semibold text-neutral-900">{approval.toolSlug}</div>
                                <div className="mt-1 text-[10px] leading-4 text-neutral-500">{approval.reason}</div>
                              </div>
                              <button type="button" disabled={loading} onClick={() => approve(approval.id, "approve")} className="shrink-0 rounded-xl bg-amber-400 px-3 py-2 text-[10px] font-black text-black transition hover:bg-amber-300 disabled:opacity-40">Autoriser</button>
                              <button type="button" disabled={loading} onClick={() => approve(approval.id, "reject")} className="shrink-0 rounded-xl border border-red-200 bg-white px-3 py-2 text-[10px] font-bold text-red-600 transition hover:bg-red-50 disabled:opacity-40">Refuser</button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {active.finalText && active.status === "completed" && (
                      <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.2em] text-emerald-600"><Icon name="check" className="h-3.5 w-3.5"/> Résultat final</div>
                        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-neutral-700">{active.finalText}</p>
                      </div>
                    )}

                    {showTrace && (
                      <details className="mt-4 rounded-2xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 p-3">
                        <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-[.18em] text-neutral-500">Trace d’exécution</summary>
                        <div className="mt-3 space-y-1.5">
                          {active.observations?.map((observation) => (
                            <div key={`${observation.stepId}-${observation.latencyMs}`} className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-2 text-[10px]">
                              <span className={observation.success ? "text-emerald-600" : "text-red-600"}>{observation.success ? "✓" : "!"}</span>
                              <span className="min-w-0 flex-1 truncate text-neutral-500">{observation.stepId}</span>
                              <span className="text-neutral-400">{observation.latencyMs} ms</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    {active.outputs && Object.keys(active.outputs).length > 0 && (
                      <details className="mt-2 rounded-2xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 p-3">
                        <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-[.18em] text-neutral-500">Données produites</summary>
                        <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-5 text-neutral-700">{JSON.stringify(active.outputs, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-[rgba(23,23,20,0.09)] bg-neutral-50 p-3 md:p-4">
            {attachment && (
              <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-[10px] text-sky-700">
                <Icon name="file" className="h-3.5 w-3.5"/>
                <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
                <span className="text-neutral-400">{Math.ceil(attachment.size / 1024)} Ko</span>
                <button type="button" onClick={() => { setAttachment(null); setAttachmentPath(null); }} className="text-neutral-400 hover:text-neutral-900" aria-label="Retirer le fichier">×</button>
              </div>
            )}

            <div className="mx-auto max-w-3xl">
              <PromptBox
                value={message}
                onValueChange={setMessage}
                onSubmit={submit}
                disabled={loading}
                selectedTool={selectedTool}
                onToolChange={setSelectedTool}
                onFile={handleAttachment}
                onVoice={startVoice}
                placeholder="Parlez à l’Agent Gen3ia… demandez-lui de réfléchir, rechercher, créer ou agir."
              />
              <div className="mt-2 flex items-center justify-between gap-3 px-1 text-[9px] text-neutral-400">
                <span>{isListening ? "Écoute vocale active…" : "Entrée pour envoyer · Maj+Entrée pour une nouvelle ligne"}</span>
                <button type="button" onClick={() => setShowTrace((value) => !value)} className="hover:text-neutral-600">{showTrace ? "Masquer la trace" : "Afficher la trace"}</button>
              </div>
            </div>
          </div>
        </div>

        <aside className="hidden border-l border-[rgba(23,23,20,0.09)] bg-neutral-50 p-4 lg:block">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.2em] text-neutral-400"><Icon name="shield" className="h-3.5 w-3.5"/> Contrôle Agent</div>
          <div className="mt-4 space-y-2">
            {[
              ["Planification", "DAG validé avant exécution.", "activity"],
              ["Permissions", "Chaque outil est autorisé par politique.", "shield"],
              ["Exécution", "Les capacités sont appelées via le runtime sécurisé.", "spark"],
              ["Vérification", "Un succès n’est annoncé qu’après retour réel.", "check"],
              ["Approbation", "Les effets sensibles restent bloqués.", "clock"],
            ].map(([title, text, icon]) => (
              <div key={title} className="rounded-2xl border border-[rgba(23,23,20,0.09)] bg-white p-3 transition hover:bg-neutral-100">
                <div className="flex items-center gap-2 text-xs font-semibold text-neutral-700"><span className="text-sky-700"><Icon name={icon as "activity" | "shield" | "spark" | "check" | "clock"} className="h-3.5 w-3.5"/></span>{title}</div>
                <div className="mt-1.5 text-[10px] leading-4 text-neutral-400">{text}</div>
              </div>
            ))}
          </div>

          {active?.billing && (
            <div className="mt-4 rounded-2xl border border-sky-200 bg-sky-50 p-3">
              <div className="text-[9px] font-bold uppercase tracking-[.18em] text-neutral-400">Consommation</div>
              <div className="mt-2 text-sm font-semibold text-neutral-800">{active.billing.totalChargeMinor} unités mineures</div>
              <div className="mt-1 text-[10px] text-neutral-500">Fournisseur estimé : {active.billing.totalProviderCostEur.toFixed(4)} €</div>
            </div>
          )}

          <div className="mt-4 rounded-2xl border border-violet-200 bg-violet-50 p-3">
            <div className="text-[9px] font-bold uppercase tracking-[.18em] text-violet-700">Mode</div>
            <div className="mt-2 text-xs font-semibold text-neutral-800">Agent universel</div>
            <p className="mt-1 text-[10px] leading-4 text-neutral-500">Le chat et l’agent partagent maintenant la même interface d’exécution.</p>
          </div>
        </aside>
      </div>
    </section>
  );
}
