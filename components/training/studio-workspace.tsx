"use client";

/**
 * STUDIO D'ENTRAÎNEMENT — l'interface qui manquait (diagnostic Critique).
 * Toute la surface consomme les API RÉELLES existantes (aucun mock) :
 *  - GET/POST /api/training/projects                    (projets + quotas)
 *  - GET /api/training/projects/[id]                    (vue agrégée + sweep)
 *  - POST /api/training/projects/[id]/datasets          (upload multipart réel)
 *  - PATCH/DELETE /api/training/projects/[id]/datasets/[assetId]
 *  - POST /api/training/projects/[id]/analysis          (plan IA / heuristique)
 *  - POST /api/training/projects/[id]/plans/[planId]/accept  (→ job réel)
 *  - GET /api/training/projects/[id]/jobs/[jobId]       (statut à la demande)
 *
 * HONNÊTETÉ D'AFFICHAGE : progression, métriques, epochs et lineage sont
 * ceux RAPPORTÉS par le worker — jamais calculés côté client. Le suivi
 * d'expériences (eval_loss par époque, early stopping) est affiché tel quel
 * depuis job.metrics ; le data lineage (sha256, origine) vient du snapshot
 * figé à la création du job.
 */

import React from "react";

/* ============================ Types (miroirs des schémas zod) ============ */

interface TrainingProject {
  id: string;
  name: string;
  description: string;
  family: string;
  objective: string;
  primaryLanguage: string;
  mode: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface ValidationFinding {
  code: string;
  severity: string;
  message: string;
}

interface DatasetAsset {
  id: string;
  name: string;
  format: string;
  source: string;
  hubRef: string | null;
  sizeBytes: number;
  sha256: string;
  split: string;
  status: string;
  findings: ValidationFinding[];
  createdAt: string;
}

interface TrainingPlan {
  id: string;
  method: string;
  engineId: string;
  baseModel: string;
  parameters: Record<string, string | number | boolean | null>;
  resources: { vramGbEstimate?: number | null; estimatedDurationMinutes?: number | null };
  risks: string[];
  warnings: string[];
  expectedOutcomes: string;
  generatedBy: string;
  status: string;
  createdAt: string;
}

interface TrainingJob {
  id: string;
  planId: string;
  status: string;
  progressPercent: number | null;
  currentStep: string | null;
  epochsTotal: number | null;
  epochsDone: number | null;
  trainLoss: number | null;
  metrics: Record<string, number>;
  waitingReason: string | null;
  simulated: boolean;
  error: string | null;
  artifacts: Array<{ label: string; storageKey: string; sizeBytes: number }>;
  dataLineage?: Array<{
    assetId: string;
    name: string;
    split: string;
    sha256: string;
    sizeBytes: number;
    origin: string;
  }>;
  events: Array<{ at: string; level: string; message: string }>;
  createdAt: string;
  finishedAt?: string | null;
}

interface ModelAsset {
  id: string;
  name: string;
  source: string;
  catalogId: string | null;
  format: string | null;
  sizeBytes: number;
  status: string;
}

interface ProjectOverview {
  project: TrainingProject;
  datasets: DatasetAsset[];
  plans: TrainingPlan[];
  jobs: TrainingJob[];
  models: ModelAsset[];
}

const FAMILIES = ["text", "image", "audio", "video", "multimodal", "specialized"] as const;
const SPLITS = ["train", "validation", "test", "unassigned"] as const;

function ocriter(bornes: number): string {
  if (bornes < 1024) return `${bornes} o`;
  if (bornes < 1024 * 1024) return `${(bornes / 1024).toFixed(1)} Ko`;
  return `${(bornes / (1024 * 1024)).toFixed(2)} Mo`;
}

function dateCourte(iso: string): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "—";
}

/** Extrait l'historique d'époques des métriques plates (eval_loss_epoch_N). */
function historiqueEpoques(metrics: Record<string, number>): Array<{ epoch: number; evalLoss?: number; trainLoss?: number }> {
  const epochs = new Set<number>();
  for (const cle of Object.keys(metrics)) {
    const match = /^(eval_loss|train_loss)_epoch_(\d+)$/.exec(cle);
    if (match) epochs.add(Number(match[2]));
  }
  return [...epochs]
    .sort((a, b) => a - b)
    .map((epoch) => ({
      epoch,
      evalLoss: metrics[`eval_loss_epoch_${epoch}`],
      trainLoss: metrics[`train_loss_epoch_${epoch}`],
    }));
}

/* ============================ Composant principal ======================== */

export function TrainingStudio() {
  const [projects, setProjects] = React.useState<TrainingProject[] | null>(null);
  const [actif, setActif] = React.useState<string | null>(null);
  const [overview, setOverview] = React.useState<ProjectOverview | null>(null);
  const [chargement, setChargement] = React.useState(false);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [upload, setUpload] = React.useState<{ fichier: File | null; split: string }>({ fichier: null, split: "train" });
  const [envoi, setEnvoi] = React.useState(false);
  const [analyse, setAnalyse] = React.useState(false);

  /* ---- Chargement des projets ---- */
  const chargerProjets = React.useCallback(async () => {
    try {
      const response = await fetch("/api/training/projects", { cache: "no-store" });
      const data = (await response.json()) as { projects?: TrainingProject[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setProjects(data.projects ?? []);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Projets indisponibles");
    }
  }, []);

  React.useEffect(() => {
    void chargerProjets();
  }, [chargerProjets]);

  /* ---- Vue projet + polling quand un job tourne ---- */
  const chargerOverview = React.useCallback(async (projectId: string, silencieux = false) => {
    if (!silencieux) setChargement(true);
    try {
      const response = await fetch(`/api/training/projects/${projectId}`, { cache: "no-store" });
      const data = (await response.json()) as Partial<ProjectOverview> & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setOverview({ project: data.project!, datasets: data.datasets ?? [], plans: data.plans ?? [], jobs: data.jobs ?? [], models: data.models ?? [] });
      setErreur(null);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Projet indisponible");
    } finally {
      if (!silencieux) setChargement(false);
    }
  }, []);

  React.useEffect(() => {
    if (!actif) {
      setOverview(null);
      return;
    }
    void chargerOverview(actif);
  }, [actif, chargerOverview]);

  const jobActif = overview?.jobs.some((j) => j.status === "running" || j.status === "queued") ?? false;
  React.useEffect(() => {
    if (!actif || !jobActif) return;
    const timer = window.setInterval(() => void chargerOverview(actif, true), 5000);
    return () => window.clearInterval(timer);
  }, [actif, jobActif, chargerOverview]);

  /* ---- Actions ---- */
  const creerProjet = async (formulaire: FormData): Promise<void> => {
    setErreur(null);
    try {
      const response = await fetch("/api/training/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: String(formulaire.get("name") ?? "").trim(),
          description: String(formulaire.get("description") ?? "").trim(),
          family: String(formulaire.get("family") ?? "text"),
          objective: String(formulaire.get("objective") ?? "").trim(),
        }),
      });
      const data = (await response.json()) as { project?: TrainingProject; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Création impossible");
      await chargerProjets();
      if (data.project) setActif(data.project.id);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Création impossible");
    }
  };

  const televerserDataset = async (): Promise<void> => {
    if (!overview || !upload.fichier) return;
    setEnvoi(true);
    setErreur(null);
    setMessage(null);
    try {
      const form = new FormData();
      form.append("file", upload.fichier);
      form.append("split", upload.split);
      const response = await fetch(`/api/training/projects/${overview.project.id}/datasets`, {
        method: "POST",
        body: form,
      });
      const data = (await response.json()) as { dataset?: DatasetAsset; error?: string; findings?: ValidationFinding[] };
      if (!response.ok) throw new Error(data.error ?? "Téléversement refusé");
      const rejet = data.dataset?.status === "rejected";
      setMessage(
        rejet
          ? `« ${data.dataset?.name} » analysé mais rejeté (contrôle qualité) — voir les constats.`
          : `« ${data.dataset?.name} » importé et validé (${ocriter(data.dataset?.sizeBytes ?? 0)}).`,
      );
      setUpload({ fichier: null, split: "train" });
      await chargerOverview(overview.project.id, true);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Téléversement impossible");
    } finally {
      setEnvoi(false);
    }
  };

  const changerSplit = async (assetId: string, split: string): Promise<void> => {
    if (!overview) return;
    try {
      const response = await fetch(`/api/training/projects/${overview.project.id}/datasets/${assetId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ split }),
      });
      if (!response.ok) throw new Error("Changement de split refusé");
      await chargerOverview(overview.project.id, true);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Changement de split impossible");
    }
  };

  const supprimerDataset = async (assetId: string): Promise<void> => {
    if (!overview) return;
    try {
      const response = await fetch(`/api/training/projects/${overview.project.id}/datasets/${assetId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Suppression refusée");
      await chargerOverview(overview.project.id, true);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Suppression impossible");
    }
  };

  const analyser = async (): Promise<void> => {
    if (!overview) return;
    setAnalyse(true);
    setErreur(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/training/projects/${overview.project.id}/analysis`, { method: "POST" });
      const data = (await response.json()) as { plan?: TrainingPlan; generatedBy?: string; explanation?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Analyse impossible");
      setMessage(
        `Plan généré (${data.generatedBy === "heuristic-fallback" ? "règles déterministes" : "IA"}) — ${data.explanation ?? ""}`.trim(),
      );
      await chargerOverview(overview.project.id, true);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Analyse impossible");
    } finally {
      setAnalyse(false);
    }
  };

  const accepterPlan = async (planId: string): Promise<void> => {
    if (!overview) return;
    setErreur(null);
    try {
      const response = await fetch(`/api/training/projects/${overview.project.id}/plans/${planId}/accept`, { method: "POST" });
      const data = (await response.json()) as { job?: TrainingJob; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Lancement refusé");
      setMessage(
        data.job?.status === "running"
          ? "Tâche lancée — progression réelle en direct ci-dessous."
          : "Tâche créée — en file d'attente d'un fournisseur GPU.",
      );
      await chargerOverview(overview.project.id, true);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Lancement impossible");
    }
  };

  /* ============================ Rendu ================================ */
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">🎓 Studio d&apos;entraînement IA</h1>
        <p className="mt-1 text-sm opacity-70">
          Projets d&apos;entraînement réels : datasets validés, plans analysés par l&apos;IA, tâches GPU, rapports par époque
          (early stopping inclus) et lineage des données.
        </p>
      </header>

      {erreur ? (
        <div role="alert" className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {erreur}
        </div>
      ) : null}
      {message ? (
        <div role="status" className="mb-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-400">
          {message}
        </div>
      ) : null}

      {!actif ? (
        /* ---------------- Liste des projets ---------------- */
        <section aria-label="Projets d'entraînement">
          <FormulaireProjet onCreer={creerProjet} />
          <div className="mt-6">
            {projects === null ? (
              <p className="text-sm opacity-60">Chargement des projets…</p>
            ) : projects.length === 0 ? (
              <p className="text-sm opacity-60">Aucun projet : créez le premier ci-dessus pour commencer.</p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2">
                {projects.map((projet) => (
                  <li key={projet.id}>
                    <button
                      type="button"
                      onClick={() => setActif(projet.id)}
                      className="w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-panel)] p-4 text-left transition hover:border-[var(--g3-accent)]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">{projet.name}</span>
                        <span className="rounded-full bg-[var(--g3-hover)] px-2 py-0.5 text-xs opacity-80">{projet.family}</span>
                      </div>
                      {projet.description ? <p className="mt-1 line-clamp-2 text-xs opacity-70">{projet.description}</p> : null}
                      <p className="mt-2 text-xs opacity-50">Créé le {dateCourte(projet.createdAt)}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : (
        /* ---------------- Détail du projet ---------------- */
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <button type="button" onClick={() => setActif(null)} className="text-sm opacity-70 underline hover:opacity-100">
                ← Tous les projets
              </button>
              <h2 className="mt-1 text-xl font-bold">{overview?.project.name ?? "Chargement…"}</h2>
            </div>
            <button
              type="button"
              onClick={analyser}
              disabled={analyse || !overview}
              className="rounded-lg bg-[var(--g3-accent)] px-4 py-2 text-sm font-semibold text-black disabled:opacity-50"
            >
              {analyse ? "Analyse en cours…" : "Analyser avec l'IA → plan"}
            </button>
          </div>

          {!overview || chargement ? (
            <p className="text-sm opacity-60">Chargement du projet…</p>
          ) : (
            <div className="grid gap-6">
              {/* --- Datasets --- */}
              <Section titre={`Datasets (${overview.datasets.length})`}>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <input
                    type="file"
                    accept=".csv,.json,.jsonl,.txt"
                    onChange={(e) => setUpload((u) => ({ ...u, fichier: e.target.files?.[0] ?? null }))}
                    className="text-xs"
                    aria-label="Fichier dataset (csv/json/jsonl/txt)"
                  />
                  <select
                    value={upload.split}
                    onChange={(e) => setUpload((u) => ({ ...u, split: e.target.value }))}
                    className="rounded-md border border-[var(--g3-border)] bg-transparent px-2 py-1 text-xs"
                    aria-label="Split du dataset"
                  >
                    {SPLITS.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void televerserDataset()}
                    disabled={!upload.fichier || envoi}
                    className="rounded-md border border-[var(--g3-border)] px-3 py-1 text-xs font-semibold hover:border-[var(--g3-accent)] disabled:opacity-40"
                  >
                    {envoi ? "Import + validation…" : "Importer"}
                  </button>
                </div>
                {overview.datasets.length === 0 ? (
                  <p className="text-xs opacity-60">Aucun dataset : importez un fichier csv/json/jsonl/txt (analyse PII + doublons réelle).</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="opacity-60">
                        <tr>
                          <th className="py-1 pr-3">Fichier</th>
                          <th className="py-1 pr-3">Taille</th>
                          <th className="py-1 pr-3">Origine</th>
                          <th className="py-1 pr-3">Split</th>
                          <th className="py-1 pr-3">Statut</th>
                          <th className="py-1 pr-3">Constats</th>
                          <th className="py-1" />
                        </tr>
                      </thead>
                      <tbody>
                        {overview.datasets.map((d) => (
                          <tr key={d.id} className="border-t border-[var(--g3-border)]">
                            <td className="py-1.5 pr-3 font-medium">{d.name}</td>
                            <td className="py-1.5 pr-3">{ocriter(d.sizeBytes)}</td>
                            <td className="py-1.5 pr-3">{d.source === "upload" ? "upload" : `${d.source}${d.hubRef ? ` · ${d.hubRef}` : ""}`}</td>
                            <td className="py-1.5 pr-3">
                              <select
                                value={d.split}
                                onChange={(e) => void changerSplit(d.id, e.target.value)}
                                className="rounded border border-[var(--g3-border)] bg-transparent px-1 py-0.5"
                                aria-label={`Split de ${d.name}`}
                              >
                                {SPLITS.map((s) => (
                                  <option key={s} value={s}>{s}</option>
                                ))}
                              </select>
                            </td>
                            <td className={`py-1.5 pr-3 font-semibold ${d.status === "valid" ? "text-emerald-400" : "text-red-400"}`}>
                              {d.status}
                            </td>
                            <td className="py-1.5 pr-3">
                              {d.findings.length === 0 ? (
                                <span className="opacity-50">—</span>
                              ) : (
                                <span title={d.findings.map((f) => `${f.severity}: ${f.message}`).join("\n")}>
                                  {d.findings.length} (voir title)
                                </span>
                              )}
                            </td>
                            <td className="py-1.5">
                              <button type="button" onClick={() => void supprimerDataset(d.id)} className="underline opacity-60 hover:opacity-100">
                                Supprimer
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>

              {/* --- Plans --- */}
              <Section titre={`Plans d'entraînement (${overview.plans.length})`}>
                {overview.plans.length === 0 ? (
                  <p className="text-xs opacity-60">Aucun plan : cliquez « Analyser avec l&apos;IA » une fois vos datasets importés.</p>
                ) : (
                  <ul className="grid gap-3">
                    {overview.plans.map((plan) => (
                      <li key={plan.id} className="rounded-lg border border-[var(--g3-border)] p-3 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold">
                            {plan.method} · moteur {plan.engineId}
                          </span>
                          <span className="opacity-70">
                            {plan.status === "proposed" ? "proposé" : plan.status} ·{" "}
                            {plan.generatedBy === "heuristic-fallback" ? "règles" : "IA"}
                          </span>
                        </div>
                        <p className="mt-1 opacity-80">{plan.expectedOutcomes}</p>
                        <p className="mt-1 opacity-60">
                          Base : {plan.baseModel} · VRAM ≈ {plan.resources.vramGbEstimate ?? "—"} Go · durée ≈{" "}
                          {plan.resources.estimatedDurationMinutes ?? "—"} min
                        </p>
                        {plan.warnings.length > 0 ? (
                          <p className="mt-1 text-amber-400">⚠ {plan.warnings.slice(0, 2).join(" · ")}</p>
                        ) : null}
                        {plan.status === "proposed" ? (
                          <button
                            type="button"
                            onClick={() => void accepterPlan(plan.id)}
                            className="mt-2 rounded-md bg-[var(--g3-accent)] px-3 py-1 font-semibold text-black"
                          >
                            Accepter → lancer l&apos;entraînement
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {/* --- Jobs (rapports réels) --- */}
              <Section titre={`Tâches d'entraînement (${overview.jobs.length})${jobActif ? " — suivi 5 s" : ""}`}>
                {overview.jobs.length === 0 ? (
                  <p className="text-xs opacity-60">Aucune tâche : acceptez un plan pour lancer un entraînement réel.</p>
                ) : (
                  <ul className="grid gap-3">
                    {overview.jobs.map((job) => (
                      <li key={job.id} className="rounded-lg border border-[var(--g3-border)] p-3 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold">
                            {job.status}
                            {job.simulated ? " · [SIMULATION]" : ""}
                          </span>
                          <span className="opacity-60">{dateCourte(job.createdAt)}</span>
                        </div>
                        {job.progressPercent !== null ? (
                          <div className="mt-2 h-2 w-full overflow-hidden rounded bg-[var(--g3-hover)]">
                            <div className="h-full bg-[var(--g3-accent)]" style={{ width: `${job.progressPercent}%` }} />
                          </div>
                        ) : null}
                        <p className="mt-1 opacity-80">
                          {job.currentStep ?? (job.waitingReason ? `En attente : ${job.waitingReason}` : "")} · époques{" "}
                          {job.epochsDone ?? 0}/{job.epochsTotal ?? "—"}
                          {job.trainLoss !== null ? ` · perte train ${job.trainLoss.toFixed(4)}` : ""}
                        </p>

                        {/* Suivi d'expériences : historique par époque (worker réel) */}
                        {historiqueEpoques(job.metrics).length > 0 ? (
                          <div className="mt-2">
                            <p className="font-semibold opacity-70">Historique par époque :</p>
                            <table className="mt-1 w-full max-w-sm">
                              <thead className="opacity-50">
                                <tr>
                                  <th className="text-left">Époque</th>
                                  <th className="text-left">eval_loss</th>
                                  <th className="text-left">train_loss</th>
                                </tr>
                              </thead>
                              <tbody>
                                {historiqueEpoques(job.metrics).map((e) => (
                                  <tr key={e.epoch}>
                                    <td>{e.epoch}</td>
                                    <td>{e.evalLoss !== undefined ? e.evalLoss.toFixed(4) : "—"}</td>
                                    <td>{e.trainLoss !== undefined ? e.trainLoss.toFixed(4) : "—"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {job.metrics.best_eval_loss !== undefined ? (
                              <p className="mt-1 opacity-70">Meilleur eval_loss : {job.metrics.best_eval_loss.toFixed(4)}</p>
                            ) : null}
                            {job.metrics.early_stopped === 1 ? (
                              <p className="mt-1 font-semibold text-emerald-400">
                                ⏹ Early stopping — arrêt à l&apos;époque {job.metrics.epochs_effectuees ?? job.epochsDone} (sur-apprentissage évité, GPU économisé).
                              </p>
                            ) : null}
                          </div>
                        ) : null}

                        {/* Autres métriques réelles (precisionTrain/Test pour gen3-native) */}
                        {Object.entries(job.metrics).filter(([cle]) => ["precisionTrain", "precisionTest", "pairesApprises", "vocabulaire"].includes(cle)).length > 0 ? (
                          <p className="mt-1 opacity-70">
                            {Object.entries(job.metrics)
                              .filter(([cle]) => ["precisionTrain", "precisionTest", "pairesApprises", "vocabulaire"].includes(cle))
                              .map(([cle, valeur]) => `${cle} : ${cle.startsWith("precision") ? `${(valeur * 100).toFixed(1)} %` : valeur}`)
                              .join(" · ")}
                          </p>
                        ) : null}

                        {/* Data lineage */}
                        {job.dataLineage && job.dataLineage.length > 0 ? (
                          <details className="mt-2">
                            <summary className="cursor-pointer opacity-70">Lineage des données ({job.dataLineage.length})</summary>
                            <ul className="mt-1 grid gap-1 opacity-80">
                              {job.dataLineage.map((l) => (
                                <li key={l.assetId}>
                                  {l.name} · {l.split} · {l.origin} · sha256 {l.sha256.slice(0, 12)}… · {ocriter(l.sizeBytes)}
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}

                        {/* Artefacts + erreur */}
                        {job.artifacts.length > 0 ? (
                          <p className="mt-1 opacity-80">
                            Artefacts : {job.artifacts.map((a) => `${a.label} (${ocriter(a.sizeBytes)})`).join(", ")}
                          </p>
                        ) : null}
                        {job.error ? <p className="mt-1 text-red-400">{job.error}</p> : null}
                        {job.events.length > 0 ? (
                          <details className="mt-2">
                            <summary className="cursor-pointer opacity-60">Journal ({job.events.length})</summary>
                            <ul className="mt-1 grid gap-0.5 opacity-70">
                              {job.events.slice(-8).reverse().map((e, i) => (
                                <li key={`${e.at}-${i}`}>
                                  [{e.level}] {e.message}
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {/* --- Modèles --- */}
              {overview.models.length > 0 ? (
                <Section titre={`Modèles (${overview.models.length})`}>
                  <ul className="grid gap-1 text-xs">
                    {overview.models.map((m) => (
                      <li key={m.id}>
                        {m.name} · {m.source}
                        {m.catalogId ? ` · ${m.catalogId}` : ""} · {m.status} · {ocriter(m.sizeBytes)}
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ============================ Sous-composants ============================ */

function Section({ titre, children }: { titre: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-panel)] p-4">
      <h3 className="mb-3 text-sm font-bold uppercase tracking-wide opacity-80">{titre}</h3>
      {children}
    </section>
  );
}

function FormulaireProjet({ onCreer }: { onCreer: (data: FormData) => Promise<void> }) {
  const [ouvert, setOuvert] = React.useState(false);
  const [envoi, setEnvoi] = React.useState(false);
  return (
    <div className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-panel)] p-4">
      {!ouvert ? (
        <button type="button" onClick={() => setOuvert(true)} className="rounded-lg bg-[var(--g3-accent)] px-4 py-2 text-sm font-semibold text-black">
          + Nouveau projet d&apos;entraînement
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const formulaire = new FormData(e.currentTarget);
            setEnvoi(true);
            void onCreer(formulaire).finally(() => {
              setEnvoi(false);
              setOuvert(false);
            });
          }}
          className="grid gap-3"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs font-semibold">
              Nom du projet
              <input name="name" required maxLength={120} className="mt-1 w-full rounded-md border border-[var(--g3-border)] bg-transparent px-2 py-1.5 text-sm" placeholder="Ex : Assistant support FR/EN" />
            </label>
            <label className="text-xs font-semibold">
              Famille
              <select name="family" className="mt-1 w-full rounded-md border border-[var(--g3-border)] bg-transparent px-2 py-1.5 text-sm" defaultValue="text">
                {FAMILIES.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="text-xs font-semibold">
            Objectif (aide l&apos;analyse IA à choisir moteur et hyperparamètres)
            <textarea name="objective" maxLength={2000} rows={2} className="mt-1 w-full rounded-md border border-[var(--g3-border)] bg-transparent px-2 py-1.5 text-sm" placeholder="Ex : répondre aux questions de facturation à partir des paires question/réponse" />
          </label>
          <label className="text-xs font-semibold">
            Description (optionnelle)
            <input name="description" maxLength={2000} className="mt-1 w-full rounded-md border border-[var(--g3-border)] bg-transparent px-2 py-1.5 text-sm" />
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={envoi} className="rounded-lg bg-[var(--g3-accent)] px-4 py-2 text-sm font-semibold text-black disabled:opacity-50">
              {envoi ? "Création…" : "Créer le projet"}
            </button>
            <button type="button" onClick={() => setOuvert(false)} className="rounded-lg border border-[var(--g3-border)] px-4 py-2 text-sm">
              Annuler
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
