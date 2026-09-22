"use client";

import { useEffect, useState } from "react";
import { authFetch } from "@/lib/firebase/auth-client";
import { RuntimePlanSchema, validateDAG, type RuntimePlan, type RuntimeStep } from "@/lib/agents/runtime/types-and-dag";

type WorkspaceTask = {
  id: string;
  objective: string;
  status: "draft" | "awaiting_approval" | "approved" | "running" | "completed" | "failed" | "cancelled" | "paused";
  plan?: RuntimePlan;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
};

const STATUS: Record<string, string> = {
  draft: "Brouillon",
  awaiting_approval: "Prêt pour validation",
  approved: "Approuvé",
  running: "En cours",
  completed: "Terminée",
  failed: "Échec",
  cancelled: "Annulée",
  paused: "En pause",
};

const STEP_TYPES = ["llm", "tool", "research", "document", "media", "code", "condition"] as const;

function clonePlan(plan: RuntimePlan): RuntimePlan {
  return JSON.parse(JSON.stringify(plan)) as RuntimePlan;
}

function newStep(index: number): RuntimeStep {
  return {
    id: `step-${Date.now()}-${index}`,
    type: "llm",
    name: `Nouvelle étape ${index + 1}`,
    description: "Décris précisément ce que cette étape doit accomplir.",
    dependencies: index > 0 ? [] : [],
    status: "pending",
    input: {},
    skillIds: [],
    maxRetries: 2,
    timeoutMs: 120000,
    sideEffect: false,
    requiresApproval: false,
  };
}

function validatePlan(plan: RuntimePlan): string[] {
  const parsed = RuntimePlanSchema.safeParse(plan);
  if (!parsed.success) return parsed.error.issues.map((issue) => issue.message);
  const dag = validateDAG(parsed.data);
  return dag.valid ? [] : dag.errors;
}

export function WorkspaceTaskPanel({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<WorkspaceTask | null>(null);
  const [draftPlan, setDraftPlan] = useState<RuntimePlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [branches, setBranches] = useState<Array<{ id: string; name: string; active: boolean; snapshotId: string }>>([]);
  const [snapshots, setSnapshots] = useState<Array<{ id: string; branchId: string; createdAt: number; state?: { plan?: RuntimePlan; status?: string } }>>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [historyBusy, setHistoryBusy] = useState(false);
  const [executionResult, setExecutionResult] = useState<{ status: string; outputs?: Record<string, unknown>; observations?: unknown[] } | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    setSaveMessage("");
    try {
      const response = await authFetch("/api/workspace/tasks/" + encodeURIComponent(taskId), { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Impossible de charger la tâche.");
      setTask(data.task);
      setDraftPlan(data.task.plan ? clonePlan(data.task.plan) : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Impossible de charger la tâche.");
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- rechargement volontairement cle sur taskId ; load lit l'etat courant
  useEffect(() => { void load(); }, [taskId]);

  async function loadHistory() {
    try {
      const [branchResponse, snapshotResponse] = await Promise.all([
        authFetch("/api/workspace/tasks/" + encodeURIComponent(taskId) + "/branches", { cache: "no-store" }),
        authFetch("/api/workspace/tasks/" + encodeURIComponent(taskId) + "/rollback", { cache: "no-store" }),
      ]);
      const branchData = await branchResponse.json();
      const snapshotData = await snapshotResponse.json();
      if (!branchResponse.ok) throw new Error(branchData.error || "Impossible de charger les branches.");
      if (!snapshotResponse.ok) throw new Error(snapshotData.error || "Impossible de charger l'historique.");
      setBranches(branchData.branches ?? []);
      setSnapshots(snapshotData.snapshots ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Impossible de charger l'historique.");
    }
  }

  async function createBranchAction() {
    const name = branchName.trim();
    if (!name || historyBusy) return;
    setHistoryBusy(true);
    setError("");
    try {
      const response = await authFetch("/api/workspace/tasks/" + encodeURIComponent(taskId) + "/branches", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Création de branche impossible.");
      setBranchName("");
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Création de branche impossible.");
    } finally { setHistoryBusy(false); }
  }

  async function switchBranch(branchId: string) {
    if (historyBusy || hasChanges) {
      if (hasChanges) setError("Enregistre d'abord les modifications avant de changer de branche.");
      return;
    }
    setHistoryBusy(true); setError("");
    try {
      const response = await authFetch("/api/workspace/tasks/" + encodeURIComponent(taskId) + "/branches", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ branchId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Changement de branche impossible.");
      setTask(data.task); setDraftPlan(data.task.plan ? clonePlan(data.task.plan) : null);
      await loadHistory();
    } catch (e) { setError(e instanceof Error ? e.message : "Changement de branche impossible."); }
    finally { setHistoryBusy(false); }
  }

  async function rollback(snapshotId: string) {
    if (historyBusy || hasChanges) {
      if (hasChanges) setError("Enregistre d'abord les modifications avant de restaurer un snapshot.");
      return;
    }
    if (!window.confirm("Restaurer ce snapshot ? Le plan et l'état de la tâche seront remplacés.")) return;
    setHistoryBusy(true); setError("");
    try {
      const response = await authFetch("/api/workspace/tasks/" + encodeURIComponent(taskId) + "/rollback", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ snapshotId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Restauration impossible.");
      setTask(data.task); setDraftPlan(data.task.plan ? clonePlan(data.task.plan) : null);
      await loadHistory();
    } catch (e) { setError(e instanceof Error ? e.message : "Restauration impossible."); }
    finally { setHistoryBusy(false); }
  }

  const isEditable = task?.status === "draft" || task?.status === "awaiting_approval";
  const currentPlan = task?.plan ?? null;
  const hasChanges = JSON.stringify(currentPlan) !== JSON.stringify(draftPlan);
  const validationErrors = draftPlan ? validatePlan(draftPlan) : [];

  function updateStep(stepId: string, patch: Partial<RuntimeStep>) {
    setDraftPlan((current) => {
      if (!current) return current;
      return {
        ...current,
        steps: current.steps.map((step) => step.id === stepId ? { ...step, ...patch } : step),
      };
    });
    setSaveMessage("");
  }

  function moveStep(index: number, direction: -1 | 1) {
    setDraftPlan((current) => {
      if (!current) return current;
      const target = index + direction;
      if (target < 0 || target >= current.steps.length) return current;
      const steps = [...current.steps];
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...current, steps };
    });
    setSaveMessage("");
  }

  function removeStep(stepId: string) {
    setDraftPlan((current) => {
      if (!current) return current;
      const steps = current.steps
        .filter((step) => step.id !== stepId)
        .map((step) => ({
          ...step,
          dependencies: step.dependencies.filter((dependency) => dependency !== stepId),
        }));
      return { ...current, steps };
    });
    setSaveMessage("");
  }

  function addStep() {
    setDraftPlan((current) => current ? { ...current, steps: [...current.steps, newStep(current.steps.length)] } : current);
    setSaveMessage("");
  }

  async function savePlan() {
    if (!task || !draftPlan || busy || !isEditable) return;
    setError("");
    setSaveMessage("");
    if (validationErrors.length > 0) {
      setError("Le plan contient des erreurs : " + validationErrors.join(" "));
      return;
    }
    setBusy(true);
    try {
      const response = await authFetch("/api/workspace/tasks/" + encodeURIComponent(task.id) + "/plan", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: draftPlan }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Impossible d'enregistrer le plan.");
      setTask(data.task);
      setDraftPlan(data.task.plan ? clonePlan(data.task.plan) : null);
      setSaveMessage("Plan enregistré.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Impossible d'enregistrer le plan.");
    } finally {
      setBusy(false);
    }
  }

  async function executeTask() {
    if (!task || busy || task.status !== "approved") return;
    setBusy(true); setError(""); setExecutionResult(null);
    try {
      const response = await authFetch("/api/workspace/tasks/" + encodeURIComponent(task.id) + "/execute", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Exécution impossible.");
      setExecutionResult({ status: data.status, outputs: data.outputs, observations: data.observations });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Exécution impossible."); await load(); }
    finally { setBusy(false); }
  }

  async function approve() {
    if (!task || busy) return;
    if (hasChanges) {
      setError("Enregistre d'abord les modifications du plan avant de l'approuver.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await authFetch("/api/workspace/tasks/" + encodeURIComponent(task.id) + "/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Validation impossible.");
      setTask(data.task);
      setDraftPlan(data.task.plan ? clonePlan(data.task.plan) : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Validation impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function pauseTask() {
    if (!task || busy || task.status !== "running") return;
    setBusy(true); setError("");
    try {
      const response = await authFetch("/api/workspace/tasks/" + encodeURIComponent(task.id) + "/pause", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Pause demandée depuis le workspace" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Pause impossible.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Pause impossible."); }
    finally { setBusy(false); }
  }

  async function resumeTask() {
    if (!task || busy || task.status !== "paused") return;
    setBusy(true); setError(""); setExecutionResult(null);
    try {
      // Reprise active : la pause est levée ET l'exécution continue
      // immédiatement (les étapes déjà terminées sont sautées).
      const response = await authFetch("/api/workspace/tasks/" + encodeURIComponent(task.id) + "/resume", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ continue: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Reprise impossible.");
      setExecutionResult({ status: data.status ?? "resumed", outputs: data.outputs, observations: data.observations });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Reprise impossible."); await load(); }
    finally { setBusy(false); }
  }

  if (loading) return <section className="g3-workspace-task"><div className="g3-workspace-task-loading">Chargement du plan...</div></section>;
  if (error && !task) return <section className="g3-workspace-task"><div className="g3-workspace-task-error">{error}<button type="button" onClick={() => void load()}>Réessayer</button></div></section>;
  if (!task) return null;

  const plan = draftPlan ?? task.plan;
  const steps = plan?.steps ?? [];

  return (
    <section className="g3-workspace-task" aria-label="Workspace task">
      <div className="g3-workspace-task-head">
        <div>
          <div className="g3-eyebrow">WORKSPACE TASK</div>
          <h2>{task.objective}</h2>
          <p>Plan préparé par Gen3ia · {STATUS[task.status] ?? task.status}</p>
        </div>
        <div className="g3-workspace-task-actions">
          <span className={"g3-workspace-task-status status-" + task.status}>{STATUS[task.status] ?? task.status}</span>
          {isEditable && hasChanges && (
            <button type="button" disabled={busy || validationErrors.length > 0} onClick={() => void savePlan()} className="g3-workspace-task-save">
              {busy ? "Enregistrement..." : "Enregistrer"}
            </button>
          )}
          {task.status === "awaiting_approval" && (
            <button type="button" disabled={busy || hasChanges} onClick={() => void approve()} className="g3-workspace-task-approve">
              {busy ? "Validation..." : "Approuver le plan"}
            </button>
          )}
          {task.status === "approved" && (
            <button type="button" disabled={busy} onClick={() => void executeTask()} className="g3-workspace-task-approve">
              {busy ? "Exécution..." : "Exécuter la tâche"}
            </button>
          )}
          {task.status === "running" && (
            <button type="button" disabled={busy} onClick={() => void pauseTask()} className="g3-workspace-task-pause">
              {busy ? "Pause..." : "Mettre en pause"}
            </button>
          )}
          {task.status === "paused" && (
            <button type="button" disabled={busy} onClick={() => void resumeTask()} className="g3-workspace-task-approve">
              {busy ? "Reprise..." : "Reprendre l'exécution"}
            </button>
          )}
        </div>
      </div>

      <div className="g3-workspace-task-historybar">
        <button type="button" onClick={() => { setHistoryOpen((v) => !v); if (!historyOpen) void loadHistory(); }} disabled={historyBusy}>
          {historyOpen ? "Fermer historique" : "Branches & historique"}
        </button>
        {historyOpen && <div className="g3-workspace-task-history">
          <div className="g3-workspace-task-history-section">
            <strong>Branches</strong>
            <div className="g3-workspace-task-branch-create">
              <input value={branchName} onChange={(e) => setBranchName(e.target.value)} placeholder="Nom de la branche" maxLength={80} />
              <button type="button" onClick={() => void createBranchAction()} disabled={!branchName.trim() || historyBusy}>Créer</button>
            </div>
            {branches.map((branch) => <button key={branch.id} type="button" className={"g3-workspace-task-branch " + (branch.active ? "is-active" : "")} onClick={() => void switchBranch(branch.id)} disabled={historyBusy || branch.active}>
              <span>{branch.name}</span>{branch.active && <small>active</small>}
            </button>)}
          </div>
          <div className="g3-workspace-task-history-section">
            <strong>Snapshots</strong>
            {snapshots.slice(0, 12).map((snapshot) => <div key={snapshot.id} className="g3-workspace-task-snapshot">
              <div><span>{new Date(snapshot.createdAt).toLocaleString("fr-FR")}</span><small>{snapshot.state?.status ?? "plan"}</small></div>
              <button type="button" onClick={() => void rollback(snapshot.id)} disabled={historyBusy || hasChanges}>Restaurer</button>
            </div>)}
          </div>
        </div>}
      </div>

      <div className="g3-workspace-task-flow">
        <span className="is-active">1. Plan</span><span>→</span>
        <span className={task.status !== "awaiting_approval" && task.status !== "draft" ? "is-active" : ""}>2. Autorisation</span><span>→</span>
        <span className={task.status === "running" || task.status === "completed" || task.status === "paused" ? "is-active" : ""}>3. Exécution</span><span>→</span>
        <span className={task.status === "completed" ? "is-active" : ""}>4. Vérification</span>
      </div>

      <div className="g3-workspace-task-toolbar">
        <div>
          <strong>Plan d’exécution</strong>
          <span>{steps.length} étape{steps.length > 1 ? "s" : ""} · {plan?.maxConcurrency ?? 0} concurrentes max</span>
        </div>
        {isEditable && (
          <button type="button" onClick={addStep} className="g3-workspace-task-add" disabled={busy}>+ Ajouter une étape</button>
        )}
      </div>

      <div className="g3-workspace-task-plan">
        {steps.map((step, index) => (
          <article key={step.id} className="g3-workspace-task-step g3-workspace-task-step-editor">
            <div className="g3-workspace-task-step-top">
              <span className="g3-workspace-task-index">{index + 1}</span>
              <div className="g3-workspace-task-step-order">
                <button type="button" aria-label="Monter l'étape" disabled={!isEditable || index === 0} onClick={() => moveStep(index, -1)}>↑</button>
                <button type="button" aria-label="Descendre l'étape" disabled={!isEditable || index === steps.length - 1} onClick={() => moveStep(index, 1)}>↓</button>
              </div>
              <span className="g3-workspace-task-step-id">{step.id}</span>
              {isEditable && steps.length > 1 && (
                <button type="button" className="g3-workspace-task-remove" onClick={() => removeStep(step.id)}>Supprimer</button>
              )}
            </div>

            <div className="g3-workspace-task-fields">
              <label>
                Nom
                <input value={step.name} disabled={!isEditable} onChange={(e) => updateStep(step.id, { name: e.target.value })} />
              </label>
              <label>
                Type
                <select value={step.type} disabled={!isEditable} onChange={(e) => updateStep(step.id, { type: e.target.value as RuntimeStep["type"] })}>
                  {STEP_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label className="g3-workspace-task-field-wide">
                Description
                <textarea value={step.description} disabled={!isEditable} rows={2} onChange={(e) => updateStep(step.id, { description: e.target.value })} />
              </label>
              <label>
                Outil
                <input value={step.toolName ?? ""} disabled={!isEditable} placeholder="Aucun outil" onChange={(e) => updateStep(step.id, { toolName: e.target.value || undefined })} />
              </label>
              <label className="g3-workspace-task-field-wide">
                Dépendances (IDs séparés par des virgules)
                <input
                  value={step.dependencies.join(", ")}
                  disabled={!isEditable}
                  onChange={(e) => updateStep(step.id, { dependencies: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })}
                />
              </label>
              <label className="g3-workspace-task-check"><input type="checkbox" checked={step.requiresApproval} disabled={!isEditable} onChange={(e) => updateStep(step.id, { requiresApproval: e.target.checked })} /> Autorisation humaine</label>
              <label className="g3-workspace-task-check"><input type="checkbox" checked={step.sideEffect} disabled={!isEditable} onChange={(e) => updateStep(step.id, { sideEffect: e.target.checked })} /> Effet externe</label>
            </div>
          </article>
        ))}
      </div>

      {validationErrors.length > 0 && (
        <div className="g3-workspace-task-validation" role="alert">
          <strong>Plan invalide</strong>
          <ul>{validationErrors.map((item, index) => <li key={index}>{item}</li>)}</ul>
        </div>
      )}
      {error && <div className="g3-workspace-task-inline-error" role="alert">{error}</div>}
      {saveMessage && <div className="g3-workspace-task-save-message" role="status">{saveMessage}</div>}

      {task.status === "awaiting_approval" && <p className="g3-workspace-task-note">Le plan est visible avant toute exécution. Les actions sensibles restent protégées par les politiques d’autorisation.</p>}
      {task.status === "approved" && <p className="g3-workspace-task-note">Plan approuvé. L’exécution utilise le runtime sécurisé Gen3ia et ses politiques d’outils.</p>}
      {task.status === "running" && <p className="g3-workspace-task-note">Exécution en cours. La pause prend effet entre deux étapes — le travail déjà réalisé est conservé.</p>}
      {task.status === "paused" && <p className="g3-workspace-task-note">Tâche en pause. La reprise continue aux étapes restantes, sans re-payer les étapes terminées.</p>}
      {executionResult && (
        <div className="g3-workspace-task-execution-result">
          <strong>Résultat d’exécution · {executionResult.status}</strong>
          {executionResult.outputs && <pre>{JSON.stringify(executionResult.outputs, null, 2)}</pre>}
        </div>
      )}
    </section>
  );
}
