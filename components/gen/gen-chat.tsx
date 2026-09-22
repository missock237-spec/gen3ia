"use client";

import { useEffect, useRef, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";

/**
 * Widget GEN — chat IA de la page d'accueil (bouton flottant + panneau).
 *
 * Surface ISOLÉE par construction : gen répond aux visiteurs et peut exécuter
 * des tâches simples via les connecteurs de l'utilisateur connecté, en
 * lecture stricte uniquement. Aucun outil d'agent (fichiers, code,
 * documents…) n'est accessible depuis ce chat.
 */

interface GenBubble {
  role: "user" | "gen";

  text: string;
}

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
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [bubbles, open, sending]);

  async function send() {
    const message = input.trim();
    if (!message || sending) return;
    setSending(true);
    setInput("");
    setBubbles((current) => [...current, { role: "user", text: message }]);
    try {
      // authFetch : session incluse si connecté (sinon 401 géré côté API
      // qui bascule sur le mode visiteur).
      const response = await authFetch("/api/gen/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, ...(conversationId ? { conversationId } : {}) }),
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

  function onKey(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <>
      {open && (
        <div className="fixed bottom-24 right-4 z-50 flex h-[520px] w-[min(94vw,380px)] flex-col overflow-hidden rounded-3xl border border-[rgba(15,23,42,0.14)] bg-white shadow-2xl sm:right-6" role="dialog" aria-label="Chat avec Gen">
          <header className="flex items-center gap-3 bg-gradient-to-r from-sky-600 to-indigo-600 px-4 py-3 text-white">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-lg font-black">G</div>
            <div className="flex-1">
              <p className="text-sm font-bold">Gen — assistante Gen3ia</p>
              <p className="text-[11px] text-white/80">Réponses + consultations connecteurs (lecture seule)</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Fermer le chat" className="rounded-full px-2 py-1 text-lg leading-none hover:bg-white/10">×</button>
          </header>

          <div className="flex flex-1 flex-col gap-2 overflow-y-auto bg-neutral-50 px-3 py-3">
            {bubbles.map((bubble, index) => (
              <article
                key={index}
                className={
                  bubble.role === "user"
                    ? "ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-neutral-900 px-3.5 py-2 text-sm text-white"
                    : "mr-auto max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-bl-md border border-neutral-200 bg-white px-3.5 py-2 text-sm text-neutral-800"
                }
              >
                {bubble.text}
              </article>
            ))}
            {sending && <p className="mr-auto text-xs text-neutral-500">Gen écrit…</p>}
            <div ref={endRef} />
          </div>

          <footer className="border-t border-neutral-200 bg-white p-2.5">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKey}
                rows={1}
                maxLength={2_000}
                placeholder="Votre message à Gen…"
                disabled={sending}
                className="max-h-28 flex-1 resize-none rounded-2xl border border-neutral-200 px-3 py-2.5 text-sm"
                aria-label="Message pour Gen"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={sending || !input.trim()}
                className="rounded-full bg-gradient-to-r from-sky-600 to-indigo-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"
              >
                Envoyer
              </button>
            </div>
          </footer>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="fixed bottom-6 right-4 z-50 flex h-14 items-center gap-2 rounded-full bg-gradient-to-r from-sky-600 to-indigo-600 px-5 text-sm font-bold text-white shadow-xl transition-transform hover:scale-105 sm:right-6"
        aria-expanded={open}
      >
        <span className="text-lg">💬</span>
        {open ? "Fermer Gen" : "Discuter avec Gen"}
      </button>
    </>
  );
}
