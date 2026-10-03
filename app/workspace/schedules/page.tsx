"use client";

import { useCallback, useEffect, useState } from "react";
import { SectionHeader } from "@/components/shells/section-header";
import { EmptyState, LoadingState } from "@/components/shells/states";
import { authFetch } from "@/lib/firebase/auth-client";

/**
 * /workspace/schedules — TÂCHES PLANIFIÉES AVANCÉES.
 *
 * Gestion visuelle des planifications d'agents (jusqu'ici 100 %
 * conversationnelle) : liste, pause/reprise, exécution immédiate,
 * prochaine occurrence, état de relance après échec et historique des
 * runs par planification. Les données viennent des routes réelles
 * /api/agents/schedules (+ /[id], /[id]/run, /[id]/runs).
 */

interface ScheduleItem {
  id: string;
  agentId: string;
  name: string;
  objective: string;
  timezone: string;
  daysOfWeek?: number[];
  startTime?: string;
  endTime?: string;
  intervalMinutes?: number;
  runAtMs?: number;
  enabled?: boolean;
  nextRunAt?: string;
  lastExecutionStatus?: string;
  lastError?: string;
  retryState?: { attempt: number; notBeforeMs: number };
  catchUp?: boolean;
}

interface ScheduleRunItem {
  id: string;
  status: string;
  slot: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

const DAYS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];

function describeRecurrence(schedule: ScheduleItem): string {
  if (schedule.runAtMs && !schedule.daysOfWeek?.length) {
    return `Ponctuel · ${new Date(schedule.runAtMs).toLocaleString("fr-FR")}`;
  }
  const days = (schedule.daysOfWeek ?? []).map((d) => DAYS[d] ?? "?").join(", ");
  const window = schedule.startTime ? `${schedule.startTime} → ${schedule.endTime ?? "?"}` : "";
  const interval = schedule.intervalMinutes && schedule.intervalMinutes > 0 ? ` · toutes les ${schedule.intervalMinutes} min` : "";
  return `${days || "—"} · ${window}${interval}`;
}

const STATUS_STYLE: Record<string, string> = {
  completed: "border-emerald-800 bg-emerald-950/50 text-emerald-300",
  running: "border-sky-800 bg-sky-950/50 text-sky-300",
  failed: "border-red-800 bg-red-950/50 text-red-300",
  paused: "border-neutral-700 bg-neutral-900 text-neutral-400",
};

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScheduleRunItem[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await authFetch("/api/agents/schedules");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Planifications indisponibles.");
      setSchedules((data.schedules ?? []) as ScheduleItem[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Planifications indisponibles.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggleEnabled = async (schedule: ScheduleItem) => {
    setBusyId(schedule.id);
    try {
      const response = await authFetch(`/api/agents/schedules/${schedule.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !schedule.enabled }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Mise à jour impossible.");
      setSchedules((current) => current.map((s) => (s.id === schedule.id ? { ...s, enabled: !s.enabled } : s)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mise à jour impossible.");
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (schedule: ScheduleItem) => {
    setBusyId(schedule.id);
    try {
      const response = await authFetch(`/api/agents/schedules/${schedule.id}/run`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Déclenchement impossible.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Déclenchement impossible.");
    } finally {
      setBusyId(null);
    }
  };

  const openRuns = async (schedule: ScheduleItem) => {
    if (expandedId === schedule.id) {
      setExpandedId(null);
      setRuns([]);
      return;
    }
    setExpandedId(schedule.id);
    setRunsLoading(true);
    try {
      const response = await authFetch(`/api/agents/schedules/${schedule.id}/runs`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Historique indisponible.");
      setRuns((data.runs ?? []) as ScheduleRunItem[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Historique indisponible.");
    } finally {
      setRunsLoading(false);
    }
  };

  const statusLabel = (schedule: ScheduleItem): { label: string; style: string } => {
    if (!schedule.enabled) return { label: "En pause", style: STATUS_STYLE.paused };
    if (schedule.retryState) return { label: `Relance programmée (tentative ${schedule.retryState.attempt})`, style: STATUS_STYLE.failed };
    if (schedule.lastExecutionStatus === "failed") return { label: "Dernier échec", style: STATUS_STYLE.failed };
    if (schedule.lastExecutionStatus === "running") return { label: "En cours", style: STATUS_STYLE.running };
    if (schedule.lastExecutionStatus === "completed") return { label: "Dernier succès", style: STATUS_STYLE.completed };
    return { label: "Active", style: STATUS_STYLE.running };
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <SectionHeader
        title="Planifications"
        description="Vos agents récurrents et ponctuels : fenêtres horaires, one-shot, veille et relances automatiques."
        action={
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-full border border-neutral-800 px-3 py-1.5 text-xs font-semibold text-neutral-300 transition hover:bg-neutral-900"
          >
            Rafraîchir
          </button>
        }
      />

      {error && (
        <p className="mt-4 rounded-lg border border-amber-900/60 bg-amber-950/40 p-3 text-xs text-amber-300" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <LoadingState label="Chargement des planifications…" />
      ) : schedules.length === 0 ? (
        <EmptyState
          icon="⏱"
          title="Aucune planification"
          description="Demandez à un agent en conversation : « tous les jours à 9 h, fais X » ou « le 12 mars à 15 h, prépare Y ». Les planifications apparaîtront ici."
        />
      ) : (
        <ul className="mt-6 space-y-3">
          {schedules.map((schedule) => {
            const status = statusLabel(schedule);
            return (
              <li key={schedule.id} className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={"rounded-full border px-2 py-0.5 text-[10px] font-semibold " + status.style}>{status.label}</span>
                  <h2 className="text-sm font-semibold text-neutral-100">{schedule.name}</h2>
                  <span className="text-[11px] text-neutral-500">{schedule.timezone}</span>
                  {schedule.catchUp && <span className="rounded-full border border-neutral-800 px-2 py-0.5 text-[10px] text-neutral-400">rattrapage</span>}
                </div>

                <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-neutral-400">{schedule.objective}</p>
                <p className="mt-1 text-[11px] text-neutral-500">{describeRecurrence(schedule)}</p>
                {schedule.nextRunAt && schedule.enabled && (
                  <p className="mt-1 text-[11px] text-neutral-500">
                    Prochaine exécution : {new Date(schedule.nextRunAt).toLocaleString("fr-FR")}
                  </p>
                )}
                {schedule.lastError && (
                  <p className="mt-1 line-clamp-2 text-[11px] text-red-400" title={schedule.lastError}>
                    {schedule.lastError}
                  </p>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void toggleEnabled(schedule)}
                    disabled={busyId === schedule.id}
                    className="rounded-full border border-neutral-800 px-3 py-1.5 text-[11px] font-semibold text-neutral-200 transition hover:bg-neutral-900 disabled:opacity-50"
                  >
                    {schedule.enabled ? "Mettre en pause" : "Reprendre"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void runNow(schedule)}
                    disabled={busyId === schedule.id || !schedule.enabled}
                    className="rounded-full bg-neutral-100 px-3 py-1.5 text-[11px] font-semibold text-black transition hover:bg-neutral-300 disabled:opacity-50"
                  >
                    Exécuter maintenant
                  </button>
                  <button
                    type="button"
                    onClick={() => void openRuns(schedule)}
                    className="rounded-full border border-neutral-800 px-3 py-1.5 text-[11px] font-semibold text-neutral-300 transition hover:bg-neutral-900"
                    aria-expanded={expandedId === schedule.id}
                  >
                    {expandedId === schedule.id ? "Masquer l'historique" : "Historique"}
                  </button>
                </div>

                {expandedId === schedule.id && (
                  <div className="mt-3 border-t border-neutral-900 pt-3">
                    {runsLoading ? (
                      <p className="text-[11px] text-neutral-500">Chargement de l&apos;historique…</p>
                    ) : runs.length === 0 ? (
                      <p className="text-[11px] text-neutral-500">Aucune exécution enregistrée.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {runs.map((run) => (
                          <li key={run.id} className="flex flex-wrap items-baseline gap-2 text-[11px]">
                            <span className={"rounded border px-1.5 py-0.5 font-semibold " + (STATUS_STYLE[run.status] ?? "border-neutral-800 text-neutral-400")}>
                              {run.status}
                            </span>
                            <span className="text-neutral-500">{run.slot}</span>
                            {run.startedAt && <span className="text-neutral-600">{new Date(run.startedAt).toLocaleString("fr-FR")}</span>}
                            {run.error && <span className="line-clamp-1 text-red-400" title={run.error}>{run.error}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
