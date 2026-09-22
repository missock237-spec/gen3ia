"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { ResourceList, type ResourceRow } from "@/components/shells/resource-list";
import { EmptyState, LoadingState, MetricCard } from "@/components/shells/states";
import { StatusBadge } from "@/components/shells/status-badge";

/**
 * /admin/observability — santé plateforme (admin uniquement) : exécutions
 * récentes, consommation IA et répartition des statuts.
 */

interface ExecutionEntry {
  id: string;
  userId: string | null;
  kind: string | null;
  status: string | null;
  createdAt: { _seconds?: number } | null;
}

function formatDate(value: { _seconds?: number } | null): string {
  const seconds = value?._seconds;
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function AdminObservabilityPage() {
  const [executions, setExecutions] = useState<ExecutionEntry[]>([]);
  const [usage, setUsage] = useState<{ requests: number; costMinor: number } | null>(null);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await authFetch("/api/admin/observability", { cache: "no-store" });
      const body = (await response.json()) as {
        executions?: ExecutionEntry[];
        usage?: { requests: number; costMinor: number };
        statusCounts?: Record<string, number>;
        error?: string;
      };
      if (response.status === 403) throw new Error("Accès réservé aux administrateurs.");
      if (!response.ok) throw new Error(body.error ?? "Chargement impossible.");
      setExecutions(body.executions ?? []);
      setUsage(body.usage ?? null);
      setStatusCounts(body.statusCounts ?? {});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Chargement impossible.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingState rows={5} label="Chargement de l'observabilité…" />;

  if (error) {
    return <div className="rounded-2xl border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-300" role="alert">{error}</div>;
  }

  const rows: ResourceRow[] = executions.map((execution) => ({
    id: execution.id,
    icon: "∿",
    title: execution.kind ?? "Exécution",
    meta: `Utilisateur ${execution.userId ?? "inconnu"} · ${formatDate(execution.createdAt)}`,
    action: (
      <StatusBadge
        status={execution.status === "success" ? "success" : execution.status === "failed" ? "danger" : execution.status ?? "neutral"}
        label={execution.status ?? "inconnu"}
      />
    ),
  }));

  return (
    <div className="space-y-7">
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard label="Exécutions récentes" value={executions.length} hint="40 plus récentes" />
        <MetricCard label="Requêtes IA (échantillon)" value={usage?.requests ?? "—"} hint="200 derniers usages" />
        <MetricCard
          label="Coût agrégé"
          value={usage ? `${(usage.costMinor / 100).toFixed(2)} €` : "—"}
          hint="Estimation sur l'échantillon"
        />
      </div>

      {Object.keys(statusCounts).length > 0 && (
        <section aria-label="Répartition des statuts" className="rounded-3xl border border-white/10 bg-white/5 p-6">
          <h2 className="text-lg font-bold text-neutral-100">Statuts récents</h2>
          <div className="mt-4 flex flex-wrap gap-2">
            {Object.entries(statusCounts).map(([status, count]) => (
              <span key={status} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-neutral-900/50 px-3 py-1.5 text-xs text-neutral-300">
                <StatusBadge status={status} />
                <span className="font-semibold text-neutral-100">{count}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      <section aria-label="Exécutions">
        <h2 className="mb-3 text-lg font-bold text-neutral-100">Exécutions de la plateforme</h2>
        <ResourceList
          rows={rows}
          ariaLabel="Exécutions récentes"
          emptyState={<EmptyState icon="∿" title="Aucune exécution enregistrée" description="Les runs d'agents et d'extensions apparaîtront ici." />}
          className="[&_li]:border-white/10 [&_li]:bg-white/5 [&_li_*.text-neutral-800]:text-neutral-100"
        />
      </section>
    </div>
  );
}
