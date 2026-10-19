"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { SectionHeader } from "@/components/shells/section-header";
import { EmptyState, LoadingState } from "@/components/shells/states";
import { HubImportPanel } from "./hub-import";
import {
  Chip,
  ErrorBanner,
  FindingsList,
  LogViewer,
  ProgressBar,
  StatusChip,
  formatBytes,
  formatDuration,
} from "./studio-bits";

import type {
  DatasetAsset,
  ExportArtifact,
  ProjectOverview,
  TrainingJob,
  TrainingPlan,
} from "@/lib/training/types";

/* ------------------------------------------------------------------ */
/* Espace projet Training Studio — parcours en 7 étapes (spec §4).      */
/* Les trois modes (auto / assisté / avancé) partagent les mêmes        */
/* composants : seule la profondeur d'affichage change (spec §5).      */
/* ------------------------------------------------------------------ */

interface CatalogPayload {
  engines: Array<{
    id: string;
    name: string;
    description: string;
    methods: string[];
    minVramGb: number;
    parameters: Array<{ key: string; label: string; type: string; min?: number; max?: number; step?: number; defaultValue?: number | string | boolean; description: string }>;
    knownLimits: string[];
  }>;
  baseModels: Array<{ id: string; name: string; params: string; minVramGb: number; recommendedFor: string[]; notes: string }>;
  providers: Array<{ id: string; label: string; configured: boolean; gpus: Array<{ name: string; vramGb: number; available: boolean }>; simulated: boolean }>;
  quotas: { maxProjects: number; maxConcurrentJobs: number; maxUploadMb: number; maxDatasetsPerProject: number; maxModelsPerProject: number };
}

const STEPS = [
  { key: "project", label: "Projet" },
  { key: "model", label: "Modèle" },
  { key: "data", label: "Données" },
  { key: "analysis", label: "Analyse" },
  { key: "training", label: "Entraînement" },
  { key: "evaluation", label: "Évaluation" },
  { key: "export", label: "Export" },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

const FAMILY_LABELS: Record<string, string> = {
  text: "Langage / conversationnel",
  image: "Images",
  audio: "Audio / voix",
  video: "Vidéo",
  multimodal: "Multimodal",
  specialized: "Tâche spécialisée",
};

const METHOD_LABELS: Record<string, string> = {
  "full-training": "Entraînement complet",
  finetune: "Fine-tuning",
  lora: "Fine-tuning LoRA",
  qlora: "Fine-tuning QLoRA",
  adapter: "Adaptateurs",
  "eval-only": "Évaluation seule",
  quantize: "Quantification",
  convert: "Conversion",
  rag: "Système RAG (indexation)",
};

export function TrainingProjectWorkspace({ projectId }: { projectId: string }) {
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [catalog, setCatalog] = useState<CatalogPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [unauthenticated, setUnauthenticated] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState<StepKey>("project");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await authFetch(`/api/training/projects/${projectId}`, { cache: "no-store" });
      if (response.status === 401) {
        setUnauthenticated(true);
        return;
      }
      if (response.status === 404) {
        setNotFound(true);
        return;
      }
      if (response.ok) {
        const data = (await response.json()) as ProjectOverview & { requestId?: string };
        setOverview({
          project: data.project,
          models: data.models ?? [],
          datasets: data.datasets ?? [],
          plans: data.plans ?? [],
          jobs: data.jobs ?? [],
          exports: data.exports ?? [],
        });
      }
    } catch {
      // Réseau indisponible : l'état précédent reste affiché.
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await authFetch("/api/training/catalog", { cache: "no-store" });
        if (response.ok) {
          const data = (await response.json()) as { catalog: CatalogPayload };
          setCatalog(data.catalog);
        }
      } catch {
        /* catalogue optionnel à l'affichage */
      }
    })();
  }, []);

  // Poll léger quand une tâche est active : progression réelle uniquement.
  const hasActiveJob = overview?.jobs.some((job) => job.status === "running" || job.status === "queued") ?? false;
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!hasActiveJob) return;
    pollRef.current = setInterval(() => void load(), 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [hasActiveJob, load]);

  const stepState = useCallback(
    (key: StepKey): "active" | "done" | "disabled" => {
      if (!overview) return "disabled";
      switch (key) {
        case "project":
          return "done";
        case "model":
          return overview.models.length > 0 ? "done" : "active";
        case "data":
          return overview.datasets.length > 0 ? "done" : "active";
        case "analysis":
          return overview.plans.length > 0 ? "done" : overview.models.length > 0 || overview.datasets.length > 0 ? "active" : "disabled";
        case "training":
          return overview.jobs.length > 0 ? "done" : overview.plans.some((p) => p.status === "accepted") ? "active" : "disabled";
        case "evaluation":
          return overview.jobs.some((j) => j.status === "completed") ? "active" : "disabled";
        case "export":
          return "active";
        default:
          return "disabled";
      }
    },
    [overview],
  );

  if (unauthenticated) {
    return (
      <EmptyState
        icon="⚿"
        title="Connexion requise"
        description="Connectez-vous pour accéder à vos projets d'entraînement."
      />
    );
  }
  if (notFound) {
    return <EmptyState icon="◇" title="Projet introuvable" description="Ce projet n'existe pas ou n'est pas le vôtre." />;
  }
  if (loading || !overview) {
    return <LoadingState label="Chargement du projet d'entraînement…" rows={4} />;
  }

  const mode = overview.project.mode;
  const activeJob = overview.jobs.find((job) => job.status === "running" || job.status === "queued");
  const completedJob = overview.jobs.find((job) => job.status === "completed");
  const proposedPlan = overview.plans.find((p) => p.status === "proposed");
  const acceptedPlan = overview.plans.find((p) => p.status === "accepted");

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="AI Training Studio"
        title={overview.project.name}
        description={overview.project.objective || overview.project.description || "Projet d'entraînement de modèle IA"}
        breadcrumbs={[
          { label: "Training Studio", href: "/workspace/training" },
          { label: overview.project.name },
        ]}
      />

      <ProviderBanner catalog={catalog} />

      <nav className="ts-stepper" aria-label="Étapes du projet d'entraînement">
        {STEPS.map((entry, index) => {
          const state = step === entry.key ? "active" : stepState(entry.key);
          return (
            <button
              key={entry.key}
              type="button"
              className="ts-step"
              data-state={state}
              onClick={() => setStep(entry.key)}
              disabled={state === "disabled"}
            >
              <span className="ts-step-index">{state === "done" ? "✓" : index + 1}</span>
              <span>{entry.label}</span>
            </button>
          );
        })}
      </nav>

      {error ? <ErrorBanner message={error} /> : null}

      {step === "project" ? <ProjectStep overview={overview} onChanged={load} /> : null}
      {step === "model" ? <ModelStep overview={overview} catalog={catalog} mode={mode} onChanged={load} onError={setError} /> : null}
      {step === "data" ? <DataStep overview={overview} mode={mode} onChanged={load} onError={setError} /> : null}
      {step === "analysis" ? (
        <AnalysisStep
          overview={overview}
          mode={mode}
          onChanged={load}
          onError={setError}
          plan={proposedPlan ?? acceptedPlan ?? null}
        />
      ) : null}
      {step === "training" ? (
        <TrainingStep
          overview={overview}
          job={activeJob ?? completedJob ?? null}
          onChanged={load}
          onError={setError}
        />
      ) : null}
      {step === "evaluation" ? <EvaluationStep job={completedJob ?? null} /> : null}
      {step === "export" ? <ExportStep overview={overview} onChanged={load} onError={setError} /> : null}
    </div>
  );
}

/* ================================================================== */
/* Bandeau fournisseurs — honnêteté sur l'exécution réelle              */
/* (Gen3 natif : TOUJOURS disponible, CPU local ; GPU worker : option)  */
/* ================================================================== */

function ProviderBanner({ catalog }: { catalog: CatalogPayload | null }) {
  if (!catalog) return null;
  const natif = catalog.providers.filter((p) => p.id === "gen3-local" && p.configured && !p.simulated);
  const gpu = catalog.providers.filter((p) => p.id !== "gen3-local" && p.configured && !p.simulated);
  return (
    <div className="ts-card flex flex-wrap items-center gap-3 px-4 py-3 text-sm text-[var(--g3-text-secondary)]">
      {natif.length > 0 ? (
        <>
          <Chip variant="valid">Gen entraîne vos modèles — moteur natif actif</Chip>
          <span>Entraînement réel sur CPU, sans GPU requis (moteur Gen3 natif).</span>
        </>
      ) : null}
      {gpu.length > 0 ? (
        <span>
          <Chip variant="valid">GPU disponible</Chip>{" "}
          {gpu.map((p) => `${p.label} — ${p.gpus.map((g) => `${g.name} (${g.vramGb} Go)`).join(", ")}`).join(" · ")}
        </span>
      ) : (
        <span>
          <Chip variant="warn">Aucun GPU configuré</Chip>{" "}
          Le fine-tuning LoRA/QLoRA sur LLM nécessite un worker GPU (TRAINING_WORKER_URL) — sans lui ces tâches
          restent <strong className="text-[var(--g3-text-secondary)]">en file d&apos;attente</strong>, jamais simulées.
          Le moteur Gen3 natif, lui, entraîne vos modèles dès maintenant.
        </span>
      )}
      {catalog.providers.some((p) => p.simulated) ? <Chip variant="warn">Simulation active (tests)</Chip> : null}
    </div>
  );
}

/* ================================================================== */
/* Étape 1 — Projet (mode + informations)                               */
/* ================================================================== */

function ProjectStep({ overview, onChanged }: { overview: ProjectOverview; onChanged: () => void }) {
  const project = overview.project;
  const [mode, setMode] = useState(project.mode);
  const [busy, setBusy] = useState(false);

  const changeMode = async (next: "auto" | "assisted" | "advanced") => {
    setMode(next);
    setBusy(true);
    try {
      await authFetch(`/api/training/projects/${project.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: next }),
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const counts = {
    modèles: overview.models.length,
    datasets: overview.datasets.length,
    plans: overview.plans.length,
    tâches: overview.jobs.length,
  };

  return (
    <section className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="ts-card p-5">
          <h3 className="font-serif text-base font-semibold text-[var(--g3-text)]">Informations du projet</h3>
          <dl className="mt-4 space-y-2.5 text-sm">
            <Row label="Famille" value={FAMILY_LABELS[project.family] ?? project.family} />
            <Row label="Objectif" value={project.objective || "Non précisé"} />
            <Row label="Langue principale" value={project.primaryLanguage.toUpperCase()} />
            <Row label="Types de données" value={project.dataTypes.length > 0 ? project.dataTypes.join(", ") : "Non précisé"} />
            <Row label="Créé le" value={new Date(project.createdAt).toLocaleString("fr-FR")} />
          </dl>
        </div>
        <div className="ts-card p-5">
          <h3 className="font-serif text-base font-semibold text-[var(--g3-text)]">Mode de fonctionnement</h3>
          <p className="mt-1.5 text-xs leading-5 text-[var(--g3-muted)]">
            Les trois modes utilisent les mêmes services et les mêmes garde-fous — seule la profondeur des réglages change.
          </p>
          <div className="mt-4 space-y-2">
            {(
              [
                { id: "auto", title: "Automatique", hint: "L'assistant prépare tout : idéal pour débuter" },
                { id: "assisted", title: "Assisté", hint: "Guidage étape par étape, vous décidez" },
                { id: "advanced", title: "Avancé", hint: "Accès aux hyperparamètres et configurations" },
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={busy}
                onClick={() => void changeMode(option.id)}
                aria-pressed={mode === option.id}
                className={`w-full rounded-2xl px-4 py-3 text-left transition ${
                  mode === option.id
                    ? "bg-[var(--g3-primary-soft)] text-[var(--g3-text)]"
                    : "bg-[var(--g3-elevated)] text-[var(--g3-muted)] hover:bg-[var(--g3-hover)]"
                }`}
              >
                <span className="block text-sm font-semibold">{option.title}</span>
                <span className="block text-xs text-[var(--g3-faint)]">{option.hint}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="ts-card flex flex-wrap gap-6 p-5 text-sm">
        {Object.entries(counts).map(([label, value]) => (
          <div key={label}>
            <div className="text-2xl font-bold text-[var(--g3-text)]">{value}</div>
            <div className="text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">{label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">{label}</dt>
      <dd className="text-right text-[var(--g3-text-secondary)]">{value}</dd>
    </div>
  );
}

/* ================================================================== */
/* Étape 2 — Modèle (upload validé + catalogue)                         */
/* ================================================================== */

function ModelStep({
  overview,
  catalog,
  mode,
  onChanged,
  onError,
}: {
  overview: ProjectOverview;
  catalog: CatalogPayload | null;
  mode: string;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const projectId = overview.project.id;
  const [uploading, setUploading] = useState(false);

  const uploadModel = async (file: File) => {
    setUploading(true);
    onError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("name", file.name);
      const response = await authFetch(`/api/training/projects/${projectId}/models`, { method: "POST", body: form });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string; findings?: Array<{ message: string }> };
        const details = data.findings?.map((f) => f.message).join(" ") ?? "";
        onError(data.error ?? "Import impossible." + (details ? ` ${details}` : ""));
      }
      onChanged();
    } finally {
      setUploading(false);
    }
  };

  const addCatalogModel = async (catalogId: string, name: string) => {
    onError("");
    const response = await authFetch(`/api/training/projects/${projectId}/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ catalogId, name }),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      onError(data.error ?? "Référence catalogue impossible.");
      return;
    }
    onChanged();
  };

  const deleteModel = async (assetId: string) => {
    await authFetch(`/api/training/projects/${projectId}/models/${assetId}`, { method: "DELETE" });
    onChanged();
  };

  const uploadLimit = catalog?.quotas.maxUploadMb ?? 200;

  return (
    <section className="space-y-5">
      <div className="ts-card p-5">
        <h3 className="font-serif text-base font-semibold text-[var(--g3-text)]">Importer un modèle</h3>
        <p className="mt-1.5 text-xs leading-5 text-[var(--g3-muted)]">
          Formats acceptés : <strong>.safetensors</strong>, <strong>.gguf</strong>, <strong>.zip</strong> (archive de dossier de
          modèle, jusqu&apos;à {uploadLimit} Mo). Les formats pickle (.pt, .pth, .ckpt) sont refusés : ils peuvent exécuter du code.
          Chaque fichier est <strong>validé octet par octet</strong> avant stockage.
        </p>
        <label className="ts-dropzone mt-4 block">
          <input
            type="file"
            className="sr-only"
            accept=".safetensors,.gguf,.zip,.bin"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadModel(file);
              event.target.value = "";
            }}
          />
          <span className="block text-sm font-medium text-[var(--g3-text-secondary)]">
            {uploading ? "Validation et téléversement en cours…" : "Glissez ou sélectionnez un fichier de modèle"}
          </span>
          <span className="mt-1 block text-xs text-[var(--g3-faint)]">
            .safetensors (recommandé) · .gguf · .zip — {uploadLimit} Mo max
          </span>
        </label>
      </div>

      {overview.models.length > 0 ? (
        <div className="space-y-3">
          {overview.models.map((model) => (
            <div key={model.id} className="ts-card p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium text-[var(--g3-text)]">{model.name}</span>
                    <StatusChip status={model.status} />
                    {model.source === "catalog" ? <Chip variant="primary">Catalogue</Chip> : null}
                  </div>
                  <div className="mt-1 text-xs text-[var(--g3-faint)]">
                    {model.source === "catalog"
                      ? `Référence : ${model.catalogId ?? "—"}`
                      : `${model.format ?? "inconnu"} · ${formatBytes(model.sizeBytes)}${model.sha256 ? ` · empreinte ${model.sha256.slice(0, 12)}…` : ""}`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void deleteModel(model.id)}
                  className="rounded-xl px-3 py-1.5 text-xs text-[var(--g3-danger-strong)] transition hover:bg-[var(--g3-danger-soft)]"
                >
                  Supprimer
                </button>
              </div>
              {model.findings.length > 0 ? (
                <div className="mt-3 border-t border-[var(--g3-border)] pt-3">
                  <FindingsList findings={model.findings} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="ts-card">
          <EmptyState
            icon="⌬"
            title="Aucun modèle importé"
            description="Téléversez vos poids ou choisissez un modèle de base du catalogue ci-dessous."
          />
        </div>
      )}

      {catalog ? (
        <div className="ts-card p-5">
          <h3 className="font-serif text-base font-semibold text-[var(--g3-text)]">Catalogue de modèles de base</h3>
          <p className="mt-1.5 text-xs leading-5 text-[var(--g3-muted)]">
            Références publiques (Hugging Face) : aucun poids n&apos;est téléchargé ici — le worker GPU les récupère depuis le
            dépôt officiel au moment de l&apos;entraînement.
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {catalog.baseModels.map((entry) => {
              const already = overview.models.some((m) => m.catalogId === entry.id);
              return (
                <div key={entry.id} className="ts-card-elevated flex flex-col gap-2 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-[var(--g3-text)]">{entry.name}</div>
                      <div className="text-xs text-[var(--g3-faint)]">{entry.id}</div>
                    </div>
                    <Chip variant="neutral">{entry.params}</Chip>
                  </div>
                  <p className="text-xs leading-5 text-[var(--g3-muted)]">{entry.notes}</p>
                  <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                    <span className="text-xs text-[var(--g3-faint)]">VRAM min : {entry.minVramGb} Go</span>
                    <button
                      type="button"
                      disabled={already}
                      onClick={() => void addCatalogModel(entry.id, entry.name)}
                      className="rounded-xl bg-[var(--g3-primary-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--g3-primary-strong)] transition hover:bg-[var(--g3-primary)] hover:text-[var(--g3-on-primary)] disabled:opacity-40"
                    >
                      {already ? "Référencé" : "Référencer"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {mode === "auto" ? (
            <p className="mt-4 text-xs text-[var(--g3-faint)]">
              Mode automatique : l&apos;assistant choisira le modèle de base le mieux adapté à votre objectif lors de l&apos;analyse.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/* ================================================================== */
/* Étape 3 — Données (datasets analysés + splits)                       */
/* ================================================================== */

function DataStep({
  overview,
  mode,
  onChanged,
  onError,
}: {
  overview: ProjectOverview;
  mode: string;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const projectId = overview.project.id;
  const [split, setSplit] = useState("train");
  const [uploading, setUploading] = useState(false);
  const [tab, setTab] = useState<"upload" | "huggingface" | "kaggle">("upload");

  const uploadDataset = async (file: File, chosenSplit: string) => {
    setUploading(true);
    onError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("split", chosenSplit);
      const response = await authFetch(`/api/training/projects/${projectId}/datasets`, { method: "POST", body: form });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string; findings?: Array<{ message: string }> };
        const details = data.findings?.map((f) => f.message).join(" ") ?? "";
        onError(data.error ?? "Import impossible." + (details ? ` ${details}` : ""));
      }
      onChanged();
    } finally {
      setUploading(false);
    }
  };

  const changeSplit = async (assetId: string, nextSplit: string) => {
    await authFetch(`/api/training/projects/${projectId}/datasets/${assetId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ split: nextSplit }),
    });
    onChanged();
  };

  const deleteDataset = async (assetId: string) => {
    await authFetch(`/api/training/projects/${projectId}/datasets/${assetId}`, { method: "DELETE" });
    onChanged();
  };

  const splitTotals = useMemo(() => {
    const totals = { train: 0, validation: 0, test: 0, unassigned: 0 };
    for (const dataset of overview.datasets) {
      totals[dataset.split as keyof typeof totals] += dataset.stats.rows;
    }
    return totals;
  }, [overview.datasets]);

  return (
    <section className="space-y-5">
      <div className="ts-card p-5">
        <h3 className="font-serif text-base font-semibold text-[var(--g3-text)]">Importer des données</h3>
        <p className="mt-1.5 text-xs leading-5 text-[var(--g3-muted)]">
          Formats analysés : <strong>.csv</strong>, <strong>.json</strong>, <strong>.jsonl</strong> (paires
          instruction/réponse recommandées), <strong>.txt</strong>. Le contenu est réellement parsé : statistiques, doublons,
          détection de données personnelles (avertissement RGPD).
        </p>

        {/* v1.1 — trois sources : téléversement, Hugging Face, Kaggle */}
        <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Source des données">
          {([
            { key: "upload", label: "Téléverser un fichier" },
            { key: "huggingface", label: "Hugging Face" },
            { key: "kaggle", label: "Kaggle" },
          ] as const).map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={tab === entry.key}
              onClick={() => setTab(entry.key)}
              className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                tab === entry.key
                  ? "bg-[var(--g3-primary-soft)] text-[var(--g3-primary-strong)]"
                  : "text-[var(--g3-muted)] hover:bg-[var(--g3-hover)]"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {tab === "upload" ? (
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <label className="ts-dropzone flex-1">
              <input
                type="file"
                className="sr-only"
                accept=".csv,.json,.jsonl,.txt"
                disabled={uploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadDataset(file, split);
                  event.target.value = "";
                }}
              />
              <span className="block text-sm font-medium text-[var(--g3-text-secondary)]">
                {uploading ? "Analyse du contenu en cours…" : "Glissez ou sélectionnez un dataset"}
              </span>
              <span className="mt-1 block text-xs text-[var(--g3-faint)]">Le fichier sera analysé avant stockage</span>
            </label>
            <div>
              <label htmlFor="dataset-split" className="mb-1 block text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">
                Split d&apos;affectation
              </label>
              <select
                id="dataset-split"
                value={split}
                onChange={(event) => setSplit(event.target.value)}
                className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-2 text-sm text-[var(--g3-text)]"
              >
                <option value="train">Entraînement (train)</option>
                <option value="validation">Validation</option>
                <option value="test">Test</option>
                <option value="unassigned">Non assigné</option>
              </select>
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <HubImportPanel projectId={projectId} onChanged={onChanged} onError={onError} />
          </div>
        )}
      </div>

      {overview.datasets.length > 0 ? (
        <>
          <div className="ts-card grid grid-cols-2 gap-4 p-5 md:grid-cols-4">
            {(["train", "validation", "test", "unassigned"] as const).map((key) => (
              <div key={key}>
                <div className="text-xl font-bold text-[var(--g3-text)]">{splitTotals[key].toLocaleString("fr-FR")}</div>
                <div className="text-xs text-[var(--g3-faint)]">
                  {key === "train" ? "lignes · train" : key === "validation" ? "lignes · validation" : key === "test" ? "lignes · test" : "lignes · non assignées"}
                </div>
              </div>
            ))}
          </div>
          {mode !== "auto" ? (
            <p className="text-xs leading-5 text-[var(--g3-muted)]">
              Séparez entraînement, validation et test pour éviter les fuites : un dataset ne doit jamais apparaître dans deux
              splits à la fois. Un split de validation est indispensable pour mesurer le surapprentissage.
            </p>
          ) : null}
          <div className="space-y-3">
            {overview.datasets.map((dataset) => (
              <DatasetCard
                key={dataset.id}
                dataset={dataset}
                onSplit={(next) => void changeSplit(dataset.id, next)}
                onDelete={() => void deleteDataset(dataset.id)}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="ts-card">
          <EmptyState
            icon="▤"
            title="Aucune donnée importée"
            description="Un fine-tuning crédible exige généralement plusieurs centaines de paires entrée → sortie. En dessous de 50 exemples, l'assistant recommandera plutôt un RAG."
          />
        </div>
      )}
    </section>
  );
}

function DatasetCard({
  dataset,
  onSplit,
  onDelete,
}: {
  dataset: DatasetAsset;
  onSplit: (next: string) => void;
  onDelete: () => void;
}) {
  return (
    <div className="ts-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-[var(--g3-text)]">{dataset.name}</span>
            {dataset.source && dataset.source !== "upload" ? (
              <Chip variant="primary">
                {dataset.source === "huggingface" ? "Hugging Face" : "Kaggle"}
              </Chip>
            ) : null}
            <Chip variant={dataset.split === "unassigned" ? "warn" : "primary"}>
              {dataset.split === "unassigned" ? "Non assigné" : dataset.split}
            </Chip>
            <StatusChip status={dataset.status} />
          </div>
          <div className="mt-1 text-xs text-[var(--g3-faint)]">
            {dataset.format.toUpperCase()} · {formatBytes(dataset.sizeBytes)} ·{" "}
            {dataset.stats.rows.toLocaleString("fr-FR")} lignes
            {dataset.stats.pairs > 0 ? ` · ${dataset.stats.pairs} paire(s) détectée(s)` : ""}
            {dataset.stats.duplicates > 0 ? ` · ${dataset.stats.duplicates} doublon(s)` : ""}
            {dataset.originMetadata?.totalRows
              ? ` · ${dataset.originMetadata.totalRows.toLocaleString("fr-FR")} lignes déclarées par le hub`
              : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={dataset.split}
            onChange={(event) => onSplit(event.target.value)}
            aria-label={`Split du dataset ${dataset.name}`}
            className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-1.5 text-xs text-[var(--g3-text)]"
          >
            <option value="train">train</option>
            <option value="validation">validation</option>
            <option value="test">test</option>
            <option value="unassigned">non assigné</option>
          </select>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-xl px-3 py-1.5 text-xs text-[var(--g3-danger-strong)] transition hover:bg-[var(--g3-danger-soft)]"
          >
            Supprimer
          </button>
        </div>
      </div>
      {dataset.stats.warnings.length > 0 || dataset.findings.length > 0 ? (
        <div className="mt-3 space-y-2 border-t border-[var(--g3-border)] pt-3">
          {dataset.stats.warnings.map((warning) => (
            <p key={warning} className="flex items-start gap-2 text-xs leading-5 text-[var(--g3-warning-strong)]">
              <span aria-hidden="true">!</span>
              <span>{warning}</span>
            </p>
          ))}
          <FindingsList findings={dataset.findings} />
        </div>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* Étape 4 — Analyse IA et plan d'entraînement                          */
/* ================================================================== */

function AnalysisStep({
  overview,
  mode,
  plan,
  onChanged,
  onError,
}: {
  overview: ProjectOverview;
  mode: string;
  plan: TrainingPlan | null;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [analyzing, setAnalyzing] = useState(false);
  const [explanation, setExplanation] = useState("");
  const [editedParams, setEditedParams] = useState<Record<string, number | string | boolean | null>>({});

  const runAnalysis = async () => {
    setAnalyzing(true);
    onError("");
    try {
      const response = await authFetch(`/api/training/projects/${overview.project.id}/analysis`, { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        explanation?: string;
      };
      if (!response.ok) {
        onError(data.error ?? "Analyse impossible.");
        return;
      }
      setExplanation(data.explanation ?? "");
      onChanged();
    } finally {
      setAnalyzing(false);
    }
  };

  const acceptPlan = async () => {
    if (!plan) return;
    onError("");
    const response = await authFetch(`/api/training/plans/${plan.id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: overview.project.id }),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      onError(data.error ?? "Acceptation impossible.");
      return;
    }
    onChanged();
  };

  const rejectPlan = async () => {
    if (!plan) return;
    onError("");
    const response = await authFetch(`/api/training/projects/${overview.project.id}/plans`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId: plan.id, status: "rejected" }),
    }).catch(() => null);
    if (response && !response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      onError(data.error ?? "Refus impossible.");
      return;
    }
    onChanged();
  };

  return (
    <section className="space-y-5">
      <div className="ts-card p-5">
        <h3 className="font-serif text-base font-semibold text-[var(--g3-text)]">Analyse de l&apos;assistant IA</h3>
        <p className="mt-1.5 text-xs leading-5 text-[var(--g3-muted)]">
          L&apos;assistant examine vos modèles importés, vos datasets (statistiques réelles), la cohérence des splits et les
          capacités des moteurs disponibles, puis propose un plan d&apos;entraînement : méthode, hyperparamètres, ressources
          estimées, risques et critères d&apos;évaluation. Les estimations sont affichées comme telles — jamais comme des mesures.
        </p>
        <button
          type="button"
          onClick={() => void runAnalysis()}
          disabled={analyzing}
          className="mt-4 rounded-2xl bg-[var(--g3-gradient)] px-5 py-2.5 text-sm font-semibold text-[var(--g3-on-primary)] transition hover:opacity-90 disabled:opacity-50"
        >
          {analyzing ? "Analyse en cours…" : overview.plans.length > 0 ? "Relancer l'analyse" : "Lancer l'analyse"}
        </button>
        {explanation ? (
          <p className="mt-4 rounded-2xl bg-[var(--g3-elevated)] p-4 text-sm leading-6 text-[var(--g3-text-secondary)]">
            {explanation}
          </p>
        ) : null}
      </div>

      {plan ? (
        <div className="ts-plan space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-serif text-base font-semibold text-[var(--g3-text)]">Plan proposé</h3>
              <StatusChip status={plan.status} />
              <Chip variant={plan.generatedBy === "assistant-llm" ? "primary" : "warn"}>
                {plan.generatedBy === "assistant-llm" ? "Analyse IA" : "Repli heuristique (IA indisponible)"}
              </Chip>
            </div>
            {plan.status === "proposed" ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void acceptPlan()}
                  className="rounded-xl bg-[var(--g3-gradient)] px-4 py-2 text-sm font-semibold text-[var(--g3-on-primary)] transition hover:opacity-90"
                >
                  Accepter et préparer la tâche
                </button>
                <button
                  type="button"
                  onClick={() => void rejectPlan()}
                  className="rounded-xl border border-[var(--g3-border)] px-4 py-2 text-sm text-[var(--g3-muted)] transition hover:text-[var(--g3-text)]"
                >
                  Refuser
                </button>
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <div className="text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">Méthode</div>
              <div className="mt-1 text-sm font-semibold text-[var(--g3-text)]">{METHOD_LABELS[plan.method] ?? plan.method}</div>
              <div className="mt-0.5 text-xs text-[var(--g3-faint)]">Moteur : {plan.engineId}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">Modèle de base</div>
              <div className="mt-1 truncate text-sm font-semibold text-[var(--g3-text)]">{plan.baseModel}</div>
              <div className="mt-0.5 text-xs text-[var(--g3-faint)]">
                {plan.baseModelKind === "catalog" ? "Référence catalogue" : "Poids importés"}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">Ressources estimées</div>
              <div className="mt-1 text-sm text-[var(--g3-text-secondary)]">
                VRAM : {plan.resources.vramGbEstimate ? `~${plan.resources.vramGbEstimate} Go` : "—"} · Durée :{" "}
                {formatDuration(plan.resources.estimatedDurationMinutes)}
              </div>
              <div className="mt-0.5 text-xs text-[var(--g3-faint)]">Estimations prudentes, pas des mesures</div>
            </div>
          </div>

          {(mode === "advanced" || mode === "assisted") && Object.keys(plan.parameters).length > 0 ? (
            <div>
              <div className="text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">Hyperparamètres</div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {Object.entries(plan.parameters).map(([key, value]) => (
                  <div key={key} className="rounded-xl bg-[var(--g3-deep)] px-3 py-2">
                    <div className="text-[0.65rem] uppercase tracking-wide text-[var(--g3-faint)]">{key}</div>
                    {mode === "advanced" && plan.status === "proposed" ? (
                      <input
                        type="number"
                        value={editedParams[key] !== undefined ? String(editedParams[key]) : String(value ?? "")}
                        onChange={(event) =>
                          setEditedParams((prev) => ({ ...prev, [key]: Number(event.target.value) }))
                        }
                        className="mt-0.5 w-full bg-transparent text-sm font-semibold text-[var(--g3-text)] outline-none"
                        aria-label={`Paramètre ${key}`}
                      />
                    ) : (
                      <div className="mt-0.5 text-sm font-semibold text-[var(--g3-text)]">{String(value ?? "—")}</div>
                    )}
                  </div>
                ))}
              </div>
              {mode === "advanced" && plan.status === "proposed" && Object.keys(editedParams).length > 0 ? (
                <button
                  type="button"
                  onClick={() => void applyParamEdits(overview.project.id, plan.id, editedParams, onError, onChanged)}
                  className="mt-3 rounded-xl bg-[var(--g3-primary-soft)] px-4 py-2 text-xs font-semibold text-[var(--g3-primary-strong)] transition hover:bg-[var(--g3-primary)] hover:text-[var(--g3-on-primary)]"
                >
                  Enregistrer les paramètres modifiés
                </button>
              ) : null}
            </div>
          ) : null}

          {plan.risks.length > 0 ? (
            <div>
              <div className="text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">Risques identifiés</div>
              <ul className="mt-1.5 space-y-1 text-xs leading-5 text-[var(--g3-warning-strong)]">
                {plan.risks.map((risk) => (
                  <li key={risk}>· {risk}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {plan.warnings.length > 0 ? (
            <div>
              <div className="text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">Avertissements</div>
              <ul className="mt-1.5 space-y-1 text-xs leading-5 text-[var(--g3-muted)]">
                {plan.warnings.map((warning) => (
                  <li key={warning}>· {warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <div className="text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">Critères d&apos;évaluation prévus</div>
            <ul className="mt-1.5 space-y-1 text-xs leading-5 text-[var(--g3-muted)]">
              {plan.evaluationCriteria.map((criterion) => (
                <li key={criterion}>· {criterion}</li>
              ))}
            </ul>
          </div>
          <p className="text-xs leading-5 text-[var(--g3-muted)]">
            <strong className="text-[var(--g3-text-secondary)]">Résultats attendus :</strong> {plan.expectedOutcomes || "—"}
          </p>
        </div>
      ) : (
        <div className="ts-card">
          <EmptyState
            icon="✧"
            title="Aucun plan pour l'instant"
            description="Lancez l'analyse : l'assistant étudie vos données et propose la méthode adaptée (fine-tuning LoRA, QLoRA, RAG…)."
          />
        </div>
      )}
    </section>
  );
}

async function applyParamEdits(
  projectId: string,
  planId: string,
  parameters: Record<string, number | string | boolean | null>,
  onError: (message: string) => void,
  onChanged: () => void,
) {
  const response = await authFetch(`/api/training/projects/${projectId}/plans`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ planId, parameters }),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    onError(data.error ?? "Enregistrement des paramètres impossible.");
    return;
  }
  onChanged();
}

/* ================================================================== */
/* Étape 5 — Entraînement (tâches, progression réelle, journal)        */
/* ================================================================== */

function TrainingStep({
  overview,
  job,
  onChanged,
  onError,
}: {
  overview: ProjectOverview;
  job: TrainingJob | null;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const cancel = async (jobId: string) => {
    onError("");
    const response = await authFetch(`/api/training/jobs/${jobId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: overview.project.id }),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      onError(data.error ?? "Annulation impossible.");
      return;
    }
    onChanged();
  };

  if (overview.jobs.length === 0) {
    return (
      <div className="ts-card">
        <EmptyState
          icon="⌬"
          title="Aucune tâche d'entraînement"
          description="Acceptez un plan proposé par l'assistant (étape Analyse) pour créer votre première tâche."
        />
      </div>
    );
  }

  return (
    <section className="space-y-4">
      {overview.jobs.map((entry) => (
        <div key={entry.id} className="ts-card space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-serif text-sm font-semibold text-[var(--g3-text)]">Tâche {entry.id.slice(0, 10)}</span>
              <StatusChip status={entry.status} />
              {entry.simulated ? <Chip variant="warn">SIMULATION</Chip> : null}
              {entry.waitingReason === "no-gpu-provider" ? <Chip variant="warn">En attente de GPU</Chip> : null}
            </div>
            {entry.status === "queued" || entry.status === "running" ? (
              <button
                type="button"
                onClick={() => void cancel(entry.id)}
                className="rounded-xl border border-[var(--g3-danger-border)] px-3 py-1.5 text-xs text-[var(--g3-danger-strong)] transition hover:bg-[var(--g3-danger-soft)]"
              >
                Annuler
              </button>
            ) : null}
          </div>

          {entry.simulated ? (
            <p className="ts-simulated-banner px-4 py-3 text-xs leading-5 text-[var(--g3-warning-strong)]">
              Cette tâche s&apos;exécute sur un fournisseur de <strong>simulation</strong> (tests uniquement) : la progression
              affichée est fictive et aucun poids n&apos;est produit. En production, ce badge ne doit jamais apparaître.
            </p>
          ) : null}

          {entry.status === "running" || entry.progressPercent !== null ? (
            <div className="space-y-2">
              <ProgressBar percent={entry.progressPercent} />
              <div className="flex flex-wrap justify-between gap-2 text-xs text-[var(--g3-muted)]">
                <span>
                  {entry.currentStep ?? "En exécution"} ·{" "}
                  {entry.epochsDone !== null && entry.epochsTotal !== null
                    ? `époque ${entry.epochsDone}/${entry.epochsTotal}`
                    : "—"}
                </span>
                <span>
                  {entry.progressPercent !== null ? `${entry.progressPercent} %` : "Progression rapportée par le fournisseur"}
                </span>
              </div>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Perte (train)" value={entry.trainLoss !== null && entry.trainLoss !== undefined ? entry.trainLoss.toFixed(4) : "—"} />
            <Metric label="Début" value={entry.startedAt ? new Date(entry.startedAt).toLocaleString("fr-FR") : "—"} />
            <Metric label="Fin" value={entry.finishedAt ? new Date(entry.finishedAt).toLocaleString("fr-FR") : "—"} />
          </div>

          {entry.error ? <ErrorBanner message={entry.error} /> : null}
          {entry.waitingReason === "no-gpu-provider" ? (
            <p className="rounded-2xl bg-[var(--g3-elevated)] px-4 py-3 text-xs leading-5 text-[var(--g3-muted)]">
              Aucun fournisseur compatible n&apos;est actuellement disponible pour ce moteur : la tâche reste en file
              d&apos;attente (aucune simulation). Astuce : le moteur Gen3 natif entraîne vos modèles sans GPU —
              relancez le plan avec ce moteur pour une exécution immédiate.
            </p>
          ) : null}

          <div>
            <div className="mb-2 text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">Journal</div>
            <LogViewer events={entry.events} />
          </div>
        </div>
      ))}
      {job && job.status === "running" ? (
        <p className="text-xs text-[var(--g3-faint)]">Rafraîchissement automatique toutes les 5 secondes pendant l&apos;exécution.</p>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-[var(--g3-elevated)] px-4 py-3">
      <div className="text-[0.65rem] uppercase tracking-[.14em] text-[var(--g3-faint)]">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-[var(--g3-text)]">{value}</div>
    </div>
  );
}

/* ================================================================== */
/* Étape 6 — Évaluation                                                */
/* ================================================================== */

function EvaluationStep({ job }: { job: TrainingJob | null }) {
  if (!job) {
    return (
      <div className="ts-card">
        <EmptyState
          icon="✓"
          title="Évaluation après entraînement"
          description="Cette étape se remplit automatiquement à la fin d'une tâche réelle : métriques rapportées par le moteur, artefacts produits et checklist de vérification."
        />
      </div>
    );
  }

  const checks = [
    {
      label: "Tâche terminée avec succès",
      done: job.status === "completed",
      detail: job.status === "completed" ? "Statut confirmé par le fournisseur GPU." : "La tâche n'est pas terminée.",
    },
    {
      label: "Artefacts produits",
      done: job.artifacts.length > 0,
      detail:
        job.artifacts.length > 0
          ? job.artifacts.map((a) => a.label || a.storageKey).join(", ")
          : "Aucun artefact déclaré par le fournisseur (une évaluation seule n'en produit pas).",
    },
    {
      label: "Perte d'entraînement rapportée",
      done: job.trainLoss !== null && job.trainLoss !== undefined,
      detail: job.trainLoss !== null && job.trainLoss !== undefined ? job.trainLoss.toFixed(4) : "Non rapportée par le moteur.",
    },
    {
      label: "Artefacts de la tâche vérifiables à l'export",
      done: true,
      detail: "Les fichiers réellement produits sont listés à l'étape Export — jamais de fichier inventé.",
    },
  ];

  return (
    <section className="space-y-4">
      <div className="ts-card p-5">
        <h3 className="font-serif text-base font-semibold text-[var(--g3-text)]">Rapport d&apos;évaluation</h3>
        <p className="mt-1.5 text-xs leading-5 text-[var(--g3-muted)]">
          Chaque élément provient du fournisseur d&apos;entraînement ou du stockage vérifié. Les limites connues sont affichées
          telles quelles : l&apos;absence d&apos;une métrique signifie que le moteur ne l&apos;a pas rapportée.
        </p>
        <ul className="mt-4 space-y-3">
          {checks.map((check) => (
            <li key={check.label} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[0.7rem] ${
                  check.done ? "bg-[var(--g3-secondary-soft)] text-[var(--g3-info)]" : "bg-[var(--g3-elevated)] text-[var(--g3-faint)]"
                }`}
              >
                {check.done ? "✓" : "—"}
              </span>
              <div>
                <div className="text-sm font-medium text-[var(--g3-text-secondary)]">{check.label}</div>
                <div className="text-xs text-[var(--g3-faint)]">{check.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="ts-card p-5">
        <div className="text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">Métriques rapportées</div>
        {Object.keys(job.metrics).length > 0 ? (
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            {Object.entries(job.metrics).map(([key, value]) => (
              <Metric key={key} label={key} value={String(value)} />
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-[var(--g3-muted)]">
            Aucune métrique supplémentaire rapportée par le moteur ({Object.keys(job.metrics).length} entrées). Les métriques de
            validation nécessitent un split de validation dans vos datasets.
          </p>
        )}
      </div>
    </section>
  );
}

/* ================================================================== */
/* Étape 7 — Export                                                     */
/* ================================================================== */

function ExportStep({
  overview,
  onChanged,
  onError,
}: {
  overview: ProjectOverview;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [preparing, setPreparing] = useState<string | null>(null);

  const prepare = async (kind: "dataset-archive" | "model-files" | "plan-config" | "trained-model") => {
    setPreparing(kind);
    onError("");
    try {
      const response = await authFetch("/api/training/exports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: overview.project.id, kind }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        onError(data.error ?? "Préparation impossible.");
        return;
      }
      onChanged();
    } finally {
      setPreparing(null);
    }
  };

  const download = async (artifact: ExportArtifact) => {
    const response = await authFetch(`/api/training/exports/${artifact.id}?projectId=${overview.project.id}`);
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      onError(data.error ?? "Lien indisponible.");
      return;
    }
    const data = (await response.json()) as { url: string };
    window.open(data.url, "_blank", "noopener");
  };

  const kinds: Array<{ id: "dataset-archive" | "model-files" | "plan-config" | "trained-model"; label: string; hint: string }> = [
    { id: "dataset-archive", label: "Archive des datasets", hint: "ZIP de tous vos datasets validés, préfixés par split" },
    { id: "model-files", label: "Fichiers modèle importés", hint: "ZIP de vos poids téléversés, tels qu'importés" },
    { id: "trained-model", label: "Modèles entraînés par Gen", hint: "ZIP des cerveaux Gen3 produits par vos tâches complétées (moteur gen3-native)" },
    { id: "plan-config", label: "Configuration du plan", hint: "JSON reproductible du plan accepté" },
  ];

  return (
    <section className="space-y-5">
      <div className="ts-card p-5">
        <h3 className="font-serif text-base font-semibold text-[var(--g3-text)]">Préparer un export</h3>
        <p className="mt-1.5 text-xs leading-5 text-[var(--g3-muted)]">
          Chaque export génère une archive ZIP avec un lien de téléchargement signé et temporaire (30 minutes par défaut). Seul
          le propriétaire du projet peut préparer un export. Les poids issus d&apos;un entraînement n&apos;apparaissent ici
          qu&apos;après une tâche réellement terminée.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {kinds.map((kind) => (
            <button
              key={kind.id}
              type="button"
              disabled={preparing !== null}
              onClick={() => void prepare(kind.id)}
              className="ts-card-elevated p-4 text-left transition hover:border-[var(--g3-primary-border)] disabled:opacity-50"
            >
              <div className="text-sm font-semibold text-[var(--g3-text)]">{kind.label}</div>
              <div className="mt-1 text-xs leading-5 text-[var(--g3-muted)]">{kind.hint}</div>
              <div className="mt-2 text-xs text-[var(--g3-primary-strong)]">
                {preparing === kind.id ? "Préparation…" : "Préparer →"}
              </div>
            </button>
          ))}
        </div>
      </div>

      {overview.exports.length > 0 ? (
        <div className="space-y-3">
          {overview.exports.map((artifact) => {
            const expired = new Date(artifact.expiresAt).getTime() < Date.now();
            return (
              <div key={artifact.id} className="ts-card flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--g3-text)]">{artifact.label || artifact.kind}</span>
                    <Chip variant={expired ? "warn" : "valid"}>{expired ? "Expiré" : "Disponible"}</Chip>
                  </div>
                  <div className="mt-0.5 text-xs text-[var(--g3-faint)]">
                    {formatBytes(artifact.sizeBytes)} · ZIP · expire le {new Date(artifact.expiresAt).toLocaleString("fr-FR")}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={expired}
                  onClick={() => void download(artifact)}
                  className="rounded-xl bg-[var(--g3-primary-soft)] px-4 py-2 text-xs font-semibold text-[var(--g3-primary-strong)] transition hover:bg-[var(--g3-primary)] hover:text-[var(--g3-on-primary)] disabled:opacity-40"
                >
                  {expired ? "Lien expiré" : "Obtenir le lien signé"}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="ts-card">
          <EmptyState icon="↧" title="Aucun export préparé" description="Préparez votre première archive ci-dessus." />
        </div>
      )}
    </section>
  );
}
