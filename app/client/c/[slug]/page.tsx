"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

/**
 * Salon client public (/client/c/<slug>) — sans compte.
 *
 * Les clients de l'utilisateur conversent ici avec son agent commercial,
 * nourri par la fiche entreprise complète. Mobile-first, transcript
 * persisté côté serveur, lead capture discret (nom + contact).
 */

interface Greeting {
  companyName: string;

  agentName: string;

  welcomeMessage: string;

  language: string;
}

interface Bubble {
  role: "client" | "assistant";

  text: string;
}

export default function ClientCommercialPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;

  const [greeting, setGreeting] = useState<Greeting | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [clientName, setClientName] = useState("");
  const [clientContact, setClientContact] = useState("");
  const [showLead, setShowLead] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/public/commercial/${encodeURIComponent(slug)}`, { cache: "no-store" });
        const data = await response.json();
        if (cancelled) return;
        if (!response.ok) throw new Error(data.error || "Salon indisponible.");
        setGreeting(data);
        setBubbles([{ role: "assistant", text: data.welcomeMessage }]);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Salon indisponible.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [slug]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [bubbles, sending]);

  async function send() {
    const message = input.trim();
    if (!message || sending || !slug) return;
    setSending(true);
    setError("");
    setInput("");
    setBubbles((current) => [...current, { role: "client", text: message }]);
    try {
      const response = await fetch(`/api/public/commercial/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message,
          ...(conversationId ? { conversationId } : {}),
          ...(clientName ? { clientName } : {}),
          ...(clientContact ? { clientContact } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Réponse indisponible.");
      if (data.conversationId) setConversationId(data.conversationId);
      setBubbles((current) => [...current, { role: "assistant", text: data.text }]);
      // Le lead devient utile après le premier échange : on propose
      // discrètement de laisser ses coordonnées.
      if (!clientName && !clientContact && bubbles.length >= 2) setShowLead(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Réponse indisponible.");
      setBubbles((current) => [...current, { role: "assistant", text: "Désolé, je n'ai pas pu traiter votre message. Réessayez dans un instant." }]);
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

  const theme = {
    background: "linear-gradient(180deg,#0f172a 0%,#1e293b 100%)",
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col" style={theme}>
      <header className="flex items-center gap-3 px-4 py-4 text-white">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500 text-lg font-black">
          {greeting?.companyName?.charAt(0).toUpperCase() ?? "?"}
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-base font-bold">{greeting?.companyName ?? "Chargement…"}</h1>
          <p className="truncate text-xs text-neutral-300">{greeting ? `Assistant ${greeting.agentName}` : ""}</p>
        </div>
      </header>

      <section className="flex flex-1 flex-col gap-2 overflow-y-auto rounded-t-3xl bg-neutral-50 px-4 py-4" aria-live="polite">
        {loading && <p className="mx-auto text-sm text-neutral-500">Connexion à l&apos;assistant…</p>}
        {error && !greeting && <p className="mx-auto rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {bubbles.map((bubble, index) => (
          <article
            key={index}
            className={
              bubble.role === "client"
                ? "ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-neutral-900 px-4 py-2.5 text-sm text-white"
                : "mr-auto max-w-[85%] rounded-2xl rounded-bl-md border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-800"
            }
          >
            {bubble.text}
          </article>
        ))}
        {sending && <p className="mr-auto text-xs text-neutral-500">L&apos;assistant écrit…</p>}

        {showLead && (
          <div className="mr-auto max-w-[90%] rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
            <p className="mb-1 font-semibold">Souhaitez-vous laisser vos coordonnées pour être recontacté ?</p>
            <div className="flex gap-1">
              <input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Votre nom" className="w-full rounded-lg border border-emerald-200 px-2 py-1.5 text-xs" />
              <input value={clientContact} onChange={(e) => setClientContact(e.target.value)} placeholder="Tél ou email" className="w-full rounded-lg border border-emerald-200 px-2 py-1.5 text-xs" />
            </div>
            <button type="button" onClick={() => setShowLead(false)} className="mt-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white">Enregistrer</button>
          </div>
        )}
        <div ref={endRef} />
      </section>

      <footer className="px-4 pb-4 pt-2">
        {error && greeting && <p className="mb-1 text-center text-xs text-red-600">{error}</p>}
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            placeholder="Votre message…"
            maxLength={2_000}
            className="max-h-32 flex-1 resize-none rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-sm"
            disabled={sending}
            aria-label="Votre message"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || !input.trim()}
            className="rounded-full bg-emerald-500 px-5 py-3 text-sm font-bold text-white disabled:opacity-40"
          >
            Envoyer
          </button>
        </div>
      </footer>
    </main>
  );
}
