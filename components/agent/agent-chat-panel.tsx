"use client";

import * as React from "react";

import { CommandComposer, type CommandComposerHandle } from "@/components/ui/command-composer";
import { MarkdownContent } from "@/components/workspace/markdown";
import type { MentionItem } from "@/lib/ui/command-composer-helpers";
import { uploadPermanentFiles } from "@/lib/storage/upload-client";
import { ATTACHMENT_MAX_FILES, attachmentLimitLabel, validateAttachment } from "@/lib/files/attachment-policy";
import { Callout } from "@/components/studio/callout";
import { labelForAgent } from "@/lib/agents/charter";
import { approvalToolLabel, toolLabel } from "@/lib/tools/labels";
import { downloadUrl } from "@/lib/client/download";
import { Gen3iaLogo } from "@/components/brand/gen3ia-logo";
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
  toolName?: string;
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
  /** Le checkpoint est reprenable (travail partiel conservé) : « Continuer la mission » proposé. */
  resumable?: boolean;
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
    case "completed": return "Terminée";
    case "running": return "En cours";
    case "queued": return "En file d'exécution";
    case "waiting_approval": return "Confirmation requise";
    case "failed": return "Échec";
    case "cancelled": return "Annulée";
    case "paused": return "En pause";
    default: return status ?? "En attente";
  }
}

/**
 * Clé de persistance de session : la dernière conversation ouverte est
 * mémorisée PAR AGENT — après un refresh, l'utilisateur retrouve son fil
 * et la mission éventuellement encore en cours d'exécution.
 */
function conversationStorageKey(agentId: string) {
  return `gen3ia:agent-chat:conversation:${agentId}`;
}

function statusClass(status?: string) {
  if (status === "completed") return "text-emerald-300";
  if (status === "failed" || status === "blocked") return "text-red-300";
  if (status === "running") return "text-sky-300";
  if (status === "waiting_approval") return "text-amber-300";
  return "text-[var(--g3-muted)]";
}

function Avatar({ name, size = "md" }: { name: string; size?: "md" | "lg" }) {
  const initial = name.trim().charAt(0).toUpperCase() || "A";
  const dimension = size === "lg" ? "h-14 w-14 text-xl" : "h-9 w-9 text-sm";
  return <span className={`grid shrink-0 place-items-center rounded-2xl border border-white/15 bg-[var(--g3-surface)]/10 font-serif font-bold text-[var(--g3-text-secondary)] ${dimension}`}>{initial}</span>;
}

export function AgentChatPanel({
  agent,
  initialMessage = "",
  pendingConversationId = null,
  onPendingConversationConsumed,
  onConversationsChanged,
}: {
  agent: AgentSummary;
  onAgentsChanged: () => void;
  initialMessage?: string;
  /** Conversation à rouvrir depuis l'historique du rail (chat Gen IA). */
  pendingConversationId?: string | null;
  onPendingConversationConsumed?: () => void;
  /** Notifie le rail que l'historique a changé (nouveau chat, envoi…). */
  onConversationsChanged?: () => void;
}) {
  const [message, setMessage] = React.useState("");
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [active, setActive] = React.useState<AgentResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  // Pièces jointes MULTIPLES (politique unifiée : 10 fichiers × 50 Mo).
  const [attachments, setAttachments] = React.useState<Array<{ file: File; path: string }>>([]);
  // Mission LIVE : pendant l'exécution (bloquante OU en file arrière-plan),
  // polling des runs de la conversation → suivi des étapes réelles en direct.
  const [liveRun, setLiveRun] = React.useState<{ id: string; status: string; steps: Array<{ id: string; name: string; status: string }> } | null>(null);
  // SUIVI D'UNE MISSION EN FILE (202) : la requête HTTP est terminée, la
  // mission continue serveur — le panneau suit le run jusqu'à son état
  // terminal puis recharge la conversation (message final + livrables).
  const [tracking, setTracking] = React.useState<{ runId: string; executionId?: string } | null>(null);
  const [uploading, setUploading] = React.useState(false);
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
  // Arrêt à tout moment : l'AbortController de la requête en cours.
  // NOTE (exigence production) : le DÉMONTAGE du composant (refresh, fermeture
  // d'onglet, navigation) n'abort PLUS la requête — la mission appartient au
  // serveur, pas à l'onglet. Seul le bouton « Arrêter » exprime un arrêt
  // (contrôle Firestore via /api/agent/chat/stop).
  const requestAbortRef = React.useRef<AbortController | null>(null);

  // PLEIN ÉCRAN (demande utilisateur) : le chat peut occuper TOUT l'écran —
  // overlay CSS « fixed inset-0 » (fonctionne partout, y compris iOS Safari)
  // + API Fullscreen native quand le navigateur la propose (masque la barre
  // d'adresse). Les deux sont pilotés par le même bouton d'en-tête.
  const [fullscreen, setFullscreen] = React.useState(false);
  const sectionRef = React.useRef<HTMLElement | null>(null);

  // SUIVI LIVE : pendant l'exécution d'une mission (bloquante OU en file
  // arrière-plan), le DERNIER run de la conversation est sondé (2,5 s) pour
  // afficher l'avancement réel des étapes — au lieu d'un spinner figé. Quand
  // le run atteint un état terminal, la conversation est rechargée : le
  // message final et les livrables apparaissent, même après un refresh.
  const openConversationRef = React.useRef<((id: string) => Promise<void>) | null>(null);
  React.useEffect(() => {
    const following = tracking && conversationId;
    if ((!loading && !following) || !conversationId) {
      setLiveRun(null);
      return;
    }
    let cancelled = false;
    const terminal = (status: string) => ["completed", "failed", "cancelled", "awaiting_approval", "waiting_approval"].includes(status);
    const poll = async () => {
      try {
        const response = await fetch(`/api/chat/conversations/${conversationId}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json();
        const runs = (data.runs ?? []) as Array<{ id: string; status: string; steps?: Array<{ id: string; name: string; status: string }> }>;
        const freshest = runs[0];
        if (cancelled || !freshest) return;
        setLiveRun({ id: freshest.id, status: freshest.status, steps: freshest.steps ?? [] });
        if (tracking && terminal(freshest.status)) {
          // État terminal atteint : rechargement complet de la conversation
          // (messages + run final) puis fin du suivi.
          setTracking(null);
          await openConversationRef.current?.(conversationId);
          void loadConversations();
        }
      } catch { /* sondage indisponible : le panneau reste honnête */ }
    };
    void poll();
    const interval = setInterval(() => void poll(), 2_500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, tracking, conversationId]);

  // PLEIN ÉCRAN : bascule l'overlay CSS et demande l'API Fullscreen native
  // quand le navigateur la propose. L'échec (iOS, permission refusée) est
  // silencieux : l'overlay CSS seul reste un vrai plein écran fonctionnel.
  function toggleFullscreen() {
    const next = !fullscreen;
    setFullscreen(next);
    try {
      if (next) {
        const element = sectionRef.current;
        if (element && typeof element.requestFullscreen === "function") {
          void element.requestFullscreen().catch(() => undefined);
        }
      } else if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => undefined);
      }
    } catch { /* API indisponible : l'overlay CSS plein écran reste actif */ }
  }

  // Synchronisation du plein écran : sortie native (Échap, F11, geste du
  // navigateur) → l'état CSS suit, le bouton reste cohérent avec l'écran.
  React.useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

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
      // Historique SCOPÉ À L'AGENT courant : chaque agent possède son propre
      // fil de conversations (conversations créées avec agentId).
      const response = await fetch(`/api/chat/conversations?limit=20&agentId=${encodeURIComponent(agent.id)}`, { cache: "no-store" });
      if (response.ok) setConversations(((await response.json()).conversations ?? []) as ConversationSummary[]);
    } catch { /* historique indisponible */ } finally {
      setHistoryLoading(false);
      onConversationsChanged?.();
    }
  }, [agent.id, onConversationsChanged]);

  React.useEffect(() => { void loadConversations(); }, [loadConversations]);

  // Ouverture demandée depuis le rail « Historique des chats » (extérieur).
  React.useEffect(() => {
    if (!pendingConversationId || loading) return;
    void (async () => {
      await openConversationRef.current?.(pendingConversationId);
      onPendingConversationConsumed?.();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingConversationId]);

  // Reprise hors-ligne : une tâche envoyée hors connexion vient d'être
  // rejouée en arrière-plan (Background Sync) — rafraîchit la conversation
  // ouverte et l'historique (exécution même hors ligne, demande utilisateur).
  React.useEffect(() => {
    const handler = () => {
      void loadConversations();
      if (conversationId) void openConversationRef.current?.(conversationId);
    };
    window.addEventListener("gen3ia:outbox-flushed", handler);
    // Une demande mise en file hors-ligne n'a jamais pu être délivrée
    // (session expirée, plafond de tentatives) : l'utilisateur est informé —
    // jamais de perte silencieuse.
    const failureHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ status?: number }>).detail;
      const reason = detail?.status === 401
        ? "votre session a expiré : reconnectez-vous puis renvoyez votre demande"
        : "la demande n'a pas pu être délivrée après plusieurs tentatives";
      setError(`Synchronisation hors-ligne interrompue : ${reason}.`);
      void loadConversations();
    };
    window.addEventListener("gen3ia:outbox-failed", failureHandler);
    return () => {
      window.removeEventListener("gen3ia:outbox-flushed", handler);
      window.removeEventListener("gen3ia:outbox-failed", failureHandler);
    };
  }, [conversationId, loadConversations]);

  // Nouvelle conversation à chaque changement d'agent : le contexte du chat
  // appartient à l'agent sélectionné (l'effet de reprise ci-dessous rouvre
  // ensuite la dernière conversation MÉMORISÉE de ce même agent).
  React.useEffect(() => {
    setConversationId(null);
    setMessages([]);
    setActive(null);
    setError("");
  }, [agent.id]);

  // REPRISE APRÈS REFRESH (exigence production) : au montage — et à chaque
  // changement d'agent — la dernière conversation mémorisée est rouverte.
  // Si une mission y est encore en cours (run non terminal), openConversation
  // réarme le suivi live : l'utilisateur voit l'exécution continuer, exactement
  // comme avant l'actualisation de la page.
  React.useEffect(() => {
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem(conversationStorageKey(agent.id));
    } catch { /* stockage indisponible */ }
    if (!stored || loading) return;
    void openConversation(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      rememberConversation(id);
      // Historique complet : le DERNIER run de mission enregistré sur le fil
      // restaure le panneau de mission (plan, étapes, sorties, coût) tel
      // qu'affiché pendant l'exécution — plus aucune mission perdue à la
      // réouverture.
      const runList = ((data.runs ?? []) as Array<{
        id: string;
        status: string;
        runtime?: {
          status?: string;
          executionId?: string;
          plan?: AgentResult["plan"];
          outputs?: Record<string, unknown>;
          finalText?: string;
          error?: string;
        };
      }>);
      // REPRISE APRÈS REFRESH : un run non terminal = mission ENCORE en cours
      // côté serveur (file QStash ou exécution détachée) — le suivi live est
      // réarmé immédiatement, sans aucune action de l'utilisateur.
      const freshestRun = runList[0];
      const terminalStatuses = ["completed", "failed", "cancelled", "awaiting_approval", "waiting_approval"];
      if (freshestRun && !terminalStatuses.includes(freshestRun.status)) {
        setTracking({
          runId: freshestRun.id,
          ...(freshestRun.runtime?.executionId ? { executionId: freshestRun.runtime.executionId } : {}),
        });
      } else {
        setTracking(null);
      }
      const lastRun = runList.find((run) => run.runtime?.plan);
      if (lastRun?.runtime) {
        setActive({
          mode: "agent",
          status: lastRun.runtime.status ?? lastRun.status,
          executionId: lastRun.runtime.executionId ?? lastRun.id,
          conversationId: id,
          plan: lastRun.runtime.plan!,
          ...(lastRun.runtime.outputs ? { outputs: lastRun.runtime.outputs } : {}),
          approvals: [],
          ...(lastRun.runtime.finalText ? { finalText: lastRun.runtime.finalText } : {}),
          ...(lastRun.runtime.error ? { error: lastRun.runtime.error } : {}),
        });
      } else {
        setActive(null);
      }
      setMessages(items);
      setShowHistory(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conversation introuvable.");
    } finally { setHistoryLoading(false); }
  }

  // Référence tenue à jour après montage (jamais pendant le rendu).
  React.useEffect(() => {
    openConversationRef.current = openConversation;
  });

  /**
   * Mémorise la conversation ouverte (sessionStorage, par agent) : c'est ce
   * qui permet au refresh de rouvrir le fil et de réafficher la mission en
   * cours — le stockage est silencieusement ignoré s'il est indisponible.
   */
  function rememberConversation(id: string | null) {
    setConversationId(id);
    try {
      if (id) sessionStorage.setItem(conversationStorageKey(agent.id), id);
      else sessionStorage.removeItem(conversationStorageKey(agent.id));
    } catch { /* stockage indisponible (navigation privée) : reprise inactive, aucune erreur visible */ }
  }

  function resetConversation() {
    if (loading) return;
    rememberConversation(null);
    setMessages([]);
    setActive(null);
    setError("");
    setAttachments([]);
    setMessage("");
  }

  async function handleAttachment(file: File) {
    setError("");
    if (attachments.length >= ATTACHMENT_MAX_FILES) {
      setError(attachmentLimitLabel());
      return;
    }
    const verdict = validateAttachment({ name: file.name, size: file.size });
    if (!verdict.ok) {
      setError(verdict.reason);
      return;
    }
    setUploading(true);
    try {
      const result = await uploadPermanentFiles([file]);
      const uploaded = result.uploaded[0];
      if (!uploaded) throw new Error(result.failed[0]?.error || "Téléversement impossible.");
      const path = uploaded.path || uploaded.filename;
      if (!path) throw new Error("Le stockage n'a pas retourné le chemin du fichier.");
      setAttachments((current) => [...current, { file, path }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Le fichier n'a pas pu être téléversé.");
    } finally {
      setUploading(false);
    }
  }

  async function sendMessage(objective: string) {
    setLoading(true);
    setError("");
    const controller = new AbortController();
    requestAbortRef.current = controller;
    try {
      const response = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          message: objective,
          agentId: agent.id,
          authorizationMode,
          ...(conversationId ? { conversationId } : {}),
          ...(attachments.length > 0 ? { attachments: attachments.map(({ file, path }) => ({ path, name: file.name, sizeBytes: file.size, contentType: file.type || undefined })) } : {}),
          ...(activated.length > 0 ? { activatedConnectors: activated.map((item) => item.toolkit) } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "L'agent n'a pas pu répondre.");

      // File hors-ligne (SW 202) : la mission PARTIRA au retour du réseau —
      // on l'annonce honnêtement au lieu d'un faux « en cours d'exécution ».
      if (data.queued && data.offline) {
        setMessages((items) => [...items, {
          id: crypto.randomUUID(),
          role: "agent",
          text: "Vous êtes hors ligne : votre demande est enregistrée et sera envoyée automatiquement au retour du réseau.",
          mode: "chat",
        }]);
        setLoading(false);
        requestAbortRef.current = null;
        return;
      }

      if (data.conversationId) rememberConversation(data.conversationId);
      // Pièces jointes consommées par l'envoi : nettoyage immédiat.
      setAttachments([]);

      // MISSION EN FILE (202) : la requête HTTP est terminée, la mission
      // s'exécute 100 % côté serveur — rafraîchir, fermer l'onglet ou changer
      // de page ne l'interrompt PAS. Le panneau suit le run en direct (polling
      // existant) et recharge la conversation à l'état terminal.
      if (data.status === "queued" && data.runId) {
        setTracking({ runId: String(data.runId), ...(data.executionId ? { executionId: String(data.executionId) } : {}) });
        setActive({
          mode: "agent",
          status: "queued",
          executionId: String(data.executionId ?? data.runId),
          conversationId: data.conversationId,
          plan: data.plan ?? { steps: [], maxIterations: 0 },
        });
        setMessages((items) => [...items, {
          id: crypto.randomUUID(),
          role: "agent",
          text: "Mission lancée : je travaille en arrière-plan et je livre le résultat ici dès qu'elle est terminée — vous pouvez quitter cette page, le travail continue.",
          mode: "task",
        }]);
        void loadConversations();
        return;
      }

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
                : "Mission en cours d'exécution — les étapes réellement exécutées s'affichent en direct."),
          mode: "task",
          result,
        }]);
      }
      void loadConversations();
    } catch (e) {
      // Arrêt demandé par l'utilisateur (bouton « Arrêter ») : message
      // d'interruption propre — jamais une erreur d'agent trompeuse.
      if (controller.signal.aborted) {
        setMessages((items) => [...items, {
          id: crypto.randomUUID(),
          role: "agent",
          text: "Arrêt demandé — l'exécution a été interrompue. Le travail déjà réalisé est conservé ; relancez-moi quand vous voulez reprendre.",
          mode: "chat",
        }]);
        setActive(null);
      } else {
        setError(e instanceof Error ? e.message : "Erreur de l'agent.");
      }
    } finally {
      requestAbortRef.current = null;
      setLoading(false);
    }
  }

  /** Arrête l'agent à tout moment pendant une exécution en cours. */
  function stopAgent() {
    // ARRÊT EXPLICITE (seule façon d'interrompre une mission) : contrôle
    // Firestore consulté par le runtime, que la mission soit synchrone ou en
    // file — le travail déjà payé reste conservé.
    const executionId = tracking?.executionId ?? active?.executionId;
    if (executionId) {
      void fetch("/api/agent/chat/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ executionId }),
      }).catch(() => undefined);
      setMessages((items) => [...items, {
        id: crypto.randomUUID(),
        role: "agent",
        text: "Arrêt demandé — l'exécution va s'interrompre au plus près de l'étape en cours. Le travail déjà réalisé est conservé.",
        mode: "chat",
      }]);
      setTracking(null);
    }
    // Requête synchrone encore en vol : l'abort n'annule plus la mission
    // côté serveur (détachée), il libère seulement l'attente locale.
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
  }

  /**
   * Reprise d'une mission interrompue (timeout, kill serveur) : le
   * checkpoint conserve les étapes réussies et leurs sorties — la reprise
   * n'exécute QUE le reste. Le travail payé n'est jamais perdu.
   */
  async function continueMission(executionId: string) {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/agent/chat/continue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ executionId, ...(conversationId ? { conversationId } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "La reprise de la mission a échoué.");
      if (data.queued && data.offline) {
        setError("Vous êtes hors ligne : la reprise exige le réseau. Reconnectez-vous puis continuez à nouveau.");
        return;
      }
      // Reprise en file (202) : la suite s'exécute en arrière-plan — le
      // panneau suit le run jusqu'à la livraison finale.
      if (data.status === "queued" && data.runId) {
        setTracking({ runId: String(data.runId), ...(data.executionId ? { executionId: String(data.executionId) } : {}) });
        setActive({
          mode: "agent",
          status: "queued",
          executionId: String(data.executionId ?? data.runId),
          conversationId: data.conversationId ?? conversationId ?? undefined,
          plan: data.plan ?? { steps: [], maxIterations: 0 },
        });
        setMessages((items) => [...items, {
          id: crypto.randomUUID(),
          role: "agent",
          text: "Reprise lancée en arrière-plan : la mission continue même si vous quittez cette page.",
          mode: "task",
        }]);
        return;
      }
      const result = data as AgentResult;
      setActive(result);
      setMessages((items) => [...items, {
        id: crypto.randomUUID(),
        role: "agent",
        text: result.finalText
          || (result.status === "waiting_approval"
            ? "La reprise est prête : une action nécessite votre confirmation."
            : result.status === "completed"
              ? "Mission terminée après reprise. Les résultats affichés correspondent aux étapes réellement exécutées."
              : "La reprise a encore été interrompue — les étapes réussies sont conservées, vous pouvez continuer."),
        mode: "task",
        result,
      }]);
      void loadConversations();
    } catch (e) {
      setError(e instanceof Error ? e.message : "La reprise a échoué.");
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
      if (data.queued && data.offline) {
        setError("Vous êtes hors ligne : cette décision exige le réseau. Reconnectez-vous puis validez à nouveau.");
        return;
      }
      if (data.conversationId) rememberConversation(data.conversationId);
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
  // Mission vivante : exécution bloquante (loading) OU mission en file suivie
  // en arrière-plan (tracking) — l'un OU l'autre affiche le panneau live.
  const missionLive = loading || tracking !== null;

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
      description: "Rouvre une conversation passée avec cet agent.",
      run: () => { void loadConversations(); setShowHistory(true); },
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
    // Chat PLEIN ÉCRAN : la section remplit toute la surface disponible
    // (hauteur via la chaîne AppShell → layout → atelier, largeur bord à
    // bord) ; le fil défile en interne (flex-1 + min-h-0) et le composer
    // reste collé en bas. Bord à bord sur mobile/tablette, carte arrondie
    // sur grand écran. MODE PLEIN ÉCRAN ACTIVÉ : overlay « fixed inset-0 »
    // au-dessus de toute l'interface (rail, navigation, Zen) — le chat
    // occupe littéralement tout l'écran, sur mobile comme sur desktop.
    <section
      ref={sectionRef}
      className={`relative flex h-full min-h-0 flex-col overflow-hidden rounded-none border-0 bg-[var(--g3-deep)] shadow-none lg:rounded-[30px] lg:border lg:border-white/10 lg:shadow-[0_24px_70px_-28px_rgba(0,0,0,0.95)] ${fullscreen ? "fixed inset-0 z-[100] h-[100dvh] max-h-none w-screen lg:rounded-none lg:border-0 lg:shadow-none" : ""}`}
      aria-label={`Chat avec ${agent.name}`}
    >
      <div className="pointer-events-none absolute -left-32 -top-32 h-72 w-72 rounded-full bg-[var(--g3-surface)]/5 blur-3xl" aria-hidden="true" />
      <div className="pointer-events-none absolute -bottom-40 -right-20 h-80 w-80 rounded-full bg-[var(--g3-surface)]/5 blur-3xl" aria-hidden="true" />

      {/* En-tête : identité de l'agent */}
      <header className="relative flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3.5 md:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative">
            <Avatar name={agent.name} />
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--g3-border-strong)] bg-emerald-400" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-sm font-bold text-[var(--g3-text-secondary)]">{agent.name}</h2>
              <span className="rounded-full border border-white/15 bg-[var(--g3-surface)]/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--g3-text-secondary)]">{typeLabel}</span>
              <span className="rounded-full border border-white/10 bg-[var(--g3-surface)]/5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--g3-faint)]">{agent.agentMode === "call" ? "Agent d'appel" : "Agent standard"}</span>
            </div>
            <p className="mt-0.5 hidden truncate text-[11px] text-[var(--g3-faint)] sm:block">{agent.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={toggleFullscreen} aria-pressed={fullscreen} title={fullscreen ? "Quitter le plein écran (Échap)" : "Afficher le chat en plein écran"} className="rounded-xl border border-white/10 px-3 py-2 text-[11px] text-[var(--g3-faint)] transition hover:bg-[var(--g3-surface)]/5 hover:text-white">
            {fullscreen ? "◱ Quitter le plein écran" : "⛶ Plein écran"}
          </button>
          <button type="button" onClick={() => { void loadConversations(); setShowHistory((current) => !current); }} aria-expanded={showHistory} className="rounded-xl border border-white/10 px-3 py-2 text-[11px] text-[var(--g3-faint)] transition hover:bg-[var(--g3-surface)]/5 hover:text-white">Historique</button>
          <button type="button" onClick={resetConversation} disabled={loading} className="rounded-xl border border-white/10 px-3 py-2 text-[11px] text-[var(--g3-faint)] transition hover:bg-[var(--g3-surface)]/5 hover:text-white disabled:opacity-30">Nouveau</button>
        </div>
      </header>

      {agent.skills.length > 0 && (
        <div className="relative flex shrink-0 flex-wrap gap-1.5 border-b border-white/10 bg-[var(--g3-surface)]/[0.03] px-4 py-2.5 md:px-5" aria-label="Compétences de l'agent">
          {agent.skills.slice(0, 8).map((skill) => (
            <span key={skill} className="rounded-full border border-white/10 bg-[var(--g3-surface)]/5 px-2.5 py-1 text-[10px] font-medium text-[var(--g3-faint)]">{skill}</span>
          ))}
          {agent.skills.length > 8 && <span className="rounded-full px-2 py-1 text-[10px] text-[var(--g3-muted)]">+{agent.skills.length - 8}</span>}
          {agent.memoryFile && (
            <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-medium text-emerald-300">Mémoire : {agent.memoryFile.name}</span>
          )}
        </div>
      )}

      {showHistory && (
        <div className="relative shrink-0 border-b border-white/10 bg-[var(--g3-surface)]/[0.03] px-4 py-3 md:px-5" role="region" aria-label="Historique des conversations">
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
                    className={`min-w-0 flex-1 rounded-xl px-3 py-2 text-left text-xs transition ${conversation.id === conversationId ? "bg-[var(--g3-surface)]/10 text-white" : "bg-[var(--g3-surface)]/5 text-[var(--g3-faint)] hover:bg-[var(--g3-surface)]/10"}`}
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
                <div className="relative mx-auto grid h-20 w-20 place-items-center rounded-[24px] border border-white/15 bg-[var(--g3-surface)]/10 shadow-[0_14px_40px_-18px_rgba(255,255,255,0.25)]">
                  <Avatar name={agent.name} size="lg" />
                </div>
                <h3 className="mt-5 font-serif text-2xl font-bold tracking-tight text-[var(--g3-text-secondary)] md:text-3xl">Bonjour, je suis {agent.name}.</h3>
                <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-[var(--g3-faint)]">
                  {agent.description || "Votre agent IA personnalisé."} Je réponds à toutes vos questions et j&apos;exécute vos tâches —{" "}
                  <strong className="text-[var(--g3-text-secondary)]">spécialiste {typeLabel}</strong>, avec les outils et connecteurs fournis.
                </p>
                <div className="mt-6 grid gap-2 sm:grid-cols-2">
                  {quickPrompts.map((prompt) => (
                    <button key={prompt} type="button" onClick={() => { setMessage(prompt); composerRef.current?.focus(); }} className="rounded-2xl border border-white/10 bg-[var(--g3-surface)]/5 p-3 text-left text-xs leading-5 text-[var(--g3-faint)] transition duration-300 hover:-translate-y-0.5 hover:border-white/20 hover:bg-[var(--g3-surface)]/10 hover:text-white">
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
                <div className="mb-1.5 flex items-center gap-2 text-[9px] font-bold uppercase tracking-[.2em] text-[var(--g3-muted)]">
                  <span>{item.role === "user" ? "Vous" : agent.name}</span>
                  {item.role === "agent" && item.mode === "chat" && (
                    <span className="rounded-full border border-white/10 bg-[var(--g3-surface)]/5 px-2 py-0.5 text-[8px] font-bold tracking-wider text-[var(--g3-faint)] normal-case">Réponse directe</span>
                  )}
                  {item.role === "agent" && item.mode === "task" && (
                    <span className="rounded-full border border-white/15 bg-[var(--g3-surface)]/10 px-2 py-0.5 text-[8px] font-bold tracking-wider text-[var(--g3-text-secondary)] normal-case">Mission exécutée</span>
                  )}
                </div>
                <div className={item.role === "user"
                  ? "whitespace-pre-wrap rounded-2xl rounded-br-md bg-[var(--g3-elevated)] px-4 py-3.5 text-sm leading-6 text-[var(--g3-text)] shadow-[0_10px_30px_-16px_rgba(255,255,255,0.35)]"
                  : "rounded-2xl rounded-bl-md border border-white/10 bg-[var(--g3-elevated)]/60 px-4 py-3.5 text-sm leading-6 text-[var(--g3-text)]"}>
                  {item.role === "user" ? (
                    item.text
                  ) : (
                    /* Rendu markdown riche (titres, listes, code, liens) — sûr, sans innerHTML. */
                    <>
                      <MarkdownContent content={item.text} />
                      <div className="mt-2 flex justify-end">
                        <button
                          type="button"
                          onClick={() => { void navigator.clipboard?.writeText(item.text); }}
                          className="rounded-lg border border-white/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--g3-faint)] transition-colors hover:border-white/25 hover:text-[var(--g3-text-secondary)]"
                          aria-label="Copier la réponse"
                        >
                          Copier
                        </button>
                      </div>
                    </>
                  )}
                </div>

                {/* Image générée par l'agent (Agnes AI) — cliquable en plein écran + téléchargement. */}
                {item.imageUrl && (
                  <div className="mt-2">
                    <a href={item.imageUrl} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-2xl border border-white/10 shadow-[0_10px_30px_-16px_rgba(0,0,0,0.8)]" aria-label="Ouvrir l'image générée en plein écran">
                      {/* eslint-disable-next-line @next/next/no-img-element -- URL externe (CDN Agnes) signée par le provider, pas de domaine fixe pour next/image */}
                      <img src={item.imageUrl} alt="Image générée par IA" loading="lazy" className="max-h-96 w-auto max-w-full bg-[var(--g3-elevated)] object-contain" />
                    </a>
                    <div className="mt-1 flex justify-end">
                      <button
                        type="button"
                        onClick={() => void downloadUrl(item.imageUrl as string, `image-gen3ia-${Date.now()}.png`)}
                        className="rounded-full border border-[rgba(148,153,255,0.25)] px-2.5 py-1 text-[10px] font-medium text-[var(--g3-muted)] transition hover:border-[rgba(124,92,255,0.5)] hover:text-white"
                      >
                        <span aria-hidden>⬇</span> Télécharger
                      </button>
                    </div>
                  </div>
                )}

                {/* Trace d'exécution + approbations (mode task uniquement) */}
                {/* Résultat SEUL à l'écran : le détail du plan d'exécution
                    n'est affiché que lorsqu'il demande une action de
                    l'utilisateur (validation requise) ou en cas d'échec. */}
                {item.result && (item.result.status === "waiting_approval" || item.result.status === "failed") && (
                  <div className="mt-2 rounded-2xl border border-white/10 bg-[var(--g3-deep)] p-3">
                    <p className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-[var(--g3-faint)]">
                      <span>Plan d&apos;exécution · {statusLabel(item.result.status)}</span>
                    </p>
                    <ol className="mt-2 space-y-1.5">
                        {item.result.plan?.steps?.map((step) => (
                          <li key={step.id} className="flex items-start gap-2 text-xs">
                            <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${step.status === "completed" ? "bg-[var(--g3-success)]" : step.status === "failed" ? "bg-[var(--g3-danger)]" : step.status === "waiting_approval" ? "bg-[var(--g3-warning)]" : "bg-[var(--g3-faint)]"}`} aria-hidden="true" />
                            <span className="min-w-0">
                              <span className="block truncate font-medium text-[var(--g3-text-secondary)]">{step.name || step.id}</span>
                              {step.toolName && <span className="block text-[10px] text-[var(--g3-muted)]">Outil : {toolLabel(step.toolName)}</span>}
                            </span>
                            <span className={`ml-auto shrink-0 text-[10px] font-semibold ${statusClass(step.status)}`}>{statusLabel(step.status)}</span>
                          </li>
                        ))}
                    </ol>
                    {item.result.status === "waiting_approval" && pendingApprovals.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {pendingApprovals.map((approval) => (
                          <div key={approval.id} className="rounded-xl border border-amber-400/25 bg-amber-400/10 p-3">
                            <p className="text-xs font-semibold text-amber-200">Action sensible : {approvalToolLabel(approval.toolName, approval.toolSlug)}</p>
                            {approval.reason && <p className="mt-0.5 text-[11px] leading-5 text-amber-200/80">{approval.reason}</p>}
                            <div className="mt-2 flex gap-2">
                              <button type="button" onClick={() => void decideApproval(approval.id, "approve")} disabled={loading} className="rounded-lg bg-[var(--g3-surface)] px-3 py-1.5 text-[11px] font-semibold text-[var(--g3-text)] transition hover:bg-[var(--g3-elevated)] disabled:opacity-40">Approuver</button>
                              <button type="button" onClick={() => void decideApproval(approval.id, "reject")} disabled={loading} className="rounded-lg border border-amber-400/30 bg-transparent px-3 py-1.5 text-[11px] font-semibold text-amber-200 transition hover:bg-amber-400/20 disabled:opacity-40">Rejeter</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {item.result.status === "failed" && item.result.resumable && item.result.executionId && (
                      <div className="mt-3 rounded-xl border border-sky-400/25 bg-sky-400/10 p-3">
                        <p className="text-[11px] leading-5 text-sky-200/90">
                          Le travail déjà réalisé est conservé (étapes réussies et leurs résultats). La reprise n&apos;exécute que les étapes restantes.
                        </p>
                        <button
                          type="button"
                          onClick={() => void continueMission(item.result!.executionId)}
                          disabled={loading}
                          className="mt-2 rounded-lg bg-[var(--g3-surface)] px-3 py-1.5 text-[11px] font-semibold text-[var(--g3-text)] transition hover:bg-[var(--g3-elevated)] disabled:opacity-40"
                        >
                          Continuer la mission
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}

            {missionLive && (
              <div className="mr-auto max-w-[88%] space-y-2">
                {/* Mission LIVE : avancement réel des étapes (polling des runs) —
                    affiché pendant l'exécution ET après un refresh (reprise) */}
                {liveRun && liveRun.steps.length > 0 && (
                  <div className="rounded-2xl border border-white/10 bg-[var(--g3-deep)] p-3" aria-live="polite">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--g3-faint)]">
                      Mission en cours · {liveRun.steps.filter((s) => s.status === "completed").length}/{liveRun.steps.length} étapes
                    </p>
                    <ul className="mt-2 space-y-1.5">
                      {liveRun.steps.map((step) => (
                        <li key={step.id} className="flex items-center gap-2 text-xs text-[var(--g3-muted)]">
                          <span className={
                            "mt-0.5 h-2 w-2 shrink-0 rounded-full " +
                            (step.status === "completed" ? "bg-[var(--g3-success)]"
                              : step.status === "failed" ? "bg-[var(--g3-danger)]"
                              : step.status === "running" ? "animate-pulse bg-[var(--g3-primary-strong)]"
                              : step.status === "waiting_approval" ? "bg-[var(--g3-warning)]"
                              : "bg-[var(--g3-faint)]")
                          } aria-hidden="true" />
                          <span className={step.status === "running" ? "font-semibold text-[var(--g3-text-secondary)]" : ""}>{step.name}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {loading ? (
                  <div className="mr-auto flex items-center gap-3 rounded-2xl border border-white/10 bg-[var(--g3-elevated)] px-4 py-3 text-xs text-[var(--g3-faint)]">
                    <Gen3iaLogo size={26} working alt="" />
                    <span className="flex gap-1" aria-hidden="true"><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--g3-primary-strong)]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--g3-magenta)] [animation-delay:120ms]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--g3-secondary)] [animation-delay:240ms]" /></span>
                    J&apos;analyse votre demande — réponse ou exécution selon le besoin…
                  <button
                    type="button"
                    onClick={stopAgent}
                    className="ml-1 flex items-center gap-1.5 rounded-full border border-[rgba(239,68,68,0.45)] bg-[rgba(239,68,68,0.12)] px-3 py-1 text-[11px] font-semibold text-[#f87171] transition hover:bg-[rgba(239,68,68,0.22)]"
                    aria-label="Arrêter l'agent"
                  >
                    <span className="inline-block h-1.5 w-1.5 rounded-[2px] bg-[#f87171]" aria-hidden="true" />
                    Arrêter
                  </button>
                  </div>
                ) : (
                  /* Reprise après refresh : la mission a survécu à l'actualisation
                     (elle appartient au serveur) — l'utilisateur le VOIT et peut
                     l'arrêter, au lieu d'un fil qui semble inactif. */
                  <div className="mr-auto flex flex-wrap items-center gap-3 rounded-2xl border border-sky-400/25 bg-sky-400/10 px-4 py-3 text-xs text-sky-100" aria-live="polite">
                    <Gen3iaLogo size={26} working alt="" />
                    <span>
                      <span className="font-semibold">Mission en cours d&apos;exécution</span> — elle continue côté serveur, même après l&apos;actualisation de la page. Le résultat s&apos;affichera ici dès qu&apos;elle sera livrée.
                    </span>
                    <button
                      type="button"
                      onClick={stopAgent}
                      className="ml-auto flex items-center gap-1.5 rounded-full border border-[rgba(239,68,68,0.45)] bg-[rgba(239,68,68,0.12)] px-3 py-1 text-[11px] font-semibold text-[#f87171] transition hover:bg-[rgba(239,68,68,0.22)]"
                      aria-label="Arrêter la mission en cours"
                    >
                      <span className="inline-block h-1.5 w-1.5 rounded-[2px] bg-[#f87171]" aria-hidden="true" />
                      Arrêter
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Zone de saisie : CommandComposer unifié (identique au chat IA) —
            collée en bas, au-dessus de la zone sûre (encoche/barre iOS) */}
        <div className="shrink-0 border-t border-white/10 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:p-4 md:pb-[max(1rem,env(safe-area-inset-bottom))]">
          {error && <Callout tone="error" className="mb-3 rounded-2xl">{error}</Callout>}
          <CommandComposer
            ref={composerRef}
            value={message}
            onValueChange={setMessage}
            onSubmit={submit}
            disabled={loading || uploading}
            
            placeholder="Posez n'importe quelle question… Tapez @ pour mentionner des compétences ou connecteurs, ou / pour les commandes"
            loadMentions={loadMentions}
            activatedMentions={activated}
            onActivateMention={activateConnector}
            onDeactivateMention={deactivateConnector}
            commands={composerCommands}
            plusAction="file"
            attachmentName={attachments.length === 0 ? null : attachments.length === 1 ? attachments[0].file.name : `${attachments.length} fichiers joints`}
            attachmentUploading={uploading}
            onRemoveAttachment={() => setAttachments([])}
            onFile={(file) => void handleAttachment(file)}
            authorizationMode={authorizationMode}
            onAuthorizationModeChange={setAuthorizationMode}
          />
          <p className="mt-2 text-center text-[10px] text-[var(--g3-muted)]">
            {agent.name} répond à tout et agit avec les outils fournis ({typeLabel.toLowerCase()}) · Entrée envoie · Maj+Entrée nouvelle ligne
          </p>
        </div>
      </div>
    </section>
  );
}
