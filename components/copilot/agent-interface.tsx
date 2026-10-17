"use client";

/**
 * Étape 4 — Interface Utilisateur du copilote (AgentInterface).
 *
 * Panneau latéral immersif : état du flux en direct (indicateur « En direct /
 * Streaming »), fil de conversation (questions de l'utilisateur + réponses
 * du copilote en streaming token par token), suggestions contextuelles
 * cliquables générées après chaque réponse (heuristique déterministe du
 * projet — zéro appel LLM), composer avec bouton Stop (abort du flux).
 *
 * Style : tokens AURORA OS (--g3-*) uniquement — zéro hex brut, design sans
 * bordures, rayon --gen3ia-radius.
 */

import { type FormEvent, useEffect, useRef, useState } from "react";

import { buildFollowUpSuggestions } from "@/lib/domain/conversations/follow-ups";
import type { CopilotSocketMessage } from "./use-copilot-websocket";

export interface AgentInterfaceProps {
  messages: CopilotSocketMessage[];
  /** Une réponse est en cours de streaming (bouton Stop actif). */
  busy: boolean;
  /** Capture d'écran active (indicateur « En direct »). */
  live: boolean;
  disabled: boolean;
  disabledReason: string | null;
  onAsk: (text: string) => void;
  onStop: () => void;
}

/** Rendu markdown minimal (gras, code inline, blocs de code avec copie). */
function renderContent(content: string): string {
  const escaped = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code: string) =>
      `<pre><code>${code.replace(/\n$/, "")}</code></pre>`)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br/>");
}

export function AgentInterface({
  messages,
  busy,
  live,
  disabled,
  disabledReason,
  onAsk,
  onStop,
}: AgentInterfaceProps) {
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant" && !message.streaming && message.content.trim().length > 0);
  const suggestions = lastAssistant && !busy ? buildFollowUpSuggestions(messages[messages.length - 2]?.content ?? "", lastAssistant.content) : [];

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
  }, [draft]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy || disabled) return;
    onAsk(text);
    setDraft("");
  };

  const copyMessage = async (message: CopilotSocketMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(message.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // presse-papier indisponible : silencieux
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 p-3 sm:p-4" aria-label="Copilote visuel">
      {/* Fil de conversation */}
      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        className="flex-1 min-h-0 overflow-y-auto rounded-[var(--gen3ia-radius)] bg-[var(--g3-surface)] p-3 sm:p-4"
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl text-xl font-bold text-white" style={{ background: "var(--g3-gradient)" }} aria-hidden>
              IA
            </div>
            <h2 className="text-lg font-semibold text-[var(--g3-text)]">Copilote visuel temps réel</h2>
            <p className="max-w-sm text-sm leading-relaxed text-[var(--g3-muted)]">
              Partagez votre écran, puis posez vos questions : le copilote voit ce que vous voyez et vous guide étape par étape — boutons, formulaires, erreurs, code, pages web.
            </p>
          </div>
        ) : (
          <ol className="flex flex-col gap-3">
            {messages.map((message) => (
              <li
                key={message.id}
                className={message.role === "user" ? "flex justify-end" : "flex justify-start"}
              >
                <div
                  className={
                    message.role === "user"
                      ? "max-w-[85%] rounded-[18px] rounded-tr-[4px] px-3.5 py-2.5 text-sm text-white"
                      : `max-w-[92%] rounded-[18px] rounded-tl-[4px] px-3.5 py-2.5 text-sm leading-relaxed ${message.error ? "text-[var(--g3-danger-strong)]" : "text-[var(--g3-text)]"}`
                  }
                  style={message.role === "user" ? { background: "var(--g3-gradient)" } : { background: "var(--g3-elevated)" }}
                >
                  {message.role === "assistant" ? (
                    <>
                      <div className="copilot-md" dangerouslySetInnerHTML={{ __html: renderContent(message.content) }} />
                      {message.streaming ? <span className="copilot-cursor" aria-hidden /> : null}
                      {!message.streaming && message.content.trim() ? (
                        <button
                          type="button"
                          onClick={() => void copyMessage(message)}
                          className="mt-1.5 text-[11px] font-medium text-[var(--g3-muted)] transition hover:text-[var(--g3-secondary-strong)]"
                        >
                          {copied === message.id ? "Copié ✓" : "Copier"}
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <span className="whitespace-pre-wrap">{message.content}</span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}

        {/* Suggestions contextuelles cliquables */}
        {suggestions.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => onAsk(suggestion)}
                className="rounded-full bg-[var(--g3-elevated)] px-3 py-1.5 text-xs text-[var(--g3-text-secondary)] transition hover:text-[var(--g3-text)]"
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Composer */}
      <form
        onSubmit={submit}
        className="flex items-end gap-2 rounded-[var(--gen3ia-radius)] bg-[var(--g3-surface)] p-2.5"
      >
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
            event.stopPropagation();
          }}
          rows={1}
          disabled={disabled}
          placeholder={disabled ? (disabledReason ?? "Connexion en cours…") : "Posez votre question sur ce que vous voyez à l'écran…"}
          aria-label="Votre question au copilote"
          className="max-h-[132px] min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-[var(--g3-text)] placeholder:text-[var(--g3-faint)] focus:outline-none disabled:opacity-60"
        />
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            className="flex h-10 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-semibold text-white"
            style={{ background: "var(--g3-gradient)" }}
          >
            <span className="h-2.5 w-2.5 rounded-sm bg-white" aria-hidden /> Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={disabled || draft.trim().length === 0}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white transition disabled:opacity-40"
            style={{ background: "var(--g3-gradient)" }}
            aria-label="Envoyer"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </form>

      <p className="px-1 text-[11px] text-[var(--g3-faint)]">
        {live ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="copilot-live-dot" aria-hidden /> En direct — le copilote voit votre écran
          </span>
        ) : (
          "Le copilote répond dès qu'un écran est partagé."
        )}
      </p>
    </section>
  );
}
