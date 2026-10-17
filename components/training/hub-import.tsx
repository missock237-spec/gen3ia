"use client";

import { useCallback, useState, type FormEvent } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { formatBytes } from "./studio-bits";

/* ------------------------------------------------------------------ */
/* Panneau d'import de datasets depuis les hubs (v1.1)                  */
/* Hugging Face + Kaggle : recherche, inspection réelle, import        */
/* supervisé sous plafonds — chaque exclusion est EXPLIQUÉE.           */
/* ------------------------------------------------------------------ */

type HubProvider = "huggingface" | "kaggle";

interface HubSummary {
  provider: HubProvider;
  ref: string;
  name: string;
  description: string;
  sizeBytes: number | null;
  downloads: number | null;
  likes: number | null;
  license: string | null;
  lastModified: string | null;
  tags: string[];
}

interface HubDetail extends HubSummary {
  files: Array<{ name: string; sizeBytes: number; downloadable: boolean }>;
  splits: Array<{ name: string; rows: number | null }>;
  columns: string[];
  previewRows: Array<Record<string, unknown>>;
  notes: string[];
  inspectedAt: string;
}

interface ImportSummary {
  datasets: Array<{ id: string; name: string; rows: number }>;
  skipped: Array<{ name: string; reason: string }>;
  origin: {
    provider: HubProvider;
    ref: string;
    declaredTotalRows: number | null;
    notes: string[];
  };
}

const PROVIDER_LABELS: Record<HubProvider, string> = {
  huggingface: "Hugging Face",
  kaggle: "Kaggle",
};

function formatCount(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} k`;
  return String(value);
}

export function HubImportPanel({
  projectId,
  onChanged,
  onError,
}: {
  projectId: string;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [provider, setProvider] = useState<HubProvider>("huggingface");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HubSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [detail, setDetail] = useState<HubDetail | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [split, setSplit] = useState("train");
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const search = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const trimmed = query.trim();
      if (trimmed.length === 0) return;
      setSearching(true);
      setDetail(null);
      setSummary(null);
      onError("");
      try {
        const response = await authFetch(
          `/api/training/hub/search?provider=${provider}&q=${encodeURIComponent(trimmed)}`,
          { cache: "no-store" },
        );
        const data = (await response.json().catch(() => ({}))) as { datasets?: HubSummary[]; error?: string };
        if (!response.ok) {
          onError(data.error ?? "Recherche indisponible.");
          setResults(null);
          return;
        }
        setResults(data.datasets ?? []);
      } catch {
        onError("Recherche indisponible : vérifiez votre connexion.");
      } finally {
        setSearching(false);
      }
    },
    [onError, provider, query],
  );

  const inspect = useCallback(
    async (ref: string) => {
      setInspecting(true);
      setDetail(null);
      setSummary(null);
      onError("");
      try {
        const response = await authFetch(
          `/api/training/hub/inspect?provider=${provider}&ref=${encodeURIComponent(ref)}`,
          { cache: "no-store" },
        );
        const data = (await response.json().catch(() => ({}))) as { dataset?: HubDetail; error?: string };
        if (!response.ok || !data.dataset) {
          onError(data.error ?? "Inspection indisponible.");
          return;
        }
        setDetail(data.dataset);
      } catch {
        onError("Inspection indisponible : vérifiez votre connexion.");
      } finally {
        setInspecting(false);
      }
    },
    [onError, provider],
  );

  const importDataset = useCallback(
    async (ref: string) => {
      setImporting(true);
      onError("");
      try {
        const response = await authFetch(`/api/training/projects/${projectId}/datasets/import`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider, ref, split }),
        });
        const data = (await response.json().catch(() => ({}))) as Partial<ImportSummary> & { error?: string };
        if (!response.ok) {
          onError(data.error ?? "Import impossible.");
          return;
        }
        if (data.datasets && data.origin) {
          setSummary({ datasets: data.datasets, skipped: data.skipped ?? [], origin: data.origin });
          setDetail(null);
          onChanged();
        }
      } catch {
        onError("Import impossible : vérifiez votre connexion.");
      } finally {
        setImporting(false);
      }
    },
    [onChanged, onError, projectId, provider, split],
  );

  const previewColumns = detail && detail.previewRows.length > 0
    ? Object.keys(detail.previewRows[0] ?? {}).slice(0, 6)
    : [];

  return (
    <div className="space-y-4">
      {/* Sélecteur de hub + recherche */}
      <div className="flex flex-wrap items-center gap-2">
        {(Object.keys(PROVIDER_LABELS) as HubProvider[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setProvider(key);
              setResults(null);
              setDetail(null);
              setSummary(null);
            }}
            className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
              provider === key
                ? "bg-[var(--g3-primary-soft)] text-[var(--g3-primary-strong)]"
                : "text-[var(--g3-muted)] hover:bg-[var(--g3-hover)]"
            }`}
            aria-pressed={provider === key}
          >
            {PROVIDER_LABELS[key]}
          </button>
        ))}
      </div>

      <form onSubmit={search} className="flex gap-2">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={80}
          placeholder={`Rechercher un dataset ${PROVIDER_LABELS[provider]}…`}
          aria-label={`Recherche de datasets ${PROVIDER_LABELS[provider]}`}
          className="flex-1 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] placeholder:text-[var(--g3-faint)]"
        />
        <button
          type="submit"
          disabled={searching || query.trim().length === 0}
          className="rounded-xl bg-[var(--g3-primary)] px-4 py-2.5 text-sm font-semibold text-[var(--g3-on-primary)] transition hover:bg-[var(--g3-primary-strong)] disabled:opacity-50"
        >
          {searching ? "…" : "Rechercher"}
        </button>
      </form>

      {/* Résultats de recherche */}
      {results !== null ? (
        results.length === 0 ? (
          <p className="text-xs text-[var(--g3-muted)]">
            Aucun résultat pour « {query} » sur {PROVIDER_LABELS[provider]}.
          </p>
        ) : (
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {results.map((item) => (
              <div
                key={`${item.provider}:${item.ref}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[var(--g3-text)]">{item.name}</p>
                  <p className="truncate text-xs text-[var(--g3-faint)]">
                    {item.ref}
                    {item.sizeBytes !== null ? ` · ${formatBytes(item.sizeBytes)}` : ""}
                    {item.downloads !== null ? ` · ${formatCount(item.downloads)} téléchargements` : ""}
                    {item.likes !== null ? ` · ${formatCount(item.likes)} ★` : ""}
                    {item.license ? ` · ${item.license}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void inspect(item.ref)}
                    disabled={inspecting}
                    className="rounded-xl px-3 py-1.5 text-xs font-semibold text-[var(--g3-primary-strong)] transition hover:bg-[var(--g3-primary-soft)] disabled:opacity-50"
                  >
                    Examiner
                  </button>
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        <p className="text-xs leading-5 text-[var(--g3-muted)]">
          Importez directement depuis {PROVIDER_LABELS[provider]} : les fichiers sont réellement téléchargés puis
          analysés par le même pipeline que vos téléversements (statistiques, doublons, avertissement RGPD).
        </p>
      )}

      {/* Inspection détaillée */}
      {detail ? (
        <div className="ts-card space-y-4 p-5">
          <div>
            <h4 className="font-serif text-sm font-semibold text-[var(--g3-text)]">{detail.name}</h4>
            <p className="mt-0.5 text-xs text-[var(--g3-faint)]">
              {detail.ref}
              {detail.license ? ` · licence ${detail.license}` : ""}
              {detail.sizeBytes !== null ? ` · ${formatBytes(detail.sizeBytes)} déclarés` : ""}
            </p>
          </div>

          {detail.splits.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {detail.splits.map((splitInfo) => (
                <span key={splitInfo.name} className="ts-chip" data-variant="valid">
                  {splitInfo.name} : {splitInfo.rows === null ? "?" : splitInfo.rows.toLocaleString("fr-FR")} lignes
                </span>
              ))}
            </div>
          ) : null}

          {detail.notes.length > 0 ? (
            <ul className="space-y-1">
              {detail.notes.map((note) => (
                <li key={note} className="text-xs leading-5 text-[var(--g3-muted)]">
                  · {note}
                </li>
              ))}
            </ul>
          ) : null}

          <div>
            <p className="mb-1.5 text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">
              Fichiers ({detail.files.length})
            </p>
            <div className="max-h-40 space-y-1 overflow-y-auto pr-1 font-mono text-[11px] text-[var(--g3-text-secondary)]">
              {detail.files.slice(0, 50).map((file) => (
                <div key={file.name} className="flex items-center justify-between gap-3">
                  <span className="truncate">{file.name}</span>
                  <span className={file.downloadable ? "text-[var(--g3-info)]" : "text-[var(--g3-faint)]"}>
                    {file.sizeBytes > 0 ? formatBytes(file.sizeBytes) : "taille n.c."}
                    {file.downloadable ? "" : " · non ingérable"}
                  </span>
                </div>
              ))}
              {detail.files.length > 50 ? <p className="text-[var(--g3-faint)]">… et {detail.files.length - 50} autres</p> : null}
            </div>
          </div>

          {previewColumns.length > 0 ? (
            <div>
              <p className="mb-1.5 text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">
                Échantillon réel (hub)
              </p>
              <div className="overflow-x-auto rounded-xl bg-[var(--g3-deep)] p-3">
                <table className="w-full text-left text-[11px]">
                  <thead>
                    <tr className="text-[var(--g3-faint)]">
                      {previewColumns.map((column) => (
                        <th key={column} className="px-2 py-1 font-semibold">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="text-[var(--g3-text-secondary)]">
                    {detail.previewRows.slice(0, 4).map((row, index) => (
                      <tr key={index}>
                        {previewColumns.map((column) => (
                          <td key={column} className="max-w-52 truncate px-2 py-1">
                            {String(row[column] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <select
              value={split}
              onChange={(event) => setSplit(event.target.value)}
              aria-label="Split d'affectation des fichiers importés"
              className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-2 text-sm text-[var(--g3-text)]"
            >
              <option value="train">Entraînement (train)</option>
              <option value="validation">Validation</option>
              <option value="test">Test</option>
              <option value="unassigned">Non assigné</option>
            </select>
            <button
              type="button"
              onClick={() => void importDataset(detail.ref)}
              disabled={importing}
              className="rounded-xl bg-[var(--g3-primary)] px-4 py-2 text-sm font-semibold text-[var(--g3-on-primary)] transition hover:bg-[var(--g3-primary-strong)] disabled:opacity-50"
            >
              {importing ? "Téléchargement en cours…" : "Importer dans le projet"}
            </button>
            <p className="text-xs text-[var(--g3-faint)]">
              Seuls les fichiers .csv/.json/.jsonl/.txt sous les plafonds sont importés.
            </p>
          </div>
        </div>
      ) : null}

      {inspecting ? <p className="text-xs text-[var(--g3-muted)]">Inspection du hub en cours…</p> : null}

      {/* Résultat d'import */}
      {summary ? (
        <div className="ts-card space-y-3 p-5">
          <h4 className="font-serif text-sm font-semibold text-[var(--g3-text)]">
            Import terminé — {summary.datasets.length} fichier(s) ajouté(s)
            {summary.origin.declaredTotalRows !== null
              ? ` (jeu déclaré par le hub : ${summary.origin.declaredTotalRows.toLocaleString("fr-FR")} lignes au total)`
              : ""}
          </h4>
          <ul className="space-y-1 text-xs text-[var(--g3-text-secondary)]">
            {summary.datasets.map((dataset) => (
              <li key={dataset.id}>
                ✓ {dataset.name} — {dataset.rows.toLocaleString("fr-FR")} lignes analysées
              </li>
            ))}
            {summary.skipped.map((skipped) => (
              <li key={skipped.name} className="text-[var(--g3-warning-strong)]">
                · {skipped.name} : {skipped.reason}
              </li>
            ))}
          </ul>
          {summary.skipped.length === 0 ? null : (
            <p className="text-xs text-[var(--g3-muted)]">
              Les fichiers écartés restent disponibles sur le hub : réduisez leur taille ou augmentez les plafonds
              (variables TRAINING_*) pour les inclure.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
