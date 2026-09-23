"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { maskSecrets } from "@/lib/security/secret-masking";
import { parseErrorRefs } from "@/lib/developer/ide";
import type { ErrorRef } from "@/lib/developer/ide";
import type { TerminalEntry, TerminalSession } from "@/lib/agents/runtime/terminal-sessions";

/**
 * Terminal du Workshop IDE — RÉSERVÉ AUX AGENTS.
 *
 * L'utilisateur observe en lecture seule le flux des commandes exécutées
 * par ses agents (aucune saisie de commande n'est possible) et garde les
 * leviers de contrôle : pause de session, arrêt d'urgence global.
 * Cliquer sur une référence d'erreur (fichier:ligne) ouvre le fichier à
 * la ligne concernée dans l'éditeur — synchronisation contextuelle.
 */

interface TerminalViewProps {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  entries: TerminalEntry[];
  live: boolean;
  connection: "connected" | "offline" | "polling-error";
  loadingEntries: boolean;
  error: string;
  stopping: boolean;
  onSelectSession: (sessionId: string) => void;
  onToggleLive: () => void;
  onStopSession: (sessionId: string) => void;
  onEmergencyStop: () => void;
  onRetry: () => void;
  onOpenErrorRef: (ref: ErrorRef) => void;
}

function statusDot(connection: TerminalViewProps["connection"]) {
  if (connection === "connected") return <span className="inline-block size-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />;
  if (connection === "offline") return <span className="inline-block size-1.5 rounded-full bg-neutral-600" aria-hidden />;
  return <span className="inline-block size-1.5 rounded-full bg-amber-500" aria-hidden />;
}

const CONNECTION_LABEL: Record<TerminalViewProps["connection"], string> = {
  connected: "Connecté",
  offline: "Hors ligne",
  "polling-error": "Reconnexion…",
};

export function TerminalView({
  sessions,
  activeSessionId,
  entries,
  live,
  connection,
  loadingEntries,
  error,
  stopping,
  onSelectSession,
  onToggleLive,
  onStopSession,
  onEmergencyStop,
  onRetry,
  onOpenErrorRef,
}: TerminalViewProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const [followOutput, setFollowOutput] = useState(true);
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  // Références d'erreurs cliquables (fichier:ligne) dans les sorties.
  const clickableRefs = useMemo(() => {
    const map = new Map<number, ErrorRef[]>();
    for (const entry of entries) {
      const refs = [...parseErrorRefs(entry.stderr), ...parseErrorRefs(entry.stdout)].slice(0, 6);
      if (refs.length > 0) map.set(entry.index, refs);
    }
    return map;
  }, [entries]);

  useEffect(() => {
    if (!followOutput) return;
    requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    });
  }, [entries.length, followOutput]);

  if (sessions.length === 0 && !error && !loadingEntries) {
    return (
      <div className="grid h-full place-items-center overflow-y-auto bg-[#0d0e0c] px-6 py-10 text-center">
        <div className="max-w-md">
          <p className="text-3xl" aria-hidden>⌘</p>
          <p className="mt-3 text-sm font-semibold text-neutral-200">Le terminal de vos agents</p>
          <p className="mt-2 text-xs leading-relaxed text-neutral-500">
            Aucune session pour le moment. Lancez un agent (de type code) depuis une conversation : chacune de ses commandes apparaîtra ici
            en direct, avec son résultat, son mode d&apos;exécution et sa piste d&apos;audit.
          </p>
          <ul className="mx-auto mt-4 max-w-xs space-y-1.5 text-left text-[11px] text-neutral-400">
            <li className="flex gap-2"><span aria-hidden>1.</span> Ouvrez une conversation dans l&apos;espace de travail.</li>
            <li className="flex gap-2"><span aria-hidden>2.</span> Demandez une tâche nécessitant l&apos;exécution de commandes.</li>
            <li className="flex gap-2"><span aria-hidden>3.</span> Observez et contrôlez l&apos;exécution ici.</li>
          </ul>
          <Link href="/workspace" className="mt-4 inline-block rounded-full bg-white px-4 py-2 text-xs font-semibold text-black transition hover:bg-neutral-200">
            Ouvrir une conversation
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0d0e0c]" aria-label="Terminal des agents">
      {/* Barre de contrôle de session */}
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
          <span className="sr-only">Session terminal</span>
          <select
            value={activeSessionId ?? ""}
            onChange={(event) => onSelectSession(event.target.value)}
            className="max-w-[280px] rounded-lg border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus:border-neutral-600 focus:outline-none"
            aria-label="Choisir une session terminal"
          >
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title} · {session.commandCount} commande{session.commandCount > 1 ? "s" : ""} · {session.status === "stopped" ? "arrêtée" : "active"}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={onToggleLive}
          aria-pressed={live}
          className={
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition " +
            (live ? "border-emerald-800 bg-emerald-950/50 text-emerald-300" : "border-neutral-700 text-neutral-400 hover:text-neutral-200")
          }
        >
          {statusDot(connection)}
          {live ? CONNECTION_LABEL[connection] : "En pause"}
        </button>

        {activeSession && activeSession.status !== "stopped" && (
          <button
            type="button"
            onClick={() => onStopSession(activeSession.id)}
            disabled={stopping}
            className="rounded-full border border-amber-800 bg-amber-950/40 px-2.5 py-1 text-[11px] font-medium text-amber-300 transition hover:bg-amber-900/50 disabled:opacity-50"
            title="Empêche les agents d'exécuter de nouvelles commandes sur cette session"
          >
            {stopping ? "Arrêt…" : "Arrêter la session"}
          </button>
        )}

        <div className="ml-auto">
          <button
            type="button"
            onClick={onEmergencyStop}
            className="rounded-full border border-red-800 bg-red-950/60 px-3 py-1 text-[11px] font-bold text-red-300 transition hover:bg-red-900/60"
            title="Interrompt immédiatement toutes les exécutions en cours de vos agents"
          >
            ⏹ Arrêt d&apos;urgence
          </button>
        </div>
      </div>

      {/* Bandeau de sécurité : terminal réservé aux agents */}
      <p className="border-b border-neutral-900 bg-neutral-900/40 px-3 py-1.5 text-[10px] text-neutral-500">
        <span className="mr-1.5 rounded bg-neutral-800 px-1.5 py-0.5 font-semibold text-neutral-300">Lecture seule</span>
        Terminal réservé aux agents — vous ne pouvez pas y saisir de commandes. Sorties masquées automatiquement si elles contiennent des secrets.
      </p>

      {error && (
        <div className="mx-3 mt-2 rounded-lg border border-amber-900/60 bg-amber-950/40 p-2.5 text-[11px] text-amber-300" role="alert">
          {error}
          <button type="button" onClick={onRetry} className="ml-2 underline underline-offset-2">
            Réessayer
          </button>
        </div>
      )}

      {/* Sorties */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" aria-live="polite">
        {entries.length === 0 && !error && (
          <p className="py-6 text-center text-xs text-neutral-500">
            {loadingEntries ? "Chargement de la session…" : "Session vide — en attente des commandes de vos agents."}
          </p>
        )}
        {entries.map((entry) => {
          const refs = clickableRefs.get(entry.index) ?? [];
          return (
            <article key={entry.index} className={"g3-console-entry py-1.5 " + (entry.success ? "is-ok" : "is-fail")}>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="g3-console-prompt" aria-hidden>$</span>
                <code className="text-xs text-neutral-200">{entry.command}</code>
                {entry.mode && (
                  <small className={"g3-console-mode " + (entry.mode === "sandbox" ? "is-real" : "is-simulated")}>
                    {entry.mode === "sandbox" ? "exécution réelle" : entry.engine ?? "simulation"}
                  </small>
                )}
                {typeof entry.exitCode === "number" && (
                  <small className={entry.exitCode === 0 ? "text-emerald-500" : "text-red-400"}>
                    exit {entry.exitCode} · {entry.durationMs} ms
                  </small>
                )}
                <small className="ml-auto text-[9px] text-neutral-600">
                  {new Date(entry.createdAt).toLocaleTimeString("fr-FR")}
                </small>
              </div>
              {entry.error && <pre className="mt-1 text-[11px] text-red-400">{maskSecrets(entry.error)}</pre>}
              {entry.stdout && <pre className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-400">{maskSecrets(entry.stdout)}</pre>}
              {entry.stderr && <pre className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-red-300/90">{maskSecrets(entry.stderr)}</pre>}
              {refs.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {refs.map((ref) => (
                    <button
                      key={`${entry.index}-${ref.path}-${ref.line ?? ""}`}
                      type="button"
                      onClick={() => onOpenErrorRef(ref)}
                      className="rounded-full border border-sky-900 bg-sky-950/50 px-2 py-0.5 text-[10px] text-sky-300 transition hover:bg-sky-900/60"
                      title="Ouvrir à l'emplacement indiqué dans l'éditeur"
                    >
                      ↗ {ref.path}
                      {ref.line ? `:${ref.line}` : ""}
                    </button>
                  ))}
                </div>
              )}
            </article>
          );
        })}
        <div ref={endRef} />
      </div>

      {/* Suivi de sortie */}
      <label className="flex items-center justify-between border-t border-neutral-800 px-3 py-1.5 text-[10px] text-neutral-500">
        <span>
          {entries.length > 0 && `Dernier index : ${entries[entries.length - 1].index}`}
          {activeSession?.status === "stopped" && " · session arrêtée — les agents ne peuvent plus y exécuter de commandes"}
        </span>
        <span className="flex items-center gap-1.5">
          <input type="checkbox" checked={followOutput} onChange={(event) => setFollowOutput(event.target.checked)} className="size-3 accent-emerald-500" />
          Suivre la sortie
        </span>
      </label>
    </div>
  );
}
