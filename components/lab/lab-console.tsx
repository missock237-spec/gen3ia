"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { authFetch, readJsonSafely, useSessionAvailable } from "@/lib/firebase/auth-client";
import { SectionHeader } from "@/components/shells/section-header";
import { EmptyState, LoadingState, MetricCard } from "@/components/shells/states";

/**
 * Laboratoire de modèles — console client.
 *
 * Restauration CRITIQUE (diagnostic restructuration des parcours) : les API
 * /api/training existaient mais aucune interface dédiée n'était présentée.
 * Cette console branche le parcours réel décrit par le domaine
 * lib/training : projets → datasets → analyse (plan proposé) → acceptation
 * (job) → suivi de progression honnête → modèles + exports.
 *
 * Contrat d'honnêteté (repris du domaine) : la progression et les métriques
 * affichées proviennent du fournisseur ; un job simulé est étiqueté
 * « simulation » ; une estimation est distinguée d'une mesure.
 */

type TabId = "entrainement" | "evaluation" | "modeles";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "entrainement", label: "Entraînement" },
  { id: "evaluation", label: "Évaluation" },
  { id: "modeles", label: "Modèles & exports" },
];

const FAMILIES = [
  { value: "text", label: "Texte" },
  { value: "image", label: "Image" },
  { value: "audio", label: "Audio" },
  { value: "video", label: "Vidéo" },
  { value: "multimodal", label: "Multimodal" },
  { value: "specialized", label: "Spécialisé" },
] as const;

const JOB_STATUS_LABEL: Record<string, string> = {
  queued: "En file",
  scheduled: "Programmé",
  running: "En cours",
  completed: "Terminé",
  failed: "Échoué",
  cancelled: "Annulé",
};

const JOB_STATUS_CLASS: Record<string, string> = {
  queued: "bg-[var(--g3-elevated)] text-[var(--g3-muted)]",
  scheduled: "bg-[var(--g3-info-soft)] text-[var(--g3-info)]",
  running: "bg-[var(--g3-primary-soft)] text-[var(--g3-primary-strong)]",
  completed: "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]",
  failed: "bg-[var(--g3-danger-soft)] text-[var(--g3-danger-strong)]",
  cancelled: "bg-[var(--g3-elevated)] text-[var(--g3-faint)]",
};

interface TrainingProject {
  id: string;
  name: string;
  description: string;
  family: string;
  objective: string;
  mode: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface DatasetAssetLite {
  id: string;
  name: string;
  format: string;
  split: string;
  source: string;
  status: string;
  sizeBytes: number;
}

interface TrainingPlan {
  id: string;
  method: string;
  engineId: string;
  baseModel: string;
  status: "proposed" | "accepted" | "rejected" | "superseded";
  generatedBy: "assistant-llm" | "heuristic-fallback";
  resources: {
    vramGbEstimate?: number | null;
    estimatedDurationMinutes?: number | null;
    providerClass?: string | null;
  };
  risks: string[];
  warnings: string[];
  expectedOutcomes: string;
  evaluationCriteria: string[];
  createdAt: string;
}

interface TrainingJob {
  id: string;
  status: string;
  progressPercent?: number | null;
  currentStep?: string | null;
  epochsTotal?: number | null;
  epochsDone?: number | null;
  trainLoss?: number | null;
  metrics: Record<string, number>;
  waitingReason?: string | null;
  simulated: boolean;
  error?: string | null;
  events?: Array<{ at: string; level: "info" | "warn" | "error"; message: string }>;
  createdAt: string;
  finishedAt?: string | null;
}

interface ModelAssetLite {
  id: string;
  name: string;
  source: "upload" | "catalog";
  status: string;
  sizeBytes: number;
  format?: string | null;
}

interface ExportAssetLite {
  id: string;
  kind: string;
  label: string;
  sizeBytes: number;
  expiresAt: string;
  createdAt: string;
}

interface ProjectOverview {
  project: TrainingProject;
  models: ModelAssetLite[];
  datasets: DatasetAssetLite[];
  plans: TrainingPlan[];
  jobs: TrainingJob[];
  exports: ExportAssetLite[];
}

interface CatalogLite {
  engines: Array<{ id: string; label: string; family: string }>;
  baseModels: Array<{ id: string; label: string }>;
  execution: { nativeAvailable: boolean; gpuAvailable: boolean; simulationDetected: boolean };
  quotas: Record<string, number>;
}

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

const familyLabel = (family: string): string => FAMILIES.find((f) => f.value === family)?.label ?? family;

const methodLabel: Record<string, string> = {
  "full-training": "Entraînement complet",
  finetune: "Fine-tuning",
  lora: "LoRA",
  qlora: "QLoRA",
  adapter: "Adaptateur",
  "eval-only": "Évaluation seule",
  quantize: "Quantification",
  convert: "Conversion",
  rag: "Indexation RAG",
};

const EXPORT_KINDS = [
  { value: "trained-model", label: "Modèle entraîné" },
  { value: "model-files", label: "Fichiers modèle" },
  { value: "dataset-archive", label: "Archive datasets" },
  { value: "plan-config", label: "Configuration du plan" },
] as const;

/** Badge d'état homogène (jobs, modèles, datasets, plans). */
function StatusBadge({ label, className }: { label: string; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${className ?? "bg-[var(--g3-elevated)] text-[var(--g3-muted)]"}`}>
      {label}
    </span>
  );
}

export function LabConsole() {
  const sessionDisponible = useSessionAvailable();

  const [tab, setTab] = useState<TabId>("entrainement");
  const [projects, setProjects] = useState<TrainingProject[]>([]);
  const [catalog, setCatalog] = useState<CatalogLite | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [overviewBusy, setOverviewBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Création de projet
  const [formOpen, setFormOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newFamily, setNewFamily] = useState<string>("text");
  const [newObjective, setNewObjective] = useState("");
  const [creating, setCreating] = useState(false);

  // Onglet pré-sélectionné par le hachage (#evaluation depuis la home).
  useEffect(() => {
    const appliquer = () => {
      const hash = window.location.hash.replace("#", "") as TabId;
      if (TABS.some((t) => t.id === hash)) setTab(hash);
    };
    appliquer();
    window.addEventListener("hashchange", appliquer);
    return () => window.removeEventListener("hashchange", appliquer);
  }, []);

  const chargerProjets = useCallback(async () => {
    setLoadError(null);
    try {
      const [p, c] = await Promise.all([
        authFetch("/api/training/projects", { cache: "no-store" }),
        authFetch("/api/training/catalog", { cache: "no-store" }),
      ]);
      if (p.ok) {
        const data = await readJsonSafely<{ projects?: TrainingProject[] }>(p);
        setProjects(data?.projects ?? []);
      } else if (p.status !== 401) {
        setLoadError("Impossible de charger vos projets d'entraînement.");
      }
      if (c.ok) {
        const data = await readJsonSafely<{ catalog?: CatalogLite }>(c);
        setCatalog(data?.catalog ?? null);
      }
    } catch {
      setLoadError("Connexion au serveur impossible. Vérifiez votre réseau puis réessayez.");
    } finally {
      setLoaded(true);
    }
  }, []);

  const chargerOverview = useCallback(async (projectId: string) => {
    setOverviewBusy(true);
    setActionError(null);
    try {
      const response = await authFetch(`/api/training/projects/${projectId}`, { cache: "no-store" });
      if (response.ok) {
        const data = await readJsonSafely<ProjectOverview>(response);
        setOverview(data);
      } else {
        setOverview(null);
        setActionError(response.status === 401 ? "Session expirée : reconnectez-vous." : "Ce projet est indisponible.");
      }
    } catch {
      setActionError("Connexion au serveur impossible. Réessayez.");
    } finally {
      setOverviewBusy(false);
    }
  }, []);

  useEffect(() => {
    if (sessionDisponible === false) return;
    void chargerProjets();
  }, [sessionDisponible, chargerProjets]);

  useEffect(() => {
    if (selectedId) void chargerOverview(selectedId);
  }, [selectedId, chargerOverview]);

  // Reprise automatique : un projet en file peut être dispatché entre deux
  // consultations — on rafraîchit la vue agrégée tant qu'un job est actif.
  useEffect(() => {
    if (!overview || !selectedId) return;
    const actif = overview.jobs.some((job) => ["queued", "scheduled", "running"].includes(job.status));
    if (!actif) return;
    const timer = setInterval(() => void chargerOverview(selectedId), 12_000);
    return () => clearInterval(timer);
  }, [overview, selectedId, chargerOverview]);

  const creerProjet = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/training/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          family: newFamily,
          objective: newObjective.trim(),
          mode: "assisted",
        }),
      });
      const data = await readJsonSafely<{ project?: TrainingProject; error?: string }>(response);
      if (!response.ok || !data?.project) {
        throw new Error(data?.error ?? `La création a échoué (erreur ${response.status}).`);
      }
      setProjects((prev) => [data.project!, ...prev]);
      setSelectedId(data.project.id);
      setNewName("");
      setNewObjective("");
      setFormOpen(false);
      setNotice(`Projet « ${data.project.name} » créé — joignez un dataset depuis le Centre de données, puis générez une analyse.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "La création du projet a échoué.");
    } finally {
      setCreating(false);
    }
  };

  const genererAnalyse = async () => {
    if (!selectedId) return;
    setOverviewBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch(`/api/training/projects/${selectedId}/analysis`, { method: "POST" });
      const data = await readJsonSafely<{ plan?: TrainingPlan; error?: string }>(response);
      if (!response.ok) throw new Error(data?.error ?? "L'analyse a échoué.");
      await chargerOverview(selectedId);
      setNotice(
        data?.plan?.generatedBy === "heuristic-fallback"
          ? "Plan proposé par les règles déterministes (assistant IA momentanément indisponible) — vérifiez-le avant de l'accepter."
          : "Plan d'entraînement proposé par l'assistant : vérifiez hyperparamètres et risques avant de l'accepter.",
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "L'analyse a échoué.");
    } finally {
      setOverviewBusy(false);
    }
  };

  const accepterPlan = async (planId: string) => {
    if (!selectedId) return;
    setOverviewBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch(`/api/training/plans/${planId}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: selectedId }),
      });
      const data = await readJsonSafely<{ job?: TrainingJob; error?: string }>(response);
      if (!response.ok) throw new Error(data?.error ?? "L'acceptation du plan a échoué.");
      await chargerOverview(selectedId);
      setNotice(
        data?.job
          ? "Tâche d'entraînement créée : elle part en exécution si un fournisseur est disponible, en file d'attente honnête sinon."
          : "Plan accepté.",
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "L'acceptation du plan a échoué.");
    } finally {
      setOverviewBusy(false);
    }
  };

  const annulerJob = async (jobId: string) => {
    if (!selectedId) return;
    setActionError(null);
    try {
      const response = await authFetch(`/api/training/jobs/${jobId}/cancel`, { method: "POST" });
      if (!response.ok) {
        const data = await readJsonSafely<{ error?: string }>(response);
        throw new Error(data?.error ?? "L'annulation a échoué.");
      }
      await chargerOverview(selectedId);
      setNotice("Tâche annulée.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "L'annulation a échoué.");
    }
  };

  const creerExport = async (kind: string) => {
    if (!selectedId) return;
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/training/exports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: selectedId, kind }),
      });
      const data = await readJsonSafely<{ error?: string }>(response);
      if (!response.ok) throw new Error(data?.error ?? "L'export a échoué.");
      await chargerOverview(selectedId);
      setNotice("Export préparé — il est téléchargeable depuis l'onglet Modèles jusqu'à son expiration.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "L'export a échoué.");
    }
  };

  const dernierPlanPropose = useMemo(
    () => overview?.plans.find((plan) => plan.status === "proposed") ?? null,
    [overview],
  );

  const jobsEvalues = useMemo(
    () => overview?.jobs.filter((job) => job.status === "completed" || job.status === "failed") ?? [],
    [overview],
  );

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-20 pt-6 sm:px-6">
      <SectionHeader
        eyebrow="GEN3IA · LABORATOIRE"
        title="Laboratoire de"
        highlight="modèles"
        description="Gen entraîne VOS modèles : projets, datasets, plans assistés, exécutions suivies pas à pas. La précision affichée est mesurée — un job simulé est toujours étiqueté comme tel."
        action={
          <button
            type="button"
            onClick={() => setFormOpen((open) => !open)}
            className="inline-flex min-h-11 items-center gap-2 rounded-full bg-[var(--g3-gradient)] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_10px_30px_-12px_var(--g3-primary)] transition hover:brightness-110"
          >
            <span aria-hidden="true">{formOpen ? "×" : "+"}</span>
            {formOpen ? "Fermer" : "Nouveau projet"}
          </button>
        }
      />

      {/* Diagnostic d'exécution honnête (catalogue réel) */}
      {catalog && (
        <div className="mb-5 flex flex-wrap items-center gap-2 text-xs text-[var(--g3-muted)]" role="status">
          <StatusBadge
            label={catalog.execution.nativeAvailable ? "Moteur natif disponible" : "Moteur natif indisponible"}
            className={catalog.execution.nativeAvailable
              ? "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]"
              : "bg-[var(--g3-elevated)] text-[var(--g3-faint)]"}
          />
          <StatusBadge
            label={catalog.execution.gpuAvailable ? "GPU disponible" : "File d'attente GPU"}
            className={catalog.execution.gpuAvailable
              ? "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]"
              : "bg-[var(--g3-elevated)] text-[var(--g3-faint)]"}
          />
          {catalog.execution.simulationDetected && (
            <StatusBadge label="Environnement de simulation détecté" className="bg-[var(--g3-warning-soft)] text-[var(--g3-warning-strong)]" />
          )}
        </div>
      )}

      {formOpen && (
        <form
          className="mb-6 grid gap-4 rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5 sm:grid-cols-2"
          onSubmit={(event) => { event.preventDefault(); void creerProjet(); }}
        >
          <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
            Nom du projet
            <input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              required
              minLength={1}
              maxLength={120}
              placeholder="ex. Assistant client bilingue"
              className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
            />
          </label>
          <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
            Famille
            <select
              value={newFamily}
              onChange={(event) => setNewFamily(event.target.value)}
              className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
            >
              {FAMILIES.map((family) => (
                <option key={family.value} value={family.value}>{family.label}</option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-[var(--g3-text-secondary)] sm:col-span-2">
            Objectif (facultatif — affine l&apos;analyse IA)
            <textarea
              value={newObjective}
              onChange={(event) => setNewObjective(event.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="ex. Répondre aux questions récurrentes des clients avec le ton de la marque"
              className="mt-1.5 w-full resize-y rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
            />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="inline-flex min-h-11 items-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white transition enabled:hover:brightness-110 disabled:opacity-50"
            >
              {creating ? "Création…" : "Créer le projet"}
            </button>
          </div>
        </form>
      )}

      {notice && (
        <p className="mb-4 rounded-2xl border border-[var(--g3-success-soft)] bg-[var(--g3-success-soft)] px-4 py-3 text-sm text-[var(--g3-success-strong)]" role="status">
          {notice}
        </p>
      )}
      {actionError && (
        <div className="mb-4 rounded-2xl border border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] px-4 py-3 text-sm text-[var(--g3-danger-strong)]" role="alert">
          {actionError}
          <button type="button" onClick={() => selectedId ? void chargerOverview(selectedId) : void chargerProjets()} className="ml-3 underline underline-offset-2">
            Réessayer
          </button>
        </div>
      )}

      {/* ---------- Onglets ---------- */}
      <div className="mb-5 flex gap-1.5 overflow-x-auto rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-1.5" role="tablist" aria-label="Sections du laboratoire">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => { setTab(item.id); window.history.replaceState(null, "", `#${item.id}`); }}
            className={`min-h-11 flex-1 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-semibold transition ${tab === item.id ? "bg-[var(--g3-elevated)] text-[var(--g3-text)] shadow-sm" : "text-[var(--g3-muted)] hover:text-[var(--g3-text)]"}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* ---------- Corps ---------- */}
      {sessionDisponible === false ? (
        <EmptyState
          icon="⚗"
          title="Connectez-vous pour ouvrir le laboratoire"
          description="Le laboratoire de modèles est rattaché à votre compte : vos projets, datasets et entraînements restent privés."
          action={
            <a href="/login" className="inline-flex min-h-11 items-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white">
              Se connecter
            </a>
          }
        />
      ) : !loaded ? (
        <LoadingState label="Chargement du laboratoire…" rows={3} />
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
      ) : (
        <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
          {/* ----- Colonne projets ----- */}
          <aside aria-label="Projets d'entraînement" className="space-y-2.5">
            {projects.length === 0 ? (
              <EmptyState
                icon="⚗"
                title="Aucun projet"
                description="Créez votre premier projet d'entraînement : vous pourrez y joindre des datasets et lancer une analyse assistée."
              />
            ) : (
              projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => setSelectedId(project.id)}
                  aria-pressed={selectedId === project.id}
                  className={`w-full rounded-2xl border p-4 text-left transition ${selectedId === project.id ? "border-[var(--g3-primary)] bg-[var(--g3-primary-soft)]" : "border-[var(--g3-border)] bg-[var(--g3-surface)] hover:border-[var(--g3-primary-border)]"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold text-[var(--g3-text)]">{project.name}</span>
                    <StatusBadge label={familyLabel(project.family)} />
                  </div>
                  {project.objective && (
                    <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-[var(--g3-muted)]">{project.objective}</p>
                  )}
                  <p className="mt-2 text-[11px] text-[var(--g3-faint)]">Mis à jour {formatDateFr(project.updatedAt)}</p>
                </button>
              ))
            )}
          </aside>

          {/* ----- Détail du projet sélectionné ----- */}
          <section aria-live="polite">
            {!selectedId ? (
              <EmptyState
                icon="→"
                title="Sélectionnez un projet"
                description="Choisissez un projet à gauche pour voir ses datasets, plans, exécutions et modèles."
              />
            ) : overviewBusy && !overview ? (
              <LoadingState label="Chargement du projet…" rows={2} />
            ) : !overview ? (
              <EmptyState icon="⚠" title="Projet indisponible" description={actionError ?? undefined} />
            ) : tab === "entrainement" ? (
              <EntrainementPanel
                overview={overview}
                planPropose={dernierPlanPropose}
                onAnalyse={() => void genererAnalyse()}
                onAccept={(planId) => void accepterPlan(planId)}
                onCancel={(jobId) => void annulerJob(jobId)}
                busy={overviewBusy}
              />
            ) : tab === "evaluation" ? (
              <EvaluationPanel overview={overview} jobsEvalues={jobsEvalues} />
            ) : (
              <ModelesPanel overview={overview} onExport={(kind) => void creerExport(kind)} busy={overviewBusy} />
            )}
          </section>
        </div>
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Onglet Entraînement — datasets, plans, jobs                         */
/* ------------------------------------------------------------------ */

function EntrainementPanel({
  overview,
  planPropose,
  onAnalyse,
  onAccept,
  onCancel,
  busy,
}: {
  overview: ProjectOverview;
  planPropose: TrainingPlan | null;
  onAnalyse: () => void;
  onAccept: (planId: string) => void;
  onCancel: (jobId: string) => void;
  busy: boolean;
}) {
  const { project, datasets, plans, jobs } = overview;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard label="Datasets" value={datasets.length} />
        <MetricCard label="Plans" value={plans.length} />
        <MetricCard label="Exécutions" value={jobs.length} />
        <MetricCard label="Modèles" value={overview.models.length} />
      </div>

      {/* Datasets du projet */}
      <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-[var(--g3-text)]">Datasets du projet</h3>
          <a
            href={`/data#projet-${project.id}`}
            className="inline-flex min-h-11 items-center rounded-full border border-[var(--g3-border)] px-4 py-2 text-sm font-semibold transition hover:border-[var(--g3-primary-border)]"
          >
            Gérer dans le Centre de données →
          </a>
        </div>
        {datasets.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--g3-muted)]">
            Aucun dataset rattaché : importez un fichier (csv, json, jsonl, txt) depuis le Centre de données pour démarrer.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {datasets.slice(0, 5).map((dataset) => (
              <li key={dataset.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm">
                <span className="truncate font-medium text-[var(--g3-text)]">{dataset.name}</span>
                <span className="flex items-center gap-2 text-xs text-[var(--g3-muted)]">
                  <StatusBadge label={dataset.split} />
                  <StatusBadge
                    label={dataset.status === "valid" ? "Valide" : "Rejeté"}
                    className={dataset.status === "valid" ? "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]" : "bg-[var(--g3-danger-soft)] text-[var(--g3-danger-strong)]"}
                  />
                  <span>{formatBytesFr(dataset.sizeBytes)}</span>
                </span>
              </li>
            ))}
            {datasets.length > 5 && <li className="text-xs text-[var(--g3-faint)]">+ {datasets.length - 5} autres datasets</li>}
          </ul>
        )}
      </section>

      {/* Analyse + plan */}
      <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-[var(--g3-text)]">Plan d&apos;entraînement</h3>
          <button
            type="button"
            onClick={onAnalyse}
            disabled={busy}
            className="inline-flex min-h-11 items-center rounded-full bg-[var(--g3-primary)] px-5 py-2.5 text-sm font-semibold text-white transition enabled:hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "Analyse…" : "Générer l'analyse IA"}
          </button>
        </div>
        {plans.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--g3-muted)]">
            L&apos;assistant analyse vos datasets et propose un plan : méthode, moteur, modèle de base, hyperparamètres, risques et critères d&apos;évaluation. Rien n&apos;est lancé sans votre acceptation.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {plans.slice(0, 3).map((plan) => (
              <li key={plan.id} className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-[var(--g3-text)]">{methodLabel[plan.method] ?? plan.method}</span>
                  <span className="flex items-center gap-2">
                    <StatusBadge
                      label={plan.generatedBy === "heuristic-fallback" ? "Règles déterministes" : "Assistant IA"}
                      className={plan.generatedBy === "heuristic-fallback" ? "bg-[var(--g3-warning-soft)] text-[var(--g3-warning-strong)]" : "bg-[var(--g3-info-soft)] text-[var(--g3-info)]"}
                    />
                    <StatusBadge
                      label={plan.status === "proposed" ? "Proposé" : plan.status === "accepted" ? "Accepté" : plan.status}
                      className={plan.status === "accepted" ? "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]" : undefined}
                    />
                  </span>
                </div>
                <p className="mt-2 text-sm text-[var(--g3-muted)]">
                  Moteur <span className="font-medium text-[var(--g3-text)]">{plan.engineId}</span> · base{" "}
                  <span className="font-medium text-[var(--g3-text)]">{plan.baseModel}</span>
                  {plan.resources?.estimatedDurationMinutes ? ` · durée estimée ~${Math.round(plan.resources.estimatedDurationMinutes)} min` : ""}
                </p>
                {plan.warnings.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs text-[var(--g3-warning-strong)]">
                    {plan.warnings.slice(0, 3).map((warning, index) => <li key={index}>⚠ {warning}</li>)}
                  </ul>
                )}
                {plan.evaluationCriteria.length > 0 && (
                  <p className="mt-2 text-xs text-[var(--g3-faint)]">Évaluation : {plan.evaluationCriteria.join(" · ")}</p>
                )}
                {plan.status === "proposed" && (
                  <button
                    type="button"
                    onClick={() => onAccept(plan.id)}
                    disabled={busy}
                    className="mt-3 inline-flex min-h-11 items-center rounded-full bg-[var(--g3-success-strong)] px-5 py-2.5 text-sm font-semibold text-white transition enabled:hover:brightness-110 disabled:opacity-50"
                  >
                    Accepter et lancer l&apos;entraînement
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {planPropose === null && plans.length > 0 && (
          <p className="mt-3 text-xs text-[var(--g3-faint)]">Aucun plan en attente : relancez l&apos;analyse pour une nouvelle proposition.</p>
        )}
      </section>

      {/* Jobs */}
      <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
        <h3 className="font-semibold text-[var(--g3-text)]">Exécutions</h3>
        {jobs.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--g3-muted)]">Aucune exécution : acceptez un plan pour lancer la tâche d&apos;entraînement.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {jobs.slice(0, 6).map((job) => (
              <li key={job.id} className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-[var(--g3-text)]">
                    <StatusBadge label={JOB_STATUS_LABEL[job.status] ?? job.status} className={JOB_STATUS_CLASS[job.status]} />
                    {job.simulated && <StatusBadge label="Simulation" className="bg-[var(--g3-warning-soft)] text-[var(--g3-warning-strong)]" />}
                    <span className="text-xs text-[var(--g3-faint)]">{formatDateFr(job.createdAt)}</span>
                  </span>
                  {["queued", "scheduled", "running"].includes(job.status) && (
                    <button
                      type="button"
                      onClick={() => onCancel(job.id)}
                      className="inline-flex min-h-9 items-center rounded-full border border-[var(--g3-border)] px-3.5 py-1.5 text-xs font-semibold transition hover:border-[var(--g3-danger-strong)] hover:text-[var(--g3-danger-strong)]"
                    >
                      Annuler
                    </button>
                  )}
                </div>
                {job.status === "running" && typeof job.progressPercent === "number" && (
                  <div className="mt-3" role="progressbar" aria-valuenow={job.progressPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Progression de l'entraînement">
                    <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--g3-elevated)]">
                      <div className="h-full rounded-full bg-[var(--g3-gradient)] transition-all" style={{ width: `${job.progressPercent}%` }} />
                    </div>
                    <p className="mt-1.5 text-xs text-[var(--g3-muted)]">
                      {job.progressPercent}%{job.currentStep ? ` · ${job.currentStep}` : ""}
                      {job.epochsDone != null && job.epochsTotal ? ` · époque ${job.epochsDone}/${job.epochsTotal}` : ""}
                      {job.trainLoss != null ? ` · perte train ${job.trainLoss.toFixed(4)}` : ""}
                    </p>
                  </div>
                )}
                {job.status === "queued" && job.waitingReason && (
                  <p className="mt-2 text-xs text-[var(--g3-muted)]">En attente : {job.waitingReason}</p>
                )}
                {job.error && <p className="mt-2 text-xs text-[var(--g3-danger-strong)]" role="alert">{job.error}</p>}
                {job.metrics && Object.keys(job.metrics).length > 0 && (
                  <p className="mt-2 text-xs text-[var(--g3-muted)]">
                    {Object.entries(job.metrics).slice(0, 4).map(([key, value]) => `${key} ${typeof value === "number" ? value.toFixed(4) : value}`).join(" · ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Onglet Évaluation — métriques réelles des jobs terminés             */
/* ------------------------------------------------------------------ */

function EvaluationPanel({ overview, jobsEvalues }: { overview: ProjectOverview; jobsEvalues: TrainingJob[] }) {
  const criteres = overview.plans.flatMap((plan) => plan.evaluationCriteria);
  const criteresUniques = Array.from(new Set(criteres)).slice(0, 8);
  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
        <h3 className="font-semibold text-[var(--g3-text)]">Rapports d&apos;évaluation</h3>
        <p className="mt-2 text-sm text-[var(--g3-muted)]">
          Les métriques proviennent des exécutions réellement terminées — perte d&apos;entraînement, précision et critères du plan accepté. Aucune valeur n&apos;est inventée : un job sans mesure affiche « non mesuré ».
        </p>
        {jobsEvalues.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--g3-muted)]">
            Aucune exécution terminée : lancez un entraînement depuis l&apos;onglet Entraînement, ses rapports apparaîtront ici.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {jobsEvalues.slice(0, 6).map((job) => {
              const precision = job.metrics["eval_accuracy"] ?? job.metrics["accuracy"] ?? job.metrics["eval_precision"];
              return (
                <li key={job.id} className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <StatusBadge
                      label={JOB_STATUS_LABEL[job.status] ?? job.status}
                      className={JOB_STATUS_CLASS[job.status]}
                    />
                    <span className="text-xs text-[var(--g3-faint)]">{formatDateFr(job.finishedAt ?? job.createdAt)}</span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <MetricCard
                      label="Précision"
                      value={precision != null ? `${(precision * 100).toFixed(1)} %` : "non mesuré"}
                    />
                    <MetricCard
                      label="Perte train"
                      value={job.trainLoss != null ? job.trainLoss.toFixed(4) : "—"}
                    />
                    <MetricCard
                      label="Époques"
                      value={job.epochsDone != null && job.epochsTotal ? `${job.epochsDone}/${job.epochsTotal}` : "—"}
                    />
                  </div>
                  {job.metrics && Object.keys(job.metrics).length > 0 && (
                    <p className="mt-3 text-xs text-[var(--g3-muted)]">
                      {Object.entries(job.metrics).slice(0, 6).map(([key, value]) => `${key} ${typeof value === "number" ? value.toFixed(4) : value}`).join(" · ")}
                    </p>
                  )}
                  {job.error && <p className="mt-2 text-xs text-[var(--g3-danger-strong)]">{job.error}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {criteresUniques.length > 0 && (
        <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
          <h3 className="font-semibold text-[var(--g3-text)]">Critères d&apos;évaluation des plans</h3>
          <ul className="mt-3 flex flex-wrap gap-2">
            {criteresUniques.map((critere) => (
              <li key={critere} className="rounded-full border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-1.5 text-xs text-[var(--g3-muted)]">
                {critere}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Onglet Modèles & exports                                            */
/* ------------------------------------------------------------------ */

function ModelesPanel({ overview, onExport, busy }: { overview: ProjectOverview; onExport: (kind: string) => void; busy: boolean }) {
  const MODEL_STATUS_CLASS: Record<string, string> = {
    pending: "bg-[var(--g3-elevated)] text-[var(--g3-muted)]",
    valid: "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]",
    quarantined: "bg-[var(--g3-warning-soft)] text-[var(--g3-warning-strong)]",
    rejected: "bg-[var(--g3-danger-soft)] text-[var(--g3-danger-strong)]",
  };
  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
        <h3 className="font-semibold text-[var(--g3-text)]">Modèles du projet</h3>
        {overview.models.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--g3-muted)]">
            Aucun modèle : les artefacts produits par les entraînements (et vos uploads de base) apparaissent ici après validation et quarantaine.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {overview.models.map((model) => (
              <li key={model.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm">
                <span className="truncate font-medium text-[var(--g3-text)]">{model.name}</span>
                <span className="flex items-center gap-2 text-xs text-[var(--g3-muted)]">
                  <StatusBadge label={model.source === "catalog" ? "Catalogue" : "Upload"} />
                  <StatusBadge label={model.status} className={MODEL_STATUS_CLASS[model.status]} />
                  <span>{formatBytesFr(model.sizeBytes)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-[var(--g3-text)]">Exports</h3>
          <div className="flex flex-wrap gap-2">
            {EXPORT_KINDS.map((kind) => (
              <button
                key={kind.value}
                type="button"
                onClick={() => onExport(kind.value)}
                disabled={busy}
                className="inline-flex min-h-11 items-center rounded-full border border-[var(--g3-border)] px-4 py-2 text-xs font-semibold transition enabled:hover:border-[var(--g3-primary-border)] disabled:opacity-50"
              >
                {kind.label}
              </button>
            ))}
          </div>
        </div>
        {overview.exports.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--g3-muted)]">Aucun export : préparez un téléchargement (modèle entraîné, fichiers, archive datasets ou configuration du plan).</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {overview.exports.map((exportItem) => (
              <li key={exportItem.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm">
                <span className="truncate font-medium text-[var(--g3-text)]">{exportItem.label || exportItem.kind}</span>
                <span className="flex items-center gap-2 text-xs text-[var(--g3-muted)]">
                  <span>{formatBytesFr(exportItem.sizeBytes)}</span>
                  <span>expire {formatDateFr(exportItem.expiresAt)}</span>
                  <a
                    href={`/api/training/exports/${exportItem.id}`}
                    className="rounded-full bg-[var(--g3-primary-soft)] px-3 py-1 font-semibold text-[var(--g3-primary-strong)]"
                  >
                    Télécharger
                  </a>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
