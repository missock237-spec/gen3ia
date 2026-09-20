"use client";

import { DAYS, type Schedule, type ScheduleRun } from "@/components/studio/schedule-types";

/**
 * Carte d'une planification existante (extrait de app/studio/schedules/page.tsx).
 * Remplace l'ancien JSX condensé sur une ligne par une structure lisible,
 * avec statut d'exécution, historique dépliable et actions accessibles.
 */
export function ScheduleCard({
  schedule,
  busy,
  history,
  onRun,
  onToggle,
  onRemove,
  onLoadHistory,
}: {
  schedule: Schedule;
  busy: boolean;
  history?: ScheduleRun[];
  onRun: (schedule: Schedule) => void;
  onToggle: (schedule: Schedule) => void;
  onRemove: (schedule: Schedule) => void;
  onLoadHistory: (schedule: Schedule) => void;
}) {
  const dayLabels = DAYS.filter(([value]) => schedule.daysOfWeek.includes(value)).map(([, label]) => label);

  return (
    <article className="rounded-2xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">{schedule.name}</h3>
          <p className="mt-1 truncate text-xs text-neutral-400">{schedule.agentId}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold uppercase ${schedule.enabled ? "bg-emerald-100 text-emerald-600" : "bg-neutral-200/70 text-neutral-500"}`}>
          {schedule.enabled ? "active" : "pause"}
        </span>
      </div>

      <p className="mt-3 line-clamp-2 text-sm leading-6 text-neutral-500">{schedule.objective}</p>

      <div className="mt-3 text-xs text-neutral-500">
        {dayLabels.join(" · ")} · {schedule.startTime} → {schedule.endTime}
      </div>
      <div className="mt-1 text-xs text-neutral-400">
        {schedule.timezone}
        {schedule.intervalMinutes ? ` · toutes les ${schedule.intervalMinutes} min` : " · au début de la fenêtre"}
        {schedule.nextRunAt ? ` · prochaine : ${new Date(schedule.nextRunAt).toLocaleString()}` : ""}
      </div>

      <div className="mt-2 text-xs">
        {schedule.lastExecutionStatus === "running" ? (
          <span className="text-amber-600">Exécution en cours…</span>
        ) : schedule.lastExecutionStatus ? (
          <span className={schedule.lastExecutionStatus === "completed" ? "text-emerald-600" : "text-red-600"}>
            Dernière exécution : {schedule.lastExecutionStatus}
            {schedule.lastExecutionAt ? ` · ${new Date(schedule.lastExecutionAt).toLocaleString()}` : ""}
          </span>
        ) : (
          <span className="text-neutral-400">Aucune exécution</span>
        )}
      </div>

      {schedule.lastError && (
        <div className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-600">{schedule.lastError}</div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button disabled={busy} onClick={() => onRun(schedule)} className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-700 hover:bg-sky-100">
          Exécuter maintenant
        </button>
        <button disabled={busy} onClick={() => onLoadHistory(schedule)} className="rounded-lg border border-[rgba(23,23,20,0.09)] bg-white px-3 py-2 text-xs hover:bg-neutral-100">
          Historique
        </button>
        <button disabled={busy} onClick={() => onToggle(schedule)} className="rounded-lg border border-[rgba(23,23,20,0.09)] bg-white px-3 py-2 text-xs hover:bg-neutral-100">
          {schedule.enabled ? "Mettre en pause" : "Activer"}
        </button>
        <button disabled={busy} onClick={() => onRemove(schedule)} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 hover:bg-red-100">
          Supprimer
        </button>
      </div>

      {history && (
        <div className="mt-3 space-y-1 rounded-xl border border-[rgba(23,23,20,0.09)] bg-white p-3">
          {history.length === 0 ? (
            <div className="text-xs text-neutral-400">Aucune exécution.</div>
          ) : (
            history.map((run) => (
              <div key={run.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate">
                  {run.status}
                  {run.startedAt ? ` · ${new Date(run.startedAt).toLocaleString()}` : ""}
                </span>
                {run.error && <span className="truncate text-red-600">{run.error}</span>}
              </div>
            ))
          )}
        </div>
      )}
    </article>
  );
}
