"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { Monaco } from "@monaco-editor/react";

import { monacoLanguageFor } from "@/lib/developer/ide";

/**
 * Éditeur central du Workshop IDE : Monaco (minimap, coloration,
 * annotations d'erreurs synchronisées depuis le terminal) avec repli
 * transparent sur un éditeur texte si le chargement Monaco échoue
 * (réseau restreint) — l'IDE reste utilisable dans tous les cas.
 */

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center bg-[var(--g3-elevated)] text-xs text-[var(--g3-muted)]" role="status">
      Chargement de l&apos;éditeur…
    </div>
  ),
});

export interface IdeMarker {
  startLine: number;
  startColumn?: number;
  message: string;
  severity: "error" | "warning" | "info";
  source?: string;
}

export interface OpenFileTab {
  artifactId: string;
  path: string;
  content: string;
  language?: string;
  dirty: boolean;
  saving: boolean;
  /** Version serveur au moment de l'ouverture / dernière sauvegarde. */
  savedVersion: number;
}

interface CodeEditorProps {
  tabs: OpenFileTab[];
  activeId: string | null;
  markers: IdeMarker[];
  /** Déplacement demandé vers une ligne (synchronisation terminal → éditeur). */
  goto?: { artifactId: string; line: number } | null;
  onGotoHandled?: () => void;
  onSelectTab: (artifactId: string) => void;
  onCloseTab: (artifactId: string) => void;
  onChange: (artifactId: string, content: string) => void;
  onRetryVersion?: (artifactId: string) => void;
}

const SEVERITY_MAP = { error: 8, warning: 4, info: 2 } as const;

export function CodeEditor({ tabs, activeId, markers, goto, onGotoHandled, onSelectTab, onCloseTab, onChange }: CodeEditorProps) {
  const active = tabs.find((t) => t.artifactId === activeId) ?? null;
  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<{ getModel: () => unknown; revealLineInCenter: (line: number) => void; setPosition: (p: { lineNumber: number; column: number }) => void } | null>(null);
  const [monacoReady, setMonacoReady] = useState(false);
  const [monacoFailed, setMonacoFailed] = useState(false);

  // Si Monaco n'a pas démarré dans les 10 s (CDN indisponible), repli
  // transparent sur l'éditeur texte — aucune fonctionnalité perdue.
  useEffect(() => {
    if (monacoReady) return;
    const timer = setTimeout(() => {
      if (!monacoReady) setMonacoFailed(true);
    }, 10_000);
    return () => clearTimeout(timer);
  }, [monacoReady]);

  // Annotations d'erreurs : appliquées au modèle actif dès que les
  // marqueurs ou le fichier actif changent.
  useEffect(() => {
    if (!monacoReady || !monacoRef.current || !editorRef.current) return;
    const monaco = monacoRef.current;
    const editor = editorRef.current as unknown as {
      getModel: () => { uri: { toString(): string } } | null;
      revealLineInCenter: (line: number) => void;
      setPosition: (p: { lineNumber: number; column: number }) => void;
      deltaDecorations?: unknown;
    };
    const model = editor.getModel();
    if (!model) return;
    const owner = "gen3ia-terminal-sync";
    monaco.editor.setModelMarkers(
      model as never,
      owner,
      markers.map((marker) => ({
        startLineNumber: marker.startLine,
        endLineNumber: marker.startLine,
        startColumn: marker.startColumn ?? 1,
        endColumn: (marker.startColumn ?? 1) + 40,
        message: marker.message,
        severity: SEVERITY_MAP[marker.severity],
        source: marker.source,
      })),
    );
  }, [markers, monacoReady, activeId]);

  // Synchronisation contextuelle : révéler la ligne demandée (erreur cliquée
  // dans le terminal) dès que l'éditeur est prêt.
  useEffect(() => {
    if (!goto || goto.artifactId !== activeId || !monacoReady || !editorRef.current) return;
    const editor = editorRef.current as unknown as { revealLineInCenter: (line: number) => void; setPosition: (p: { lineNumber: number; column: number }) => void };
    try {
      editor.revealLineInCenter(goto.line);
      editor.setPosition({ lineNumber: goto.line, column: 1 });
    } catch {
      editor.revealLineInCenter(goto.line);
    }
    onGotoHandled?.();
  }, [goto, activeId, monacoReady, onGotoHandled]);

  if (tabs.length === 0) {
    return (
      <div className="grid h-full place-items-center bg-[var(--g3-deep)] px-6 text-center">
        <div className="max-w-sm">
          <p className="text-3xl" aria-hidden>▚</p>
          <p className="mt-2 text-sm font-medium text-[var(--g3-faint)]">Aucun fichier ouvert</p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--g3-muted)]">
            Ouvrez un fichier depuis l&apos;explorateur à gauche ou via la palette <kbd className="rounded bg-[var(--g3-deep)] px-1.5 py-0.5 text-[10px]">Ctrl/⌘ K</kbd>.
            Les fichiers sont les artefacts de code créés par vos agents.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--g3-elevated)]">
      {/* Onglets de fichiers ouverts */}
      <div className="flex items-stretch overflow-x-auto border-b border-[var(--g3-border)] bg-[var(--g3-deep)]" role="tablist" aria-label="Fichiers ouverts">
        {tabs.map((tab) => (
          <div
            key={tab.artifactId}
            role="tab"
            aria-selected={tab.artifactId === activeId}
            className={
              "group flex max-w-[220px] shrink-0 items-center gap-1.5 border-r border-[var(--g3-border)] px-3 py-2 text-xs transition " +
              (tab.artifactId === activeId ? "bg-[var(--g3-elevated)] text-white" : "text-[var(--g3-faint)] hover:bg-[var(--g3-elevated)]/60")
            }
          >
            <button type="button" onClick={() => onSelectTab(tab.artifactId)} className="min-w-0 truncate" title={tab.path}>
              {tab.path}
              {tab.dirty && <span className="ml-1 inline-block size-1.5 rounded-full bg-amber-400 align-middle" aria-label="Modifications non enregistrées" />}
            </button>
            <button
              type="button"
              onClick={() => onCloseTab(tab.artifactId)}
              aria-label={`Fermer ${tab.path}`}
              className="shrink-0 rounded px-1 text-[var(--g3-muted)] opacity-0 transition hover:bg-[var(--g3-elevated)] hover:text-white group-hover:opacity-100"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {/* Zone d'édition */}
      <div className="relative min-h-0 flex-1">
        {monacoFailed ? (
          <textarea
            value={active?.content ?? ""}
            onChange={(event) => active && onChange(active.artifactId, event.target.value)}
            spellCheck={false}
            aria-label={`Contenu de ${active?.path}`}
            className="h-full w-full resize-none bg-[var(--g3-elevated)] p-4 font-mono text-[13px] leading-relaxed text-[var(--g3-text-secondary)] outline-none"
          />
        ) : active ? (
          <MonacoEditor
            height="100%"
            theme="vs-dark"
            language={monacoLanguageFor(active.language || active.path)}
            value={active.content}
            onChange={(value) => onChange(active.artifactId, value ?? "")}
            onMount={(editor, monaco) => {
              editorRef.current = editor as never;
              monacoRef.current = monaco;
              setMonacoReady(true);
            }}
            options={{
              minimap: { enabled: true, renderCharacters: false },
              fontSize: 13,
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              wordWrap: "on",
              renderWhitespace: "selection",
              readOnly: !active,
              padding: { top: 12 },
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
