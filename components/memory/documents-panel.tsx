"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { uploadPermanentFiles, type UploadItem } from "@/lib/storage/upload-client";
import { formatBytes, MAX_FILES_PER_BATCH } from "@/lib/storage/upload-policy";
import type { StorageUsageView } from "@/components/memory/memory-workspace";

export type DocumentFileEntry = {
  path: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  uploadedAt: string;
  source: "memory" | "legacy";
};

function fileBadge(entry: { filename: string; contentType: string }): string {
  const extension = entry.filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    pdf: "PDF", doc: "DOC", docx: "DOC", odt: "DOC", rtf: "DOC", txt: "TXT", md: "MD",
    xls: "XLS", xlsx: "XLS", ods: "XLS", csv: "CSV", tsv: "CSV", json: "JSON",
    ppt: "PPT", pptx: "PPT", odp: "PPT",
    png: "IMG", jpg: "IMG", jpeg: "IMG", gif: "IMG", webp: "IMG", heic: "IMG", svg: "IMG", bmp: "IMG", tiff: "IMG", tif: "IMG",
    mp3: "AUD", wav: "AUD", m4a: "AUD", ogg: "AUD", flac: "AUD", aac: "AUD",
    mp4: "VID", mov: "VID", webm: "VID", avi: "VID", mkv: "VID",
    zip: "ZIP", tar: "AR", gz: "AR",
  };
  return map[extension] ?? "DOC";
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
function formatDate(iso: string): string {
  const cached = dateFormatters.get("fr-FR") ?? new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
  dateFormatters.set("fr-FR", cached);
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return cached.format(date);
}

/**
 * Documents réellement stockés : téléversement par lots (10 fichiers max,
 * 100 Mo max par fichier) avec progression par chunk, téléchargement via
 * URL signée et suppression définitive.
 */
export function DocumentsPanel(props: {
  files: DocumentFileEntry[];
  usage: StorageUsageView | null;
  loaded: boolean;
  onRefresh: () => Promise<void>;
  onNotify: (message: string) => void;
}) {
  const [queue, setQueue] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [confirmingPath, setConfirmingPath] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef(false);

  const filtered = useCallback(() => {
    const query = search.trim().toLowerCase();
    if (!query) return props.files;
    return props.files.filter((file) => file.filename.toLowerCase().includes(query));
  }, [props.files, search])();

  const startUpload = async (selected: File[]) => {
    if (selected.length === 0 || uploading) return;
    if (selected.length > MAX_FILES_PER_BATCH) {
      props.onNotify(`Maximum ${MAX_FILES_PER_BATCH} fichiers par lot. Seuls les 10 premiers seront envoyés.`);
    }
    abortRef.current = false;
    setUploading(true);
    try {
      const result = await uploadPermanentFiles(selected.slice(0, MAX_FILES_PER_BATCH), (items) => setQueue(items), () => abortRef.current);
      if (result.uploaded.length > 0) {
        props.onNotify(`${result.uploaded.length} fichier${result.uploaded.length > 1 ? "s" : ""} stocké${result.uploaded.length > 1 ? "s" : ""} durablement dans votre mémoire permanente.`);
      }
      if (result.failed.length > 0) {
        props.onNotify(`${result.failed.length} fichier${result.failed.length > 1 ? "s" : ""} en échec : ${result.failed[0]?.error ?? "erreur inconnue"}`);
      }
      await props.onRefresh();
    } finally {
      setUploading(false);
      setTimeout(() => setQueue([]), 4000);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const dropped = Array.from(event.dataTransfer.files ?? []);
    void startUpload(dropped);
  };

  const download = async (file: DocumentFileEntry) => {
    setBusyFile(file.path);
    try {
      const response = await authFetch(`/api/storage/permanent?path=${encodeURIComponent(file.path)}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Lien de téléchargement indisponible.");
      window.open(String(body.url), "_blank", "noopener");
    } catch (error) {
      props.onNotify(error instanceof Error ? error.message : "Téléchargement impossible.");
    } finally {
      setBusyFile(null);
    }
  };

  const remove = async (file: DocumentFileEntry) => {
    setBusyFile(file.path);
    try {
      const response = await authFetch("/api/storage/permanent", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: file.path }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Suppression impossible.");
      setConfirmingPath(null);
      await props.onRefresh();
    } catch (error) {
      props.onNotify(error instanceof Error ? error.message : "Suppression impossible.");
    } finally {
      setBusyFile(null);
    }
  };

  return (
    <section className="space-y-4" aria-label="Documents stockés">
      {/* Zone de dépôt */}
      <div
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        data-dragging={dragging || undefined}
        className={`g3-card flex flex-col items-center justify-center border p-8 text-center transition ${dragging ? "border-sky-400 bg-sky-50" : "border-[rgba(23,23,20,0.09)]"}`}
      >
        <p className="font-serif text-lg font-semibold">Déposez vos documents ici</p>
        <p className="mt-1 max-w-md text-sm text-[var(--g3-muted)]">
          Jusqu&apos;à <strong>{MAX_FILES_PER_BATCH} fichiers par lot</strong>, <strong>100 Mo par fichier</strong>.
          PDF, Word, Excel, images, audio, vidéo, archives et textes.
        </p>
        <button
          type="button"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          className="g3-btn g3-btn-primary mt-4 min-h-11 disabled:opacity-50"
        >
          {uploading ? "Téléversement en cours…" : "Choisir des fichiers"}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          disabled={uploading}
          aria-label="Sélectionner jusqu'à 10 fichiers à stocker"
          className="hidden"
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? []);
            event.target.value = "";
            void startUpload(selected);
          }}
        />
      </div>

      {/* File d'attente de téléversement */}
      {queue.length > 0 && (
        <div className="g3-card p-5" aria-live="polite">
          <h3 className="text-sm font-semibold text-[var(--g3-text-secondary)]">Téléversement</h3>
          <ul className="mt-3 space-y-3">
            {queue.map((item) => (
              <li key={item.id} className="min-w-0">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 flex-1 truncate font-medium text-[var(--g3-text-secondary)]">{item.filename}</span>
                  <span className={`shrink-0 font-semibold ${item.status === "error" ? "text-red-600" : item.status === "done" ? "text-emerald-600" : "text-[var(--g3-muted)]"}`}>
                    {item.status === "pending" && "en attente"}
                    {item.status === "uploading" && `${Math.round(item.progress * 100)}%`}
                    {item.status === "done" && "stocké ✓"}
                    {item.status === "error" && "échec"}
                    {item.status === "cancelled" && "annulé"}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--g3-elevated)]">
                  <div
                    className={`h-full rounded-full transition-all ${item.status === "error" ? "bg-red-500" : item.status === "done" ? "bg-emerald-500" : "bg-sky-500"}`}
                    style={{ width: `${Math.max(Math.round(item.progress * 100), item.status === "pending" ? 0 : 4)}%` }}
                  />
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-[var(--g3-faint)]">
                  <span>{formatBytes(item.sizeBytes)}</span>
                  {item.error && <span className="truncate text-red-500">{item.error}</span>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Liste des documents */}
      <div className="g3-card p-5 md:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-serif text-xl font-semibold">Vos documents</h2>
            <p className="mt-1 text-sm text-[var(--g3-muted)]">Téléchargeables à tout moment via des liens signés de 10 minutes.</p>
          </div>
          {props.files.length > 5 && (
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Rechercher un document…"
              aria-label="Rechercher un document"
              className="g3-input w-full sm:w-64"
            />
          )}
        </div>

        {props.loaded && filtered.length > 0 && (
          <ul className="mt-4 space-y-2">
            {filtered.map((file) => (
              <li key={file.path} className="flex items-center justify-between gap-3 rounded-xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-elevated)] px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--g3-deep)] font-mono text-[10px] font-bold text-white" aria-hidden="true">
                    {fileBadge(file)}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[var(--g3-text)]" title={file.filename}>{file.filename}</p>
                    <p className="text-xs text-[var(--g3-faint)]">
                      {formatBytes(file.sizeBytes)}
                      {file.uploadedAt && file.uploadedAt !== "1970-01-01T00:00:00.000Z" && ` · ${formatDate(file.uploadedAt)}`}
                      {file.source === "legacy" && " · dépôt direct"}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    disabled={busyFile === file.path}
                    onClick={() => download(file)}
                    className="min-h-9 rounded-md border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] px-3 text-[11px] font-semibold text-[var(--g3-text-secondary)] hover:bg-[var(--g3-elevated)] disabled:opacity-40"
                  >
                    Télécharger
                  </button>
                  {confirmingPath === file.path ? (
                    <>
                      <button
                        disabled={busyFile === file.path}
                        onClick={() => remove(file)}
                        className="min-h-9 rounded-md border border-red-300 bg-red-50 px-3 text-[11px] font-semibold text-red-700 hover:bg-red-100"
                      >
                        Supprimer définitivement
                      </button>
                      <button
                        onClick={() => setConfirmingPath(null)}
                        className="min-h-9 rounded-md border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] px-2.5 text-[11px] font-semibold text-[var(--g3-muted)]"
                      >
                        Annuler
                      </button>
                    </>
                  ) : (
                    <button
                      disabled={busyFile === file.path}
                      onClick={() => setConfirmingPath(file.path)}
                      aria-label={`Supprimer ${file.filename}`}
                      className="min-h-9 rounded-md border border-red-200 bg-[var(--g3-surface)] px-2.5 text-[11px] font-semibold text-red-600 hover:bg-red-50 disabled:opacity-40"
                    >
                      Supprimer
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {props.loaded && props.files.length > 0 && filtered.length === 0 && (
          <p className="mt-4 text-sm text-[var(--g3-faint)]">Aucun document ne correspond à « {search} ».</p>
        )}
        {props.loaded && props.files.length === 0 && (
          <p className="mt-4 text-sm text-[var(--g3-faint)]">
            Aucun document pour le moment. Déposez vos premiers fichiers ci-dessus : ils seront disponibles pour
            vous et vos agents à chaque session.
          </p>
        )}
      </div>
    </section>
  );
}
