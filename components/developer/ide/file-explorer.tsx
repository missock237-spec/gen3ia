"use client";

import { useMemo, useState } from "react";

/**
 * Explorateur de fichiers du Workshop IDE (panneau gauche) :
 * recherche instantanée, favoris persistants (localStorage), état des
 * versions (badge vN), tri par date. Les fichiers sont les artefacts de
 * code/fichier créés par les agents de l'utilisateur.
 */

export interface IdeFile {
  artifactId: string;
  path: string;
  title: string;
  language?: string;
  type: string;
  sizeChars: number;
  version: number;
  versionCount: number;
  updatedAt: string;
  conversationId?: string;
  projectId?: string;
}

interface FileExplorerProps {
  files: IdeFile[];
  loading: boolean;
  error: string;
  openIds: Set<string>;
  activeId: string | null;
  favorites: string[];
  onOpen: (file: IdeFile) => void;
  onToggleFavorite: (artifactId: string) => void;
  onReload: () => void;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  return `il y a ${days} j`;
}

export function FileExplorer({ files, loading, error, openIds, activeId, favorites, onOpen, onToggleFavorite, onReload }: FileExplorerProps) {
  const [query, setQuery] = useState("");
  const [onlyFavorites, setOnlyFavorites] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return files
      .filter((f) => (onlyFavorites ? favorites.includes(f.artifactId) : true))
      .filter((f) => !q || f.path.toLowerCase().includes(q) || f.title.toLowerCase().includes(q))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }, [files, query, onlyFavorites, favorites]);

  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-neutral-800 bg-[#0d0e0c] text-neutral-300" aria-label="Explorateur de fichiers">
      <div className="flex items-center justify-between px-3 pt-3">
        <h2 className="text-[10px] font-semibold uppercase tracking-[.18em] text-neutral-500">Fichiers</h2>
        <button
          type="button"
          onClick={onReload}
          className="rounded px-1.5 py-0.5 text-[10px] text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-200"
          title="Rafraîchir la liste des fichiers"
        >
          ⟳
        </button>
      </div>

      <div className="px-3 pt-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Rechercher un fichier…"
          aria-label="Rechercher un fichier"
          className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
        />
        <label className="mt-2 flex items-center gap-1.5 text-[10px] text-neutral-500">
          <input type="checkbox" checked={onlyFavorites} onChange={(event) => setOnlyFavorites(event.target.checked)} className="size-3 accent-amber-500" />
          Favoris uniquement
        </label>
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-1.5 pb-3" role="list">
        {loading && <p className="px-2 py-3 text-[11px] text-neutral-500">Chargement des fichiers…</p>}
        {error && (
          <div className="mx-2 my-2 rounded-lg border border-amber-900/60 bg-amber-950/40 p-2 text-[11px] text-amber-300" role="alert">
            {error}
            <button type="button" onClick={onReload} className="mt-1 block underline underline-offset-2">
              Réessayer
            </button>
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div className="px-2 py-3 text-[11px] leading-relaxed text-neutral-500">
            {query || onlyFavorites ? (
              <>Aucun fichier ne correspond. Ajustez la recherche ou les filtres.</>
            ) : (
              <>
                Aucun fichier pour le moment.
                <span className="mt-1 block text-neutral-600">Les fichiers de code créés par vos agents (artefacts) apparaîtront ici automatiquement.</span>
              </>
            )}
          </div>
        )}
        {filtered.map((file) => {
          const isOpen = openIds.has(file.artifactId);
          const isActive = activeId === file.artifactId;
          return (
            <div
              key={file.artifactId}
              role="listitem"
              className={
                "group flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs transition " +
                (isActive ? "bg-neutral-800 text-white" : "hover:bg-neutral-800/60")
              }
            >
              <button
                type="button"
                onClick={() => onToggleFavorite(file.artifactId)}
                aria-label={favoriteSet.has(file.artifactId) ? `Retirer ${file.path} des favoris` : `Ajouter ${file.path} aux favoris`}
                aria-pressed={favoriteSet.has(file.artifactId)}
                className={"shrink-0 text-[11px] leading-none " + (favoriteSet.has(file.artifactId) ? "text-amber-400" : "text-neutral-600 hover:text-amber-400")}
              >
                {favoriteSet.has(file.artifactId) ? "★" : "☆"}
              </button>
              <button type="button" onClick={() => onOpen(file)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={file.path}>
                <span className="min-w-0 flex-1 truncate">
                  {isOpen && !isActive ? <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-neutral-600" aria-hidden /> : null}
                  {file.path}
                </span>
                {file.versionCount > 1 && (
                  <span className="shrink-0 rounded-full bg-neutral-800 px-1.5 text-[9px] text-neutral-400" title={`${file.versionCount} versions`}>
                    v{file.version}
                  </span>
                )}
                <span className="hidden shrink-0 text-[9px] text-neutral-600 group-hover:inline">{timeAgo(file.updatedAt)}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
