"use client";

import { useEffect, useRef, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { CommandComposer, type CommandComposerHandle } from "@/components/ui/command-composer";
import type { MentionItem } from "@/lib/ui/command-composer-helpers";

/**
 * Widget GEN — chat IA de la page d'accueil (bouton flottant + panneau).
 *
 * Interface sombre unifiée : le composer est le CommandComposer commun à
 * tous les chats Gen3ia (réplique de la maquette validée : @ compétences /
 * connecteurs, / commandes, « Toujours demander ▼ », 🎙, bouton ↑).
 *
 * Surface ISOLÉE par construction : gen répond aux visiteurs et peut exécuter
 * des tâches simples via les connecteurs de l'utilisateur connecté, en
 * lecture stricte uniquement. Aucun outil d'agent (fichiers, code,
 * documents…) n'est accessible depuis ce chat : le bouton « + » ouvre les
 * sources connectées (jamais de faux téléversement).
 */

interface GenBubble {
  role: "user" | "gen";
  text: string;
}

interface GenConnector {
  toolkit: string;
  label: string;
  description: string;
  category: string;
  connected: boolean;
}

const GEN_PLACEHOLDER = "Posez n'importe quelle question… Tapez @ pour mentionner des compétences ou connecteurs, ou / pour les commandes";

export function GenChatWidget() {
  const [open, setOpen] = useState(false);
  const [bubbles, setBubbles] = useState<GenBubble[]>([
    {
      role: "gen",
      text: "Bonjour ! Je suis Gen, l'assistante Gen3ia. Posez-moi vos questions sur la plateforme — et si vous êtes connecté, je peux aussi consulter vos applications connectées (recherches et lectures uniquement).",
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<GenConnector[]>([]);
  const [activated, setActivated] = useState<MentionItem[]>([]);
  const composerRef = useRef<CommandComposerHandle | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [bubbles, open, sending]);

  useEffect(() => {
    if (!open || connectors.length > 0) return;
    void authFetch("/api/integrations/mention?q=", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json();
        setConnectors(Array.isArray(data.connectors) ? data.connectors.filter((item: GenConnector) => item.connected) : []);
      })
      .catch(() => undefined);
  }, [open, connectors.length]);

  // Le sélecteur « @ » du CommandComposer : mêmes connecteurs que l'ancien menu.
  const loadMentions = async (query: string): Promise<MentionItem[]> => {
    if (connectors.length > 0 && !query) {
      return connectors.map((connector) => ({ ...connector }));
    }
    try {
      const response = await authFetch(`/api/integrations/mention?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      if (!response.ok) return [];
      const data = await response.json();
      return (Array.isArray(data.connectors) ? (data.connectors as GenConnector[]) : []).map((connector) => ({ ...connector }));
    } catch {
      return [];
    }
  };

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = input.trim();
    if (!message || sending) return;
    setSending(true);
    setInput("");
    setBubbles((current) => [...current, { role: "user", text: message }]);
    try {
      // Historique client : les derniers échanges (hors message d'accueil)
      // accompagnent la requête pour donner à Gen une mémoire de fil pour
      // les visiteurs anonymes — sans aucune persistance serveur (vie privée).
      const history = bubbles
        .slice(1) // exclut le message d'accueil
        .slice(-6)
        .map((bubble) => ({
          role: bubble.role === "user" ? ("user" as const) : ("assistant" as const),
          content: bubble.text.slice(0, 2_000),
        }));
      // authFetch : session incluse si connecté (sinon 401 gérée côté API
      // qui bascule sur le mode visiteur).
      const response = await authFetch("/api/gen/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message,
          ...(conversationId ? { conversationId } : {}),
          ...(activated.length > 0 ? { selectedConnectors: activated.map((item) => item.toolkit) } : {}),
          ...(history.length > 0 ? { history } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Gen est indisponible.");
      if (data.conversationId) setConversationId(data.conversationId);
      setBubbles((current) => [
        ...current,
        {
          role: "gen",
          text: data.reply + (data.connectorUsed ? `\n\n(consultation ${data.connectorUsed.toolkit})` : ""),
        },
      ]);
    } catch (e) {
      setBubbles((current) => [
        ...current,
        { role: "gen", text: e instanceof Error ? e.message : "Gen est momentanément indisponible." },
      ]);
    } finally {
      setSending(false);
    }
  }

  const genCommands = [
    {
      id: "connecteurs",
      label: "Choisir des connecteurs",
      description: "Mentionnez une application connectée à consulter (lecture seule).",
      run: () => composerRef.current?.openMentions(),
    },
    {
      id: "effacer",
      label: "Effacer la conversation",
      description: "Vide le fil affiché (aucune trace serveur pour les visiteurs).",
      run: () => {
        setConversationId(null);
        setBubbles([{ role: "gen", text: "Nouvelle conversation. Posez-moi vos questions sur Gen3ia !" }]);
      },
    },
  ];

  return (
    <>
      {open && (
        <div className="fixed bottom-24 right-4 z-50 flex h-[560px] w-[min(94vw,420px)] flex-col overflow-hidden rounded-[30px] border border-white/10 bg-[#0b0b0d] shadow-[0_30px_80px_-24px_rgba(0,0,0,0.95)] sm:right-6" role="dialog" aria-label="Chat avec Gen">
          <header className="flex items-center gap-3 border-b border-white/10 bg-[#131315] px-4 py-3 text-white">
            <div className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-lg font-black text-neutral-100">G</div>
            <div className="flex-1">
              <p className="text-sm font-bold text-neutral-100">Gen — assistante Gen3ia</p>
              <p className="text-[11px] text-neutral-400">Réponses + consultations connecteurs (lecture seule)</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Fermer le chat" className="rounded-full px-2 py-1 text-lg leading-none text-neutral-400 hover:bg-white/10 hover:text-white">×</button>
          </header>

          <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 py-3">
            {bubbles.map((bubble, index) => (
              <article
                key={index}
                className={
                  bubble.role === "user"
                    ? "ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-neutral-100 px-3.5 py-2 text-sm text-neutral-900"
                    : "mr-auto max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-bl-md border border-white/10 bg-[#1b1b1d] px-3.5 py-2 text-sm text-neutral-100"
                }
              >
                {bubble.text}
              </article>
            ))}
            {sending && (
              <p className="mr-auto flex items-center gap-2 text-xs text-neutral-500">
                <span className="flex gap-1" aria-hidden="true">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-500 [animation-delay:120ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-400 [animation-delay:240ms]" />
                </span>
                Gen écrit…
              </p>
            )}
            <div ref={endRef} />
          </div>

          <div className="p-2.5">
            <CommandComposer
              ref={composerRef}
              value={input}
              onValueChange={setInput}
              onSubmit={send}
              disabled={sending}
              maxLength={2_000}
              placeholder={GEN_PLACEHOLDER}
              plusAction="mentions"
              loadMentions={loadMentions}
              activatedMentions={activated}
              onActivateMention={(item) => setActivated((current) => (current.some((active) => active.toolkit === item.toolkit) ? current : [...current, item]))}
              onDeactivateMention={(toolkit) => setActivated((current) => current.filter((item) => item.toolkit !== toolkit))}
              commands={genCommands}
            />
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="fixed bottom-6 right-4 z-50 flex h-14 items-center gap-2 rounded-full border border-white/15 bg-[#141416] px-5 text-sm font-bold text-white shadow-[0_18px_50px_-16px_rgba(0,0,0,0.9)] transition-transform hover:scale-105 sm:right-6"
        aria-expanded={open}
      >
        <span className="text-lg" aria-hidden="true">💬</span>
        {open ? "Fermer Gen" : "Discuter avec Gen"}
      </button>
    </>
  );
}
