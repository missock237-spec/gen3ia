"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch, readJsonSafely, useSessionAvailable } from "@/lib/firebase/auth-client";
import { SectionHeader } from "@/components/shells/section-header";
import { EmptyState, LoadingState } from "@/components/shells/states";

/**
 * Centre de données — console client.
 *
 * Destination « Gestion des datasets » (restructuration des parcours) :
 * liste des datasets par projet d'entraînement, import de fichier réel
 * (csv/json/jsonl/txt — parsé côté serveur : stats, doublons, PII),
 * import depuis les hubs Hugging Face / Kaggle (recherche réelle) et
 * INSPECTION RÉELLE d'un jeu du hub avant import (fichiers, splits
 * déclarés, licence, échantillon de lignes — it.48).
 *
 * Le hachage #projet-<id> (posé par le Laboratoire) pré-sélectionne le
 * projet concerné : les deux espaces forment un même parcours cohérent.
 */

interface TrainingProject {
  id: string;
  name: string;
  family: string;
  updatedAt: string;
}

interface ValidationFinding {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
}

interface DatasetStats {
  rows?: number;
  columns?: number;
  duplicates?: number;
  [key: string]: unknown;
}

interface DatasetAsset {
  id: string;
  name: string;
  format: string;
  split: string;
  source: string;
  hubRef?: string | null;
  status: "valid" | "rejected";
  findings: ValidationFinding[];
  stats: DatasetStats;
  sizeBytes: number;
  createdAt: string;
}

interface HubResult {
  id?: string;
  ref?: string;
  name?: string;
  title?: string;
  downloads?: number;
  likes?: number;
  [key: string]: unknown;
}

/** Contrat de la porte /api/training/hub/inspect (it.48) : le détail
 *  remonté par l'API du hub — tout ce qui n'est pas exposé est null et
 *  affiché comme tel (honnêteté de la porte, restituée côté console). */
interface HubDetail {
  provider: string;
  ref: string;
  name: string;
  description: string;
  sizeBytes: number | null;
  downloads: number | null;
  likes: number | null;
  license: string | null;
  lastModified: string | null;
  tags: string[];
  files: Array<{ name: string; sizeBytes: number; downloadable: boolean }>;
  splits: Array<{ name: string; rows: number | null }>;
  columns: string[];
  previewRows: Array<Record<string, unknown>>;
  notes: string[];
  inspectedAt: string;
}

const SPLITS = ["train", "validation", "test", "unassigned"] as const;

const SOURCE_LABEL: Record<string, string> = {
  upload: "Téléversement",
  huggingface: "Hugging Face",
  kaggle: "Kaggle",
};

const formatBytesFr = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 o";
  const units = ["o", "Ko", "Mo", "Go"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[exponent]}`;
};

const formatDateFr = (iso?: string | null): string => {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

function Badge({ label, className }: { label: string; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${className ?? "bg-[var(--g3-elevated)] text-[var(--g3-muted)]"}`}>
      {label}
    </span>
  );
}

export function DataConsole() {
  const sessionDisponible = useSessionAvailable();

  const [projects, setProjects] = useState<TrainingProject[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [datasets, setDatasets] = useState<DatasetAsset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Import fichier
  const [split, setSplit] = useState<string>("train");
  const [file, setFile] = useState<File | null>(null);

  // Recherche hub
  const [provider, setProvider] = useState<"huggingface" | "kaggle">("huggingface");
  const [query, setQuery] = useState("");
  const [hubResults, setHubResults] = useState<HubResult[]>([]);
  const [hubBusy, setHubBusy] = useState(false);
  const [hubError, setHubError] = useState<string | null>(null);
  const [hubSearched, setHubSearched] = useState(false);

  // Inspection hub (it.48)
  const [inspect, setInspect] = useState<HubDetail | null>(null);
  const [inspectBusy, setInspectBusy] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspecte, setInspecte] = useState<string | null>(null);

  // Le Laboratoire renvoie #projet-<id> pour pré-sélectionner le projet.
  useEffect(() => {
    const hash = window.location.hash.replace("#", "");
    if (hash.startsWith("projet-")) setSelectedProject(hash.slice("projet-".length));
  }, []);

  const chargerProjets = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await authFetch("/api/training/projects", { cache: "no-store" });
      if (response.ok) {
        const data = await readJsonSafely<{ projects?: TrainingProject[] }>(response);
        const list = data?.projects ?? [];
        setProjects(list);
        setSelectedProject((current) => current || list[0]?.id || "");
      } else if (response.status !== 401) {
        setLoadError("Impossible de charger vos projets.");
      }
    } catch {
      setLoadError("Connexion au serveur impossible. Vérifiez votre réseau puis réessayez.");
    } finally {
      setLoaded(true);
    }
  }, []);

  const chargerDatasets = useCallback(async (projectId: string) => {
    if (!projectId) { setDatasets([]); return; }
    setBusy(true);
    try {
      const response = await authFetch(`/api/training/projects/${projectId}/datasets`, { cache: "no-store" });
      if (response.ok) {
        const data = await readJsonSafely<{ datasets?: DatasetAsset[] }>(response);
        setDatasets(data?.datasets ?? []);
      } else if (response.status !== 401) {
        setActionError("Impossible de charger les datasets de ce projet.");
      }
    } catch {
      setActionError("Connexion au serveur impossible. Réessayez.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (sessionDisponible === false) return;
    void chargerProjets();
  }, [sessionDisponible, chargerProjets]);

  useEffect(() => {
    if (selectedProject) void chargerDatasets(selectedProject);
  }, [selectedProject, chargerDatasets]);

  const importerFichier = async () => {
    if (!selectedProject || !file) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("split", split);
      const response = await authFetch(
        `/api/training/projects/${selectedProject}/datasets`,
        { method: "POST", body: form },
        { timeoutMs: 180_000 },
      );
      const data = await readJsonSafely<{ dataset?: DatasetAsset; error?: string }>(response);
      if (!response.ok || !data?.dataset) {
        throw new Error(data?.error ?? `L'import a échoué (erreur ${response.status}).`);
      }
      setNotice(
        data.dataset.status === "valid"
          ? `Dataset « ${data.dataset.name} » importé et validé : ${data.dataset.stats?.rows ?? "?"} lignes analysées.`
          : `Dataset « ${data.dataset.name} » importé mais REJETÉ par la validation — corrigez les problèmes listés ci-dessous.`,
      );
      setFile(null);
      await chargerDatasets(selectedProject);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "L'import du dataset a échoué.");
    } finally {
      setBusy(false);
    }
  };

  const rechercherHub = async () => {
    if (!query.trim()) return;
    setHubBusy(true);
    setHubError(null);
    setHubSearched(true);
    try {
      const params = new URLSearchParams({ provider, q: query.trim(), limit: "8" });
      const response = await authFetch(`/api/training/hub/search?${params.toString()}`, { cache: "no-store" });
      const data = await readJsonSafely<{ results?: HubResult[]; error?: string }>(response);
      if (!response.ok) throw new Error(data?.error ?? "La recherche sur le hub a échoué.");
      setHubResults(data?.results ?? []);
    } catch (error) {
      setHubError(error instanceof Error ? error.message : "La recherche sur le hub a échoué.");
      setHubResults([]);
    } finally {
      setHubBusy(false);
    }
  };

  const importerDuHub = async (ref: string) => {
    if (!selectedProject) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch(`/api/training/projects/${selectedProject}/datasets/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, ref, split }),
      });
      const data = await readJsonSafely<{ dataset?: DatasetAsset; error?: string }>(response);
      if (!response.ok || !data?.dataset) {
        throw new Error(data?.error ?? `L'import depuis le hub a échoué (erreur ${response.status}).`);
      }
      setNotice(`Dataset « ${data.dataset.name} » téléchargé depuis ${SOURCE_LABEL[provider]} puis validé par le même pipeline qu'un upload.`);
      await chargerDatasets(selectedProject);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "L'import depuis le hub a échoué.");
    } finally {
      setBusy(false);
    }
  };

  /* Inspection réelle du jeu — GET /api/training/hub/inspect (it.48) :
   * fichiers, splits déclarés, licence et échantillon de lignes remontés
   * par l'API du hub — avant de décider d'importer. À la demande (clic),
   * jamais au montage : le rate-limit de la porte reste disponible. */
  const inspecterDuHub = async (ref: string) => {
    if (!ref.trim() || inspectBusy) return;
    setInspectBusy(true);
    setInspectError(null);
    setInspect(null);
    setInspecte(ref);
    try {
      const params = new URLSearchParams({ provider, ref });
      const response = await authFetch(`/api/training/hub/inspect?${params.toString()}`, { cache: "no-store" });
      const data = await readJsonSafely<{ dataset?: HubDetail; error?: string }>(response);
      if (response.status === 401) {
        setInspectError("Connectez-vous pour inspecter un jeu du hub.");
        return;
      }
      if (response.status === 429) {
        setInspectError("Trop d'inspections : patientez un instant.");
        return;
      }
      if (!response.ok || !data?.dataset) {
        throw new Error(data?.error ?? `L'inspection a échoué (erreur ${response.status}).`);
      }
      setInspect(data.dataset);
    } catch (error) {
      setInspectError(error instanceof Error ? error.message : "Inspection indisponible (réseau).");
    } finally {
      setInspectBusy(false);
    }
  };

  const projetActif = projects.find((project) => project.id === selectedProject);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-20 pt-6 sm:px-6">
      <SectionHeader
        eyebrow="GEN3IA · DONNÉES"
        title="Centre de"
        highlight="données"
        description="Un seul espace pour importer, valider et organiser les datasets de vos projets d'entraînement. Chaque import est réellement parsé : statistiques, doublons et données personnelles signalés avant l'entraînement."
      />

      {notice && (
        <p className="mb-4 rounded-2xl border border-[var(--g3-success-soft)] bg-[var(--g3-success-soft)] px-4 py-3 text-sm text-[var(--g3-success-strong)]" role="status">
          {notice}
        </p>
      )}
      {actionError && (
        <div className="mb-4 rounded-2xl border border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] px-4 py-3 text-sm text-[var(--g3-danger-strong)]" role="alert">
          {actionError}
          <button type="button" onClick={() => selectedProject ? void chargerDatasets(selectedProject) : void chargerProjets()} className="ml-3 underline underline-offset-2">
            Réessayer
          </button>
        </div>
      )}

      {sessionDisponible === false ? (
        <EmptyState
          icon="▤"
          title="Connectez-vous pour gérer vos données"
          description="Vos datasets restent privés : chaque fichier est rattaché à votre compte et à un projet d'entraînement."
          action={
            <a href="/login" className="inline-flex min-h-11 items-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white">
              Se connecter
            </a>
          }
        />
      ) : !loaded ? (
        <LoadingState label="Chargement du centre de données…" rows={3} />
      ) : loadError && projects.length === 0 ? (
        <EmptyState
          icon="⚠"
          title="Projets indisponibles"
          description={loadError}
          action={
            <button type="button" onClick={() => void chargerProjets()} className="inline-flex min-h-11 items-center rounded-full border border-[var(--g3-border)] px-5 py-2.5 text-sm font-semibold">
              Réessayer
            </button>
          }
        />
      ) : projects.length === 0 ? (
        <EmptyState
          icon="▤"
          title="Aucun projet d'entraînement"
          description="Les datasets se rattachent à un projet : créez d'abord votre projet dans le Laboratoire de modèles."
          action={
            <a href="/lab" className="inline-flex min-h-11 items-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white">
              Ouvrir le Laboratoire →
            </a>
          }
        />
      ) : (
        <div className="space-y-5">
          {/* Sélecteur de projet */}
          <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
            <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
              Projet d&apos;entraînement
              <select
                value={selectedProject}
                onChange={(event) => setSelectedProject(event.target.value)}
                className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)] sm:max-w-md"
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
            {projetActif && (
              <p className="mt-2 text-xs text-[var(--g3-faint)]">
                {datasets.length} dataset{datasets.length > 1 ? "s" : ""} · dernier import {formatDateFr(datasets[0]?.createdAt)}
              </p>
            )}
          </section>

          {/* Import fichier */}
          <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
            <h3 className="font-semibold text-[var(--g3-text)]">Importer un fichier</h3>
            <p className="mt-1.5 text-sm text-[var(--g3-muted)]">
              Formats acceptés : csv, json, jsonl, txt. Le contenu est réellement parsé et validé (lignes, doublons, avertissement PII/RGPD).
            </p>
            <form
              className="mt-4 grid gap-4 sm:grid-cols-[1fr_180px_auto]"
              onSubmit={(event) => { event.preventDefault(); void importerFichier(); }}
            >
              <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                Fichier
                <input
                  type="file"
                  accept=".csv,.json,.jsonl,.txt"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  className="mt-1.5 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-2.5 text-sm text-[var(--g3-text)] file:mr-3 file:rounded-full file:border-0 file:bg-[var(--g3-primary-soft)] file:px-3.5 file:py-1.5 file:text-xs file:font-semibold file:text-[var(--g3-primary-strong)]"
                />
              </label>
              <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                Split
                <select
                  value={split}
                  onChange={(event) => setSplit(event.target.value)}
                  className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
                >
                  {SPLITS.map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </label>
              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={busy || !file}
                  className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white transition enabled:hover:brightness-110 disabled:opacity-50 sm:w-auto"
                >
                  {busy ? "Import…" : "Importer"}
                </button>
              </div>
            </form>
          </section>

          {/* Recherche hub */}
          <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
            <h3 className="font-semibold text-[var(--g3-text)]">Importer depuis un hub</h3>
            <p className="mt-1.5 text-sm text-[var(--g3-muted)]">
              Recherche réelle sur Hugging Face et Kaggle : le fichier est téléchargé puis validé par le même pipeline qu&apos;un upload.
            </p>
            <form
              className="mt-4 grid gap-4 sm:grid-cols-[170px_1fr_auto]"
              onSubmit={(event) => { event.preventDefault(); void rechercherHub(); }}
            >
              <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                Hub
                <select
                  value={provider}
                  onChange={(event) => setProvider(event.target.value as "huggingface" | "kaggle")}
                  className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
                >
                  <option value="huggingface">Hugging Face</option>
                  <option value="kaggle">Kaggle</option>
                </select>
              </label>
              <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                Recherche
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="ex. french customer support"
                  maxLength={120}
                  className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
                />
              </label>
              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={hubBusy || !query.trim()}
                  className="inline-flex min-h-11 w-full items-center justify-center rounded-full border border-[var(--g3-border)] px-6 py-2.5 text-sm font-semibold transition enabled:hover:border-[var(--g3-primary-border)] disabled:opacity-50 sm:w-auto"
                >
                  {hubBusy ? "Recherche…" : "Rechercher"}
                </button>
              </div>
            </form>

            {hubError && <p className="mt-3 text-sm text-[var(--g3-danger-strong)]" role="alert">{hubError}</p>}
            {hubSearched && !hubBusy && hubResults.length === 0 && !hubError && (
              <p className="mt-3 text-sm text-[var(--g3-muted)]">Aucun résultat : essayez d&apos;autres mots-clés.</p>
            )}
            {hubResults.length > 0 && (
              <ul className="mt-4 space-y-2">
                {hubResults.map((result, index) => {
                  const ref = String(result.ref ?? result.id ?? "");
                  return (
                    <li key={ref || index} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm">
                      <span className="min-w-0 flex-1 truncate font-medium text-[var(--g3-text)]">
                        {String(result.title ?? result.name ?? ref)}
                        {result.downloads != null && <span className="ml-2 text-xs text-[var(--g3-faint)]">{String(result.downloads)} téléchargements</span>}
                      </span>
                      <span className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void inspecterDuHub(ref)}
                          disabled={inspectBusy || !ref}
                          className="inline-flex min-h-9 items-center rounded-full border border-[var(--g3-border)] px-4 py-1.5 text-xs font-semibold transition enabled:hover:border-[var(--g3-primary-border)] disabled:opacity-50"
                        >
                          {inspectBusy && inspecte === ref ? "Inspection…" : "Inspecter"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void importerDuHub(ref)}
                          disabled={busy || !selectedProject || !ref}
                          className="inline-flex min-h-9 items-center rounded-full bg-[var(--g3-primary-soft)] px-4 py-1.5 text-xs font-semibold text-[var(--g3-primary-strong)] transition enabled:hover:brightness-105 disabled:opacity-50"
                        >
                          Importer dans le projet
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {inspectError && (
              <p className="mt-3 text-sm text-[var(--g3-danger-strong)]" role="alert">{inspectError}</p>
            )}
            {inspect && (
              <div className="mt-4 rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4 text-sm" role="status">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-semibold text-[var(--g3-text)]">{inspect.name}</h4>
                  <span className="text-xs text-[var(--g3-faint)]">{SOURCE_LABEL[inspect.provider] ?? inspect.provider} · {inspect.ref}</span>
                </div>
                {inspect.description && <p className="mt-1 text-xs text-[var(--g3-muted)]">{inspect.description}</p>}
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
                  <div>
                    <dt className="text-[var(--g3-faint)]">Licence</dt>
                    <dd className="text-[var(--g3-text)]">{inspect.license ?? "non exposé par le hub"}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--g3-faint)]">Taille</dt>
                    <dd className="text-[var(--g3-text)]">{inspect.sizeBytes == null ? "non exposée" : formatBytesFr(inspect.sizeBytes)}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--g3-faint)]">Téléchargements</dt>
                    <dd className="text-[var(--g3-text)]">{inspect.downloads ?? "non exposés"}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--g3-faint)]">Dernière modification</dt>
                    <dd className="text-[var(--g3-text)]">{formatDateFr(inspect.lastModified)}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--g3-faint)]">J&apos;aime</dt>
                    <dd className="text-[var(--g3-text)]">{inspect.likes ?? "non exposés"}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--g3-faint)]">Tags</dt>
                    <dd className="text-[var(--g3-text)]">{inspect.tags.length > 0 ? inspect.tags.join(", ") : "—"}</dd>
                  </div>
                </dl>

                <h5 className="mt-3 text-xs font-semibold uppercase tracking-wide text-[var(--g3-muted)]">Splits déclarés</h5>
                {inspect.splits.length === 0 ? (
                  <p className="text-xs text-[var(--g3-muted)]">Le hub n&apos;a pas exposé de splits pour ce jeu.</p>
                ) : (
                  <ul className="mt-1 flex flex-wrap gap-2">
                    {inspect.splits.map((item) => (
                      <li key={item.name} className="rounded-full bg-[var(--g3-surface)] px-2.5 py-0.5 text-xs text-[var(--g3-text)]">
                        {item.name}{item.rows == null ? "" : ` · ${item.rows} lignes`}
                      </li>
                    ))}
                  </ul>
                )}

                <h5 className="mt-3 text-xs font-semibold uppercase tracking-wide text-[var(--g3-muted)]">Fichiers ({inspect.files.length})</h5>
                {inspect.files.length === 0 ? (
                  <p className="text-xs text-[var(--g3-muted)]">Aucun fichier exposé par le hub.</p>
                ) : (
                  <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto text-xs">
                    {inspect.files.map((file) => (
                      <li key={file.name} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-[var(--g3-text)]">{file.name}</span>
                        <span className="flex shrink-0 items-center gap-2 text-[var(--g3-faint)]">
                          {formatBytesFr(file.sizeBytes)}
                          <span className={file.downloadable ? "text-[var(--g3-success-strong)]" : "text-[var(--g3-warning-strong)]"}>
                            {file.downloadable ? "importable" : "format non géré"}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {inspect.columns.length > 0 && (
                  <p className="mt-3 text-xs text-[var(--g3-muted)]">Colonnes : {inspect.columns.join(", ")}</p>
                )}

                <h5 className="mt-3 text-xs font-semibold uppercase tracking-wide text-[var(--g3-muted)]">Échantillon réel</h5>
                {inspect.previewRows.length === 0 ? (
                  <p className="text-xs text-[var(--g3-muted)]">Aucun échantillon remonté (voir limites ci-dessous).</p>
                ) : (
                  <ul className="mt-1 space-y-1.5 text-xs">
                    {inspect.previewRows.map((row, index) => (
                      <li key={index} className="rounded-xl bg-[var(--g3-surface)] px-3 py-2 text-[var(--g3-text)]">
                        {Object.entries(row).map(([colonne, valeur]) => (
                          <span key={colonne} className="mr-2 inline-block">
                            <span className="text-[var(--g3-faint)]">{colonne} :</span> {String(valeur ?? "")}
                          </span>
                        ))}
                      </li>
                    ))}
                  </ul>
                )}

                {inspect.notes.length > 0 && (
                  <ul className="mt-3 space-y-1 text-xs text-[var(--g3-muted)]">
                    {inspect.notes.map((note, index) => (
                      <li key={index}>· {note}</li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 text-[11px] text-[var(--g3-faint)]">Inspection générée le {formatDateFr(inspect.inspectedAt)} — données remontées telles quelles par le hub, rien n&apos;est inventé.</p>
              </div>
            )}
          </section>

          {/* Liste des datasets */}
          <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
            <h3 className="font-semibold text-[var(--g3-text)]">Datasets du projet{projetActif ? ` : ${projetActif.name}` : ""}</h3>
            {busy && datasets.length === 0 ? (
              <LoadingState label="Chargement des datasets…" rows={2} />
            ) : datasets.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--g3-muted)]">Aucun dataset : importez un fichier ou passez par un hub pour démarrer.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {datasets.map((dataset) => {
                  const problems = dataset.findings.filter((finding) => finding.level === "warn" || finding.level === "error");
                  return (
                    <li key={dataset.id} className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="truncate font-semibold text-[var(--g3-text)]">{dataset.name}</span>
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge label={dataset.format.toUpperCase()} />
                          <Badge label={dataset.split} />
                          <Badge label={SOURCE_LABEL[dataset.source] ?? dataset.source} />
                          <Badge
                            label={dataset.status === "valid" ? "Valide" : "Rejeté"}
                            className={dataset.status === "valid" ? "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]" : "bg-[var(--g3-danger-soft)] text-[var(--g3-danger-strong)]"}
                          />
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-[var(--g3-muted)]">
                        {formatBytesFr(dataset.sizeBytes)}
                        {dataset.stats?.rows != null ? ` · ${dataset.stats.rows} lignes` : ""}
                        {dataset.stats?.duplicates ? ` · ${dataset.stats.duplicates} doublons` : ""}
                        {dataset.hubRef ? ` · ${dataset.hubRef}` : ""}
                        {` · importé ${formatDateFr(dataset.createdAt)}`}
                      </p>
                      {problems.length > 0 && (
                        <ul className="mt-2 space-y-1 text-xs">
                          {problems.slice(0, 4).map((finding, index) => (
                            <li key={index} className={finding.level === "error" ? "text-[var(--g3-danger-strong)]" : "text-[var(--g3-warning-strong)]"}>
                              {finding.level === "error" ? "✕" : "⚠"} {finding.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
