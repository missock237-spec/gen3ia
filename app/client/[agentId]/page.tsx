"use client";

import { FormEvent, useEffect, useState } from "react";

export default function ClientAgentPage({ params }: { params: Promise<{ agentId: string }> }) {
  const [agentId, setAgentId] = useState<string | null>(null);
  const [agent, setAgent] = useState<{ name: string; description: string } | null>(null);
  const [messages, setMessages] = useState<Array<{ role: "client" | "agent"; text: string }>>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { void params.then(({ agentId: id }) => { setAgentId(id); void fetch(`/api/public/agents/${id}`).then(async (response) => { if (!response.ok) throw new Error("Agent indisponible"); setAgent(await response.json()); }).catch(() => setError("Cet agent n'est pas disponible.")); }); }, [params]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text || !agentId || loading) return;
    setMessage(""); setError(""); setMessages((items) => [...items, { role: "client", text }]); setLoading(true);
    try {
      const response = await fetch(`/api/public/agents/${agentId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: text }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Réponse indisponible.");
      setMessages((items) => [...items, { role: "agent", text: data.text }]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Réponse indisponible."); }
    finally { setLoading(false); }
  }

  function startVoice() {
    const SpeechRecognition = (window as Window & { SpeechRecognition?: new () => { lang: string; start: () => void; onresult: (event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void } }).SpeechRecognition;
    if (!SpeechRecognition) { setError("La saisie vocale n'est pas disponible sur ce navigateur."); return; }
    const recognition = new SpeechRecognition(); recognition.lang = "fr-FR"; recognition.onresult = (event) => setMessage(event.results[0][0].transcript); recognition.start();
  }

  return <main className="min-h-screen bg-[var(--g3-elevated)] px-4 py-6 text-neutral-950 sm:px-6"><div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-2xl flex-col overflow-hidden rounded-[2rem] border border-[var(--g3-border)] bg-[var(--g3-surface)] shadow-xl"><header className="flex items-center gap-3 border-b border-[var(--g3-border)] px-5 py-4"><div className="flex size-11 items-center justify-center rounded-2xl bg-sky-100 text-sky-700">✦</div><div><h1 className="font-semibold">{agent?.name ?? "Agent Gen3ia"}</h1><p className="text-sm text-[var(--g3-muted)]">{agent?.description || "Répondez à vos questions avec notre assistant."}</p></div><span className="ml-auto flex items-center gap-1.5 text-xs text-emerald-600"><span className="size-2 rounded-full bg-emerald-500" />En ligne</span></header><section className="flex-1 space-y-4 overflow-y-auto bg-[var(--g3-elevated)]/70 p-4 sm:p-6"><div className="max-w-[85%] rounded-2xl rounded-tl-md bg-[var(--g3-surface)] px-4 py-3 text-sm leading-6 shadow-sm">Bonjour, comment puis-je vous aider aujourd&apos;hui ?</div>{messages.map((item, index) => <div key={`${item.role}-${index}`} className={`flex ${item.role === "client" ? "justify-end" : "justify-start"}`}><div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-6 ${item.role === "client" ? "rounded-br-md bg-neutral-950 text-white" : "rounded-bl-md bg-[var(--g3-surface)] shadow-sm"}`}>{item.text}</div></div>)}{loading && <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-[var(--g3-surface)] px-4 py-3 text-sm text-[var(--g3-muted)] shadow-sm">L&apos;agent réfléchit…</div>}</section>{error && <p role="alert" className="border-t border-red-100 bg-red-50 px-5 py-3 text-sm text-red-700">{error}</p>}<form onSubmit={send} className="flex items-end gap-2 border-t border-[var(--g3-border)] bg-[var(--g3-surface)] p-4"><button type="button" onClick={startVoice} aria-label="Parler à l'agent" className="flex size-11 shrink-0 items-center justify-center rounded-full border border-[var(--g3-border)] text-lg hover:bg-[var(--g3-elevated)]">⌕</button><textarea value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} rows={1} placeholder="Écrivez votre message…" className="max-h-28 min-h-11 flex-1 resize-none rounded-2xl border border-[var(--g3-border)] px-4 py-3 text-sm outline-none focus:border-sky-500" /><button type="submit" disabled={!message.trim() || loading} className="flex size-11 shrink-0 items-center justify-center rounded-full bg-neutral-950 text-white disabled:opacity-40" aria-label="Envoyer">↑</button></form><div className="flex items-center justify-center gap-4 pb-3 text-xs text-[var(--g3-faint)]"><a href="sms:" className="hover:text-[var(--g3-text-secondary)]">SMS</a><button type="button" onClick={startVoice} className="hover:text-[var(--g3-text-secondary)]">Voix</button><span>Propulsé par Gen3ia</span></div></div></main>;
}
