"use client";

import { useState } from "react";

import { DAYS, type Schedule, type ScheduleRun } from "@/components/studio/schedule-types";

/**
 * Carte d'une planification existante (extrait de app/studio/schedules/page.tsx).
 * Remplace l'ancien JSX condensé sur une ligne par une structure lisible,
 * avec statut d'exécution, historique dépliable et actions accessibles.
 * Les plans « toujours actifs » affichent leur webhook (URL copiable) ou
 * leurs sources de veille + une vérification manuelle.
 */
export function ScheduleCard({
  schedule,
  busy,
  history,
  onRun,
  onToggle,
  onRemove,
  onLoadHistory,
  onCheckWatch,
}: {
  schedule: Schedule;
  busy: boolean;
  history?: ScheduleRun[];
  onRun: (schedule: Schedule) => void;
  onToggle: (schedule: Schedule) => void;
  onRemove: (schedule: Schedule) => void;
  onLoadHistory: (schedule: Schedule) => void;
  onCheckWatch?: (schedule: Schedule) => void;
}) {
  const [webhookCopied, setWebhookCopied] = useState(false);
  const dayLabels = DAYS.filter(([value]) => (schedule.daysOfWeek ?? []).includes(value)).map(([, label]) => label);
  const webhookUrl = schedule.alwaysOnWebhookToken
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/api/webhooks/agent-triggers/${schedule.alwaysOnWebhookToken}`
    : null;
  const isAlwaysOn = Boolean(schedule.alwaysOnWebhookToken) || (schedule.watchSources?.length ?? 0) > 0;

  const copyWebhook = async () => {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setWebhookCopied(true);
      window.setTimeout(() => setWebhookCopied(false), 2_000);
    } catch {
      /* presse-papiers indisponible : l'URL reste sélectionnable */
    }
  };

  return (
    <article className="rounded-2xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-elevated)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">{schedule.name}</h3>
          <p className="mt-1 truncate text-xs text-[var(--g3-faint)]">{schedule.agentId}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase ${schedule.enabled ? "bg-emerald-100 text-emerald-600" : "bg-[var(--g3-elevated)]/70 text-[var(--g3-muted)]"}`}>
            {schedule.enabled ? "active" : "pause"}
          </span>
          {isAlwaysOn ? (
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-violet-700">toujours actif</span>
          ) : null}
        </div>
      </div>

      <p className="mt-3 line-clamp-2 text-sm leading-6 text-[var(--g3-muted)]">{schedule.objective}</p>

      <div className="mt-3 text-xs text-[var(--g3-muted)]">
        {schedule.startTime ? (
          <>{dayLabels.join(" · ")} · {schedule.startTime} → {schedule.endTime}</>
        ) : schedule.alwaysOnWebhookToken ? (
          <>Déclencheur : webhook externe (aucune fenêtre horaire)</>
        ) : (
          <>Déclencheur : veille sur {(schedule.watchSources?.length ?? 0)} source(s)</>
        )}
      </div>
      <div className="mt-1 text-xs text-[var(--g3-faint)]">
        {schedule.timezone}
        {schedule.intervalMinutes ? ` · toutes les ${schedule.intervalMinutes} min` : schedule.startTime ? " · au début de la fenêtre" : ""}
        {schedule.nextRunAt ? ` · prochaine : ${new Date(schedule.nextRunAt).toLocaleString()}` : ""}
      </div>

      {webhookUrl ? (
        <div className="mt-3 rounded-xl border border-violet-200 bg-violet-50 p-2.5">
          <p className="text-[10px] font-bold uppercase tracking-wide text-violet-700">URL du webhook entrant — gardez-la secrète</p>
          <div className="mt-1 flex items-center gap-2">
            <input readOnly value={webhookUrl} onFocus={(e) => e.currentTarget.select()} aria-label="URL du webhook de déclenchement" className="min-w-0 flex-1 rounded-lg border border-violet-200 bg-[var(--g3-surface)] px-2 py-1.5 text-[11px] text-[var(--g3-muted)]" />
            <button type="button" onClick={() => void copyWebhook()} className="shrink-0 rounded-lg bg-violet-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-violet-700">
              {webhookCopied ? "Copié ✓" : "Copier"}
            </button>
          </div>
        </div>
      ) : null}

      {(schedule.watchSources?.length ?? 0) > 0 ? (
        <ul className="mt-3 space-y-1">
          {schedule.watchSources!.map((source) => (
            <li key={source.id} className="flex items-center gap-2 text-xs text-[var(--g3-muted)]">
              <span className="rounded-full border border-[var(--g3-border)] bg-[var(--g3-surface)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--g3-muted)]">{source.type}</span>
              <span className="truncate">{source.label || source.url}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-2 text-xs">
        {schedule.lastExecutionStatus === "running" ? (
          <span className="text-amber-600">Exécution en cours…</span>
        ) : schedule.lastExecutionStatus ? (
          <span className={schedule.lastExecutionStatus === "completed" ? "text-emerald-600" : "text-red-600"}>
            Dernière exécution : {schedule.lastExecutionStatus}
            {schedule.lastExecutionAt ? ` · ${new Date(schedule.lastExecutionAt).toLocaleString()}` : ""}
          </span>
        ) : (
          <span className="text-[var(--g3-faint)]">Aucune exécution</span>
        )}
      </div>

      {schedule.lastError && (
        <div className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-600">{schedule.lastError}</div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button disabled={busy} onClick={() => onRun(schedule)} className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-700 hover:bg-sky-100">
          Exécuter maintenant
        </button>
        {(schedule.watchSources?.length ?? 0) > 0 && onCheckWatch ? (
          <button disabled={busy} onClick={() => onCheckWatch(schedule)} className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-700 hover:bg-violet-100">
            Vérifier la veille
          </button>
        ) : null}
        <button disabled={busy} onClick={() => onLoadHistory(schedule)} className="rounded-lg border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] px-3 py-2 text-xs hover:bg-[var(--g3-elevated)]">
          Historique
        </button>
        <button disabled={busy} onClick={() => onToggle(schedule)} className="rounded-lg border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] px-3 py-2 text-xs hover:bg-[var(--g3-elevated)]">
          {schedule.enabled ? "Mettre en pause" : "Activer"}
        </button>
        <button disabled={busy} onClick={() => onRemove(schedule)} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 hover:bg-red-100">
          Supprimer
        </button>
      </div>

      {history && (
        <div className="mt-3 space-y-1 rounded-xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-3">
          {history.length === 0 ? (
            <div className="text-xs text-[var(--g3-faint)]">Aucune exécution.</div>
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
