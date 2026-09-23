"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { IdeFile } from "./file-explorer";

/**
 * Palette de commandes du Workshop IDE (Ctrl/⌘ K, Ctrl/⌘ P) :
 * recherche de fichiers (nom) + recherche globale (contenu des fichiers
 * chargés) + actions rapides (changement d'onglet, sauvegarde, arrêt…).
 * Navigation clavier complète (↑ ↓ Entrée Échap).
 */

export type PaletteItem =
  | { kind: "file"; file: IdeFile }
  | { kind: "command"; id: string; label: string; hint?: string }
  | { kind: "match"; file: IdeFile; line: number; excerpt: string };

interface CommandPaletteProps {
  open: boolean;
  files: IdeFile[];
  actions: Array<{ id: string; label: string; hint?: string }>;
  /** Recherche dans le contenu des fichiers (recherche globale). */
  searchContents?: (query: string) => Array<{ file: IdeFile; line: number; excerpt: string }>;
  onPickFile: (file: IdeFile) => void;
  onPickAction: (id: string) => void;
  onClose: () => void;
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function CommandPalette({ open, files, actions, searchContents, onPickFile, onPickAction, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const q = normalize(query.trim());
    if (!q) {
      const recent = files.slice(0, 6).map<PaletteItem>((file) => ({ kind: "file", file }));
      const commands = actions.map<PaletteItem>((action) => ({ kind: "command", id: action.id, label: action.label, hint: action.hint }));
      return [...recent, ...commands];
    }
    const fileMatches = files
      .filter((f) => normalize(f.path).includes(q) || normalize(f.title).includes(q))
      .slice(0, 8)
      .map<PaletteItem>((file) => ({ kind: "file", file }));
    const contentMatches = (searchContents?.(query.trim()) ?? []).slice(0, 8).map<PaletteItem>((m) => ({ kind: "match", file: m.file, line: m.line, excerpt: m.excerpt }));
    const commandMatches = actions
      .filter((a) => normalize(a.label).includes(q))
      .slice(0, 6)
      .map<PaletteItem>((action) => ({ kind: "command", id: action.id, label: action.label, hint: action.hint }));
    return [...fileMatches, ...contentMatches, ...commandMatches];
  }, [query, files, actions, searchContents]);

  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(items.length - 1, 0)));
  }, [items.length]);

  if (!open) return null;

  const pick = (item: PaletteItem) => {
    if (item.kind === "file" || item.kind === "match") onPickFile(item.file);
    else onPickAction(item.id);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => Math.min(c + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[cursor];
      if (item) pick(item);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center bg-black/60 px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Palette de commandes" onClick={onClose}>
      <div
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-neutral-700 bg-[#141513] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3">
          <span className="text-neutral-500" aria-hidden>⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Rechercher un fichier, un contenu ou une action…"
            aria-label="Recherche"
            className="w-full bg-transparent text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
          />
          <kbd className="rounded border border-neutral-700 px-1.5 py-0.5 text-[9px] text-neutral-500">Échap</kbd>
        </div>

        <div ref={listRef} className="max-h-[46vh] overflow-y-auto p-1.5">
          {items.length === 0 && <p className="px-3 py-6 text-center text-xs text-neutral-500">Aucun résultat. Essayez un autre terme.</p>}
          {items.map((item, index) => {
            const selected = index === cursor;
            const common = "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs transition " + (selected ? "bg-neutral-800 text-white" : "text-neutral-300 hover:bg-neutral-800/60");
            if (item.kind === "file") {
              return (
                <button key={`f-${item.file.artifactId}`} type="button" className={common} onMouseEnter={() => setCursor(index)} onClick={() => pick(item)}>
                  <span aria-hidden className="text-neutral-500">▤</span>
                  <span className="min-w-0 flex-1 truncate">{item.file.path}</span>
                  <span className="shrink-0 text-[9px] text-neutral-600">{item.file.type} · v{item.file.version}</span>
                </button>
              );
            }
            if (item.kind === "match") {
              return (
                <button key={`m-${item.file.artifactId}-${item.line}-${index}`} type="button" className={common} onMouseEnter={() => setCursor(index)} onClick={() => pick(item)}>
                  <span aria-hidden className="text-neutral-500">≡</span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{item.file.path}</span>
                    <span className="ml-2 text-neutral-500">ligne {item.line} — {item.excerpt}</span>
                  </span>
                </button>
              );
            }
            return (
              <button key={`c-${item.id}`} type="button" className={common} onMouseEnter={() => setCursor(index)} onClick={() => pick(item)}>
                <span aria-hidden className="text-neutral-500">▸</span>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint && <kbd className="shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-[9px] text-neutral-500">{item.hint}</kbd>}
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-t border-neutral-800 px-4 py-2 text-[9px] text-neutral-600">
          <span>↑ ↓ naviguer · Entrée ouvrir</span>
          <span>Ctrl/⌘ P fichiers · Ctrl/⌘ S enregistrer</span>
        </div>
      </div>
    </div>
  );
}
