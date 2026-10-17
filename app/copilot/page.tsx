"use client";

/**
 * Copilote visuel temps réel — page autonome immersive.
 *
 * Architecture (spécification) :
 *  - ScreenCapturer (getDisplayMedia + extraction canvas 1 frame / 2 s) ;
 *  - useCopilotWebsocket (canal bidirectionnel temps réel persistant) ;
 *  - AgentInterface (panneau conversation + suggestions + Stop) ;
 *  - agentHandler côté gateway (analyse vision streaming — OpenRouter /
 *    OpenAI / Groq selon l'environnement).
 *
 * Session live créée à l'ouverture (mode navigateur, permission screen.read),
 * supprimée à la fermeture. L'utilisateur garde TOUJOURS le contrôle : le
 * partage d'écran démarre par un geste explicite, la vision n'analyse que la
 * dernière frame reçue, uniquement quand une question est posée.
 */

import "./copilot.css";

import { useCallback, useEffect, useRef, useState } from "react";

import { watchAuth } from "@/lib/firebase/client";
import { authFetch } from "@/lib/firebase/auth-client";
import { AgentInterface } from "@/components/copilot/agent-interface";
import { useScreenCapturer } from "@/components/copilot/screen-capturer";
import { useCopilotWebsocket, type CopilotSocketMessage } from "@/components/copilot/use-copilot-websocket";

interface CreatedSession {
  session: { id: string };
  pairingToken: string;
}

const CAPTURE_LABELS: Record<string, string> = {
  idle: "Écran non partagé",
  unsupported: "Partage d'écran non pris en charge par ce navigateur",
  requesting: "Sélection de l'écran…",
  active: "Capture en cours",
  paused: "Capture en pause",
  error: "Erreur de partage",
};

function deviceId(): string {
  try {
    const existing = window.sessionStorage.getItem("gen3ia_copilot_device");
    if (existing) return existing;
    const generated = `copilot_${crypto.randomUUID()}`;
    window.sessionStorage.setItem("gen3ia_copilot_device", generated);
    return generated;
  } catch {
    return `copilot_${Math.random().toString(36).slice(2)}`;
  }
}

export default function CopilotPage() {
  const [user, setUser] = useState<{ uid: string } | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [session, setSession] = useState<CreatedSession | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [messages, setMessages] = useState<CopilotSocketMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const streamIdRef = useRef(0);
  const messageSeqRef = useRef(0);

  useEffect(() => watchAuth((authenticated) => {
    setUser(authenticated ? { uid: authenticated.uid } : null);
    setAuthReady(true);
  }), []);
  // Création de la session live (mode navigateur, lecture écran uniquement).
  useEffect(() => {
    if (!user || session) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await authFetch("/api/live/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Copilote visuel",
            objective: "Assistance contextuelle temps réel : analyser l'écran de l'utilisateur et répondre à ses questions (boutons, formulaires, erreurs, code, pages web).",
            permissions: ["screen.read"],
            mode: "browser",
            ttlMs: 2 * 60 * 60 * 1000,
          }),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Création de session impossible.");
        const created = (await response.json()) as CreatedSession;
        if (!cancelled) setSession(created);
      } catch (error) {
        if (!cancelled) setSessionError(error instanceof Error ? error.message : "Session copilote indisponible.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, user]);

  // Clôture propre de la session au démontage.
  useEffect(() => {
    const id = session?.session.id;
    return () => {
      if (!id) return;
      void authFetch(`/api/live/sessions/${id}`, { method: "DELETE" }).catch(() => undefined);
    };
  }, [session?.session.id]);
  const handleDelta = useCallback((text: string) => {
    setMessages((current) => {
      const last = current[current.length - 1];
      if (last?.streaming) {
        const updated = [...current];
        updated[updated.length - 1] = { ...last, content: last.content + text };
        return updated;
      }
      messageSeqRef.current += 1;
      return [...current, { id: messageSeqRef.current, role: "assistant", content: text, streaming: true }];
    });
  }, []);

  const handleDone = useCallback(() => {
    setMessages((current) => {
      const last = current[current.length - 1];
      if (last?.streaming) {
        const updated = [...current];
        updated[updated.length - 1] = { ...last, streaming: false };
        return updated;
      }
      return current;
    });
    setBusy(false);
  }, []);

  const handleError = useCallback((message: string) => {
    setMessages((current) => {
      const last = current[current.length - 1];
      // L'erreur complète une réponse partielle en cours (comme chat-v4)…
      if (last?.streaming) {
        const updated = [...current];
        updated[updated.length - 1] = {
          ...last,
          streaming: false,
          content: last.content.length > 0 ? `${last.content}\n\n⚠️ ${message}` : message,
          error: last.content.length === 0,
        };
        return updated;
      }
      // …sinon elle devient un message d'erreur dédié.
      messageSeqRef.current += 1;
      return [...current, { id: messageSeqRef.current, role: "assistant", content: message, streaming: false, error: true }];
    });
    setBusy(false);
  }, []);

  const stableDeviceId = useRef<string>("");
  if (!stableDeviceId.current && typeof window !== "undefined") stableDeviceId.current = deviceId();

  const { status: socketReady, ask, stopAnswer, sendFrame } = useCopilotWebsocket({
    sessionId: session?.session.id ?? null,
    deviceId: stableDeviceId.current,
    pairingToken: session?.pairingToken ?? null,
    onDelta: handleDelta,
    onDone: handleDone,
    onError: handleError,
  });

  const capturer = useScreenCapturer({ onFrame: sendFrame });

  const handleAsk = useCallback(
    (text: string) => {
      if (!session || socketReady !== "connected") return;
      messageSeqRef.current += 1;
      streamIdRef.current += 1;
      setMessages((current) => [...current, { id: messageSeqRef.current, role: "user", content: text }]);
      setBusy(true);
      ask(text);
    },
    [ask, session, socketReady],
  );

  const handleStop = useCallback(() => {
    stopAnswer();
    setMessages((current) => {
      const last = current[current.length - 1];
      if (last?.streaming) {
        const updated = [...current];
        updated[updated.length - 1] = { ...last, streaming: false };
        return updated;
      }
      return current;
    });
    setBusy(false);
  }, [stopAnswer]);

  const socketConnected = socketReady === "connected";
  const disabled = !session || !socketConnected;
  const disabledReason = sessionError
    ?? (authReady && !user ? "Connectez-vous pour utiliser le copilote." : null)
    ?? (socketReady === "error" ? "Gateway temps réel injoignable — réessayez dans un instant." : null)
    ?? (socketReady === "connecting" || !session ? "Connexion en cours…" : null);

  return (
    <main className="flex h-[100dvh] flex-col overflow-hidden bg-[var(--g3-bg)] text-[var(--g3-text)]">
      {/* Barre supérieure */}
      <header className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl text-sm font-bold text-white" style={{ background: "var(--g3-gradient)" }} aria-hidden>IA</div>
          <div>
            <h1 className="font-semibold leading-tight">Copilote visuel</h1>
            <p className="text-xs text-[var(--g3-muted)]">Assistance contextuelle en temps réel</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-semibold ${capturer.status === "active" && socketConnected ? "copilot-badge-live" : "bg-[var(--g3-elevated)] text-[var(--g3-muted)]"}`}>
            <span className={capturer.status === "active" ? "copilot-live-dot" : "copilot-idle-dot"} aria-hidden />
            {capturer.status === "active" && socketConnected ? "En direct" : "Hors ligne"}
          </span>
          <a href="/chat" className="rounded-full bg-[var(--g3-elevated)] px-3 py-1.5 text-[var(--g3-text-secondary)] transition hover:text-[var(--g3-text)]">
            Chat classique
          </a>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row-reverse lg:gap-3 lg:px-3 lg:pb-3">
        {/* Zone capture (aperçu + contrôles) */}
        <aside className="flex shrink-0 flex-col gap-3 p-3 pt-0 sm:p-4 sm:pt-0 lg:w-[380px] lg:shrink lg:self-stretch lg:overflow-y-auto lg:pt-1" aria-label="Partage d'écran">
          <div className="rounded-[var(--gen3ia-radius)] bg-[var(--g3-surface)] p-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">Écran partagé</span>
              <span className="text-[11px] text-[var(--g3-muted)]">{CAPTURE_LABELS[capturer.status] ?? capturer.status}</span>
            </div>

            <div className="mt-3 overflow-hidden rounded-2xl bg-[var(--g3-deep)]">
              {capturer.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={capturer.previewUrl} alt="Aperçu de l'écran partagé" className="aspect-video w-full object-cover" />
              ) : (
                <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 text-center text-xs text-[var(--g3-faint)]">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <rect x="2" y="4" width="20" height="13" rx="2" stroke="currentColor" strokeWidth="1.6" />
                    <path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                  {capturer.status === "unsupported" ? "Navigateur non compatible (ordinateur requis)" : "Aucun écran partagé pour l'instant"}
                </div>
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {capturer.status !== "requesting" && capturer.status !== "active" && capturer.status !== "paused" ? (
                <button type="button" onClick={() => void capturer.start()} disabled={capturer.status === "unsupported"} className="flex-1 rounded-full px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-40" style={{ background: "var(--g3-gradient)" }}>
                  Partager mon écran
                </button>
              ) : null}
              {capturer.status === "active" ? (
                <button type="button" onClick={capturer.pause} className="flex-1 rounded-full bg-[var(--g3-elevated)] px-4 py-2 text-sm font-medium text-[var(--g3-text-secondary)] transition hover:text-[var(--g3-text)]">
                  Mettre en pause
                </button>
              ) : null}
              {capturer.status === "paused" ? (
                <button type="button" onClick={capturer.resume} className="flex-1 rounded-full px-4 py-2 text-sm font-semibold text-white" style={{ background: "var(--g3-gradient)" }}>
                  Reprendre
                </button>
              ) : null}
              {capturer.status === "active" || capturer.status === "paused" ? (
                <button type="button" onClick={capturer.stop} className="rounded-full bg-[var(--g3-elevated)] px-4 py-2 text-sm font-medium text-[var(--g3-text-secondary)] transition hover:text-[var(--g3-text)]">
                  Arrêter
                </button>
              ) : null}
            </div>

            {capturer.error ? <p className="mt-2 text-xs text-[var(--g3-danger-strong)]">{capturer.error}</p> : null}
            {capturer.status === "active" ? (
              <p className="mt-2 text-[11px] text-[var(--g3-faint)]">1 frame / 2 s · JPEG ≤ 1280 px · {capturer.frameCount} frames envoyées</p>
            ) : null}
          </div>

          <div className="rounded-[var(--gen3ia-radius)] bg-[var(--g3-surface)] p-3.5 text-xs leading-relaxed text-[var(--g3-muted)]">
            <p className="mb-1 font-semibold text-[var(--g3-text)]">Confidentialité</p>
            La vision n&apos;analyse votre écran QUE pour répondre à vos questions — aucune analyse en continu, aucun envoi sans question. Vous arrêtez le partage quand vous voulez.
          </div>
        </aside>

        {/* Panneau de conversation */}
        <div className="min-h-0 flex-1 lg:py-1">
          <AgentInterface
            messages={messages}
            busy={busy}
            live={capturer.status === "active" && socketConnected}
            disabled={disabled}
            disabledReason={disabledReason}
            onAsk={handleAsk}
            onStop={handleStop}
          />
        </div>
      </div>
    </main>
  );
}
