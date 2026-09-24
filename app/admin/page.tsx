"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { MetricCard, LoadingState } from "@/components/shells/states";
import { StatusBadge } from "@/components/shells/status-badge";

/**
 * /admin — Vue plateforme : indicateurs globaux des trois espaces.
 */

interface PlatformMetrics {
  metrics: Record<string, number>;
  taskStatusCounts: Record<string, number>;
  generatedAt: number;
}

const METRIC_LABELS: Array<[string, string, string]> = [
  ["users", "Utilisateurs", "Comptes créés"],
  ["teams", "Équipes", "Espaces partagés"],
  ["tasks", "Missions", "Tâches workspace"],
  ["agents", "Agents", "Agents personnalisés"],
  ["extensions", "Extensions", "Catalogue Marketplace"],
  ["installations", "Installations", "Extensions installées"],
  ["executions", "Exécutions", "Runs enregistrés"],
  ["memories", "Mémoires", "Souvenirs permanents"],
];

export default function AdminPlatformPage() {
  const [data, setData] = useState<PlatformMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await authFetch("/api/admin/platform", { cache: "no-store" });
      const body = (await response.json()) as PlatformMetrics & { error?: string };
      if (response.status === 403) throw new Error("Accès réservé aux administrateurs.");
      if (!response.ok) throw new Error(body.error ?? "Chargement impossible.");
      setData(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Chargement impossible.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingState rows={4} label="Chargement des indicateurs…" />;

  if (error) {
    return <div className="rounded-2xl border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-300" role="alert">{error}</div>;
  }

  return (
    <div className="space-y-7">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {METRIC_LABELS.map(([key, label, hint]) => (
          <MetricCard
            key={key}
            label={label}
            value={data?.metrics[key] !== undefined && data.metrics[key] >= 0 ? data.metrics[key] : "—"}
            hint={hint}
          />
        ))}
      </div>

      <section aria-label="Missions par statut" className="rounded-3xl border border-white/10 bg-[var(--g3-surface)]/5 p-6">
        <h2 className="text-lg font-bold text-[var(--g3-text-secondary)]">Missions par statut</h2>
        <p className="mt-1 text-xs text-[var(--g3-faint)]">Répartition des 500 missions les plus récentes.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {data && Object.entries(data.taskStatusCounts).length > 0 ? (
            Object.entries(data.taskStatusCounts).map(([status, count]) => (
              <span key={status} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-[var(--g3-deep)]/50 px-3 py-1.5 text-xs text-[var(--g3-faint)]">
                <StatusBadge status={status} />
                <span className="font-semibold text-[var(--g3-text-secondary)]">{count}</span>
              </span>
            ))
          ) : (
            <span className="text-sm text-[var(--g3-faint)]">Aucune mission enregistrée.</span>
          )}
        </div>
      </section>
    </div>
  );
}
