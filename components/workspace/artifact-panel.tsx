"use client";

import { useMemo, useState } from "react";

import { ARTIFACT_TYPE_ICONS, ARTIFACT_TYPE_LABELS, formatBytes } from "./labels";
import { MarkdownContent } from "./markdown";
import type { ArtifactType, ArtifactVersion, ConversationArtifact } from "@/lib/domain/conversations/types";

/**
 * ArtifactPanel — livrables standardisés de la conversation : code,
 * documents, tableaux, images, rapports et fichiers. Actions communes :
 * prévisualiser, copier, télécharger, partager et revenir à une version
 * précédente.
 */

export interface ArtifactFileSource {
  path: string;
  filename: string;
}

interface ArtifactPanelProps {
  artifacts: ConversationArtifact[];
  /** Télécharge un fichier du stockage permanent et renvoie une URL signée. */
  resolveFileUrl?: (path: string) => Promise<string>;
  className?: string;
  /** Affichage compact (panneau latéral) ou complet (section). */
  variant?: "sidebar" | "full";
}

type TabId = ArtifactType | "all";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "all", label: "Tous" },
  { id: "document", label: "Documents" },
  { id: "code", label: "Code" },
  { id: "table", label: "Tableaux" },
  { id: "image", label: "Images" },
  { id: "report", label: "Rapports" },
  { id: "file", label: "Fichiers" },
];

export function ArtifactPanel({ artifacts, resolveFileUrl, className = "", variant = "full" }: ArtifactPanelProps) {
  const [tab, setTab] = useState<TabId>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [versionIndex, setVersionIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shareNote, setShareNote] = useState("");

  const filtered = useMemo(
    () => (tab === "all" ? artifacts : artifacts.filter((a) => a.type === tab)),
    [artifacts, tab],
  );
  const selected = useMemo(
    () => artifacts.find((a) => a.id === selectedId) ?? null,
    [artifacts, selectedId],
  );

  const currentVersion: ArtifactVersion | null = selected
    ? selected.versions[Math.min(versionIndex, selected.versions.length - 1)] ?? null
    : null;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* presse-papiers indisponible */
    }
  };

  const download = async (artifact: ConversationArtifact) => {
    const version = artifact.versions[Math.min(versionIndex, artifact.versions.length - 1)];
    if (!version) return;
    setBusy(true);
    try {
      if (artifact.storagePath && resolveFileUrl) {
        const url = await resolveFileUrl(artifact.storagePath);
        window.open(url, "_blank", "noopener");
      } else if (version.url) {
        window.open(version.url, "_blank", "noopener");
      } else if (version.content) {
        const blob = new Blob([version.content], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = artifact.filename || `${artifact.title || "artefact"}.md`;
        anchor.click();
        URL.revokeObjectURL(url);
      }
    } finally {
      setBusy(false);
    }
  };

  const share = async (artifact: ConversationArtifact) => {
    const url = typeof window !== "undefined" ? window.location.href : "";
    const text = `${artifact.title} — artefact Gen3ia`;
    try {
      if (navigator.share) {
        await navigator.share({ title: artifact.title, text, url });
      } else {
        await copy(`${text}\n${url}`);
        setShareNote("Lien copié");
        setTimeout(() => setShareNote(""), 1600);
      }
    } catch {
      /* partage annulé */
    }
  };

  const select = (artifact: ConversationArtifact) => {
    setSelectedId(artifact.id);
    setVersionIndex(0);
    setPreviewUrl(null);
  };

  if (artifacts.length === 0) {
    return (
      <div className={`p-4 text-center text-xs text-[var(--g3-muted)] ${className}`}>
        <p className="text-2xl" aria-hidden>▣</p>
        <p className="mt-1">Aucun livrable pour le moment. Les documents, images, rapports et fichiers produits par l&apos;agent apparaîtront ici.</p>
      </div>
    );
  }

  return (
    <div className={`space-y-3 ${className}`}>
      {!selected && (
        <>
          {variant === "full" && (
            <div className="g3-tabs" role="tablist">
              {TABS.map((t) => {
                const count = t.id === "all" ? artifacts.length : artifacts.filter((a) => a.type === t.id).length;
                if (t.id !== "all" && count === 0) return null;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    data-active={tab === t.id}
                    onClick={() => setTab(t.id)}
                    className="g3-tab text-xs"
                  >
                    {t.label} <span className="text-[10px] opacity-70">{count}</span>
                  </button>
                );
              })}
            </div>
          )}
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="list">
            {filtered.map((artifact) => (
              <li key={artifact.id}>
                <button
                  type="button"
                  onClick={() => select(artifact)}
                  className="group w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-3 text-left transition-all hover:border-neutral-400 hover:shadow-sm"
                >
                  <div className="flex items-center gap-2">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--g3-elevated)] text-sm text-[var(--g3-muted)]" aria-hidden>
                      {ARTIFACT_TYPE_ICONS[artifact.type] ?? "□"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-[var(--g3-text)]">{artifact.title}</p>
                      <p className="text-[10px] text-[var(--g3-muted)]">
                        {ARTIFACT_TYPE_LABELS[artifact.type] ?? artifact.type}
                        {artifact.versions.length > 1 ? ` · v${artifact.versions[0].version}` : ""}
                        {artifact.storagePath ? " · fichier" : ""}
                      </p>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {selected && currentVersion && (
        <div className="overflow-hidden rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--g3-border)] bg-[var(--g3-elevated)]/70 px-3 py-2">
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="text-xs font-medium text-[var(--g3-muted)] hover:text-[var(--g3-text)]"
              aria-label="Retour à la liste des livrables"
            >
              ← {ARTIFACT_TYPE_LABELS[selected.type] ?? selected.type}
            </button>
            <div className="flex flex-wrap items-center gap-1.5">
              <button type="button" onClick={() => copy(currentVersion.content ?? "")} disabled={!currentVersion.content} className="g3-btn g3-btn-ghost !min-h-0 !px-2 !py-1 text-[11px]">
                {copied ? "Copié ✓" : "Copier"}
              </button>
              <button type="button" onClick={() => share(selected)} className="g3-btn g3-btn-ghost !min-h-0 !px-2 !py-1 text-[11px]">
                {shareNote || "Partager"}
              </button>
              <button type="button" onClick={() => download(selected)} disabled={busy} className="g3-btn g3-btn-ghost !min-h-0 !px-2 !py-1 text-[11px]">
                Télécharger
              </button>
            </div>
          </div>

          <div className="px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-[var(--g3-text)]">{selected.title}</p>
              {selected.versions.length > 1 && (
                <label className="flex items-center gap-1.5 text-[11px] text-[var(--g3-muted)]">
                  Version
                  <select
                    value={versionIndex}
                    onChange={(event) => setVersionIndex(Number(event.target.value))}
                    className="g3-select !min-h-0 !w-auto !py-0.5 text-[11px]"
                    aria-label="Choisir une version de l'artefact"
                  >
                    {selected.versions.map((version, index) => (
                      <option key={version.version} value={index}>
                        v{version.version}
                        {version.note ? ` — ${version.note.slice(0, 40)}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {currentVersion.note && <p className="mt-0.5 text-[11px] text-[var(--g3-muted)]">{currentVersion.note}</p>}

            {/* Prévisualisation selon le type d'artefact */}
            {selected.type === "image" && (previewUrl ?? currentVersion.url) && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={previewUrl ?? currentVersion.url}
                alt={selected.title}
                className="mt-2 max-h-96 w-full rounded-lg border border-[var(--g3-border)] object-contain"
              />
            )}

            {selected.type === "code" && currentVersion.content && (
              <pre className="g3-code mt-2 max-h-96 overflow-auto rounded-lg p-3 text-xs leading-relaxed" data-language={selected.language}>
                <code>{currentVersion.content}</code>
              </pre>
            )}

            {selected.type === "table" && currentVersion.content && <TableView content={currentVersion.content} />}

            {(selected.type === "document" || selected.type === "report") && currentVersion.content && (
              <div className="mt-2 max-h-96 overflow-y-auto rounded-lg border border-[var(--g3-border)] p-3">
                <MarkdownContent content={currentVersion.content} />
              </div>
            )}

            {selected.type === "file" && selected.storagePath && (
              <div className="mt-2 flex items-center justify-between rounded-lg border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-2.5">
                <p className="truncate text-xs text-[var(--g3-text-secondary)]">
                  □ {selected.filename ?? selected.storagePath.split("/").pop()}
                </p>
                <button
                  type="button"
                  onClick={() => download(selected)}
                  disabled={busy}
                  className="g3-btn g3-btn-ghost !min-h-0 !px-2 !py-1 text-[11px]"
                >
                  Ouvrir
                </button>
              </div>
            )}

            {selected.storagePath && selected.type !== "file" && (
              <p className="mt-1.5 text-[10px] text-[var(--g3-faint)]">
                Fichier permanent · {selected.filename ?? selected.storagePath.split("/").pop()}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Rendu CSV/markdown de tableau → table HTML (analyse simple des séparateurs). */
export function TableView({ content }: { content: string }) {
  const rows = useMemo(() => {
    const lines = content.trim().split("\n").filter(Boolean);
    if (lines.some((line) => line.includes("|"))) {
      return lines
        .filter((line) => !/^\s*\|[\s|:-]+\|\s*$/.test(line))
        .map((line) => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim()));
    }
    return lines.map((line) => line.split(/[,;]/).map((cell) => cell.trim().replace(/^"|"$/g, "")));
  }, [content]);

  if (rows.length === 0) return null;
  const [head, ...body] = rows;

  return (
    <div className="mt-2 max-h-96 overflow-auto rounded-lg border border-[var(--g3-border)]">
      <table className="w-full text-left text-xs">
        <thead className="bg-[var(--g3-elevated)]">
          <tr>
            {head.map((cell, index) => (
              <th key={index} className="px-2.5 py-1.5 font-semibold text-[var(--g3-text-secondary)]">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {body.slice(0, 200).map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-2.5 py-1.5 text-[var(--g3-text-secondary)]">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > 200 && <p className="px-2.5 py-1.5 text-[10px] text-[var(--g3-faint)]">200 premières lignes affichées sur {body.length}.</p>}
    </div>
  );
}

export function ArtifactAttachmentsBadges({
  artifacts,
}: {
  artifacts: Pick<ConversationArtifact, "id" | "title" | "type">[];
}) {
  if (artifacts.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {artifacts.map((artifact) => (
        <span key={artifact.id} className="inline-flex items-center gap-1 rounded-full border border-[var(--g3-border)] bg-[var(--g3-surface)] px-2 py-0.5 text-[10px] text-[var(--g3-muted)]">
          <span aria-hidden>{ARTIFACT_TYPE_ICONS[artifact.type] ?? "□"}</span>
          {artifact.title.slice(0, 40)}
        </span>
      ))}
    </div>
  );
}

export function formatArtifactSize(bytes?: number) {
  return formatBytes(bytes);
}
