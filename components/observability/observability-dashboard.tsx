"use client";

import { useState } from "react";

/**
 * Tableau de bord d'observabilité des agents :
 *  - KPI : exécutions, taux de succès, coûts, tokens, durée moyenne ;
 *  - tendance quotidienne et usage des outils (échecs inclus) ;
 *  - journal des traces : chaque exécution est dépliable (étapes, erreurs) ;
 *  - alertes automatiques (échecs répétés, dépense inhabituelle).
 */

export interface ObservabilityOverviewView {
  windowDays: number;
  totals: {
    executions: number;
    completed: number;
    failed: number;
    running: number;
    waitingApproval: number;
    successRate: number;
    chargeMinor: number;
    currency: string;
    providerCostEur: number;
    inputTokens: number;
    outputTokens: number;
    avgDurationMs: number;
  };
  daily: Array<{ date: string; count: number; failed: number }>;
  tools: Array<{ name: string; count: number; failed: number }>;
  alerts: Array<{ level: string; message: string; createdAt: string }>;
  executions: Array<{
    id: string;
    objective: string;
    status: string;
    createdAt: string;
    completedAt?: string;
    durationMs?: number;
    chargeMinor: number;
    currency: string;
    providerCostEur: number;
    inputTokens: number;
    outputTokens: number;
    stepCount: number;
    failedSteps: number;
    toolCounts: Record<string, number>;
    error?: string;
  }>;
}

const STATUS_STYLES: Record<string, string> = {
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  failed: "bg-red-50 text-red-700 border-red-200",
  running: "bg-sky-50 text-sky-700 border-sky-200",
  pending: "bg-sky-50 text-sky-700 border-sky-200",
  waiting_approval: "bg-amber-50 text-amber-700 border-amber-200",
  cancelled: "bg-neutral-100 text-neutral-500 border-neutral-200",
};

const STATUS_LABELS: Record<string, string> = {
  completed: "Terminée",
  failed: "Échouée",
  running: "En cours",
  pending: "En file",
  waiting_approval: "À approuver",
  cancelled: "Annulée",
};

function formatCharge(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return "—";
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1_000)} s`;
}

function formatDate(value: string): string {
  if (!value) return "—";
  return value.replace("T", " ").slice(0, 16);
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{label}</p>
      <p className="mt-1 font-serif text-2xl font-semibold text-neutral-900">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-neutral-400">{hint}</p> : null}
    </div>
  );
}

export function ObservabilityDashboard({ overview }: { overview: ObservabilityOverviewView }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { totals, daily, tools, alerts, executions } = overview;
  const maxDaily = Math.max(1, ...daily.map((bucket) => bucket.count));
  const maxTool = Math.max(1, ...tools.map((tool) => tool.count));

  return (
    <div className="space-y-5">
      {/* Alertes */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((alert, index) => (
            <div
              key={index}
              role="status"
              className={`flex items-start gap-2.5 rounded-2xl border px-4 py-3 text-sm ${alert.level === "critical" ? "border-red-200 bg-red-50 text-red-700" : "border-amber-200 bg-amber-50 text-amber-800"}`}
            >
              <span aria-hidden="true">{alert.level === "critical" ? "🚨" : "⚠️"}</span>
              <span>{alert.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* KPI */}
      <section aria-label="Indicateurs clés" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Exécutions" value={String(totals.executions)} hint={`${totals.running} en cours · ${totals.waitingApproval} à approuver`} />
        <Kpi label="Taux de succès" value={`${totals.successRate}%`} hint={`${totals.completed} terminées · ${totals.failed} échouées`} />
        <Kpi label="Coût facturé" value={formatCharge(totals.chargeMinor, totals.currency)} hint={`coût fournisseurs : €${totals.providerCostEur.toFixed(4)}`} />
        <Kpi label="Tokens LLM" value={`${((totals.inputTokens + totals.outputTokens) / 1000).toFixed(1)}k`} hint={`entrée ${totals.inputTokens} · sortie ${totals.outputTokens}`} />
        <div className="col-span-2 lg:col-span-4">
          <Kpi label="Durée moyenne" value={formatDuration(totals.avgDurationMs)} hint="moyenne sur les exécutions terminées de la fenêtre" />
        </div>
      </section>

      {/* Tendance quotidienne */}
      <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold sm:text-base">Activité quotidienne ({overview.windowDays} jours)</h2>
        {daily.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">Aucune exécution sur la fenêtre. Lancez une mission depuis le Studio pour alimenter les traces.</p>
        ) : (
          <div className="mt-4 flex items-end gap-1.5" aria-hidden="true">
            {daily.map((bucket) => (
              <div key={bucket.date} className="group relative flex-1">
                <div className="flex h-24 items-end">
                  <div
                    className={`w-full rounded-t-md ${bucket.failed > 0 ? "bg-red-400" : "bg-neutral-300"} transition-colors group-hover:bg-neutral-900`}
                    style={{ height: `${Math.max(6, (bucket.count / maxDaily) * 100)}%` }}
                  />
                </div>
                <p className="mt-1 truncate text-center text-[9px] text-neutral-400">{bucket.date.slice(5)}</p>
                <span className="pointer-events-none absolute -top-7 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-neutral-900 px-2 py-1 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                  {bucket.count} exéc. · {bucket.failed} échec(s)
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Usage des outils */}
      {tools.length > 0 && (
        <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold sm:text-base">Outils les plus utilisés</h2>
          <ul className="mt-4 space-y-2.5">
            {tools.map((tool) => (
              <li key={tool.name} className="flex items-center gap-3">
                <span className="w-40 shrink-0 truncate text-xs font-semibold text-neutral-700" title={tool.name}>{tool.name}</span>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-neutral-100">
                  <div className={`h-full rounded-full ${tool.failed > 0 ? "bg-amber-500" : "bg-neutral-900"}`} style={{ width: `${Math.max(4, (tool.count / maxTool) * 100)}%` }} />
                </div>
                <span className="w-24 shrink-0 text-right text-xs text-neutral-500">
                  {tool.count} appel{tool.count > 1 ? "s" : ""}{tool.failed > 0 ? ` · ${tool.failed} échec(s)` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Journal des traces */}
      <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold sm:text-base">Journal des exécutions</h2>
        <p className="mt-1 text-xs text-neutral-400">Chaque ligne est dépliable : objectif, statut, coût, tokens, étapes et erreurs — le journal des décisions de vos agents.</p>
        {executions.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">Aucune exécution enregistrée sur la fenêtre.</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {executions.map((execution) => {
              const expanded = expandedId === execution.id;
              return (
                <li key={execution.id} className="rounded-xl border border-neutral-200">
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : execution.id)}
                    aria-expanded={expanded}
                    className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left"
                  >
                    <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATUS_STYLES[execution.status] ?? STATUS_STYLES.cancelled}`}>
                      {STATUS_LABELS[execution.status] ?? execution.status}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-neutral-700">{execution.objective}</span>
                    <span className="text-xs text-neutral-400">{formatDate(execution.createdAt)}</span>
                    <span aria-hidden="true" className="text-xs text-neutral-400">{expanded ? "▲" : "▼"}</span>
                  </button>
                  {expanded && (
                    <div className="anim-fade-in border-t border-neutral-100 px-4 py-3 text-sm">
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-neutral-600 sm:grid-cols-4">
                        <div><dt className="text-neutral-400">Coût facturé</dt><dd className="font-semibold">{formatCharge(execution.chargeMinor, execution.currency)}</dd></div>
                        <div><dt className="text-neutral-400">Coût fournisseurs</dt><dd className="font-semibold">€{execution.providerCostEur.toFixed(4)}</dd></div>
                        <div><dt className="text-neutral-400">Tokens</dt><dd className="font-semibold">{execution.inputTokens} → {execution.outputTokens}</dd></div>
                        <div><dt className="text-neutral-400">Durée</dt><dd className="font-semibold">{formatDuration(execution.durationMs)}</dd></div>
                        <div><dt className="text-neutral-400">Étapes du plan</dt><dd className="font-semibold">{execution.stepCount}{execution.failedSteps > 0 ? ` (${execution.failedSteps} en échec)` : ""}</dd></div>
                        <div className="col-span-2 sm:col-span-3"><dt className="text-neutral-400">Outils appelés</dt><dd className="font-semibold">{Object.keys(execution.toolCounts).length > 0 ? Object.entries(execution.toolCounts).map(([name, count]) => `${name} ×${count}`).join(", ") : "aucun"}</dd></div>
                      </dl>
                      {execution.error ? (
                        <p className="mt-2.5 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">Erreur : {execution.error}</p>
                      ) : null}
                      <p className="mt-2.5 text-[11px] text-neutral-400">Trace {execution.id} · fin {formatDate(execution.completedAt ?? "")}</p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
