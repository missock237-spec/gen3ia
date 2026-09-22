"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { ResourceList, type ResourceRow } from "@/components/shells/resource-list";
import { EmptyState, LoadingState, MetricCard } from "@/components/shells/states";
import { StatusBadge } from "@/components/shells/status-badge";

/**
 * /admin/security — journal d'audit et accès sensibles (admin uniquement).
 */

interface AuditEntry {
  id: string;
  userId: string | null;
  toolId: string | null;
  status: string | null;
  executionId: string | null;
  createdAt: { _seconds?: number } | null;
}

interface CameraRequest {
  id: string;
  userId: string | null;
  status: string | null;
  createdAt: { _seconds?: number } | null;
}

function formatDate(value: { _seconds?: number } | null): string {
  const seconds = value?._seconds;
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function AdminSecurityPage() {
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [camera, setCamera] = useState<CameraRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await authFetch("/api/admin/security", { cache: "no-store" });
      const body = (await response.json()) as { audit?: AuditEntry[]; cameraRequests?: CameraRequest[]; error?: string };
      if (response.status === 403) throw new Error("Accès réservé aux administrateurs.");
      if (!response.ok) throw new Error(body.error ?? "Chargement impossible.");
      setAudit(body.audit ?? []);
      setCamera(body.cameraRequests ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Chargement impossible.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingState rows={5} label="Chargement du journal d'audit…" />;

  if (error) {
    return <div className="rounded-2xl border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-300" role="alert">{error}</div>;
  }

  const failures = audit.filter((entry) => entry.status && entry.status !== "success").length;

  const auditRows: ResourceRow[] = audit.map((entry) => ({
    id: entry.id,
    icon: "⚖",
    title: entry.toolId ?? "Outil inconnu",
    meta: `Utilisateur ${entry.userId ?? "inconnu"} · ${formatDate(entry.createdAt)}`,
    detail: entry.executionId ? <span className="font-mono text-[10px]">exec {entry.executionId.slice(0, 8)}…</span> : undefined,
    action: (
      <StatusBadge
        status={entry.status === "success" ? "success" : entry.status ? "danger" : "neutral"}
        label={entry.status ?? "inconnu"}
      />
    ),
  }));

  const cameraRows: ResourceRow[] = camera.map((request) => ({
    id: request.id,
    icon: "◉",
    title: "Demande d'accès caméra",
    meta: `Utilisateur ${request.userId ?? "inconnu"} · ${formatDate(request.createdAt)}`,
    action: <StatusBadge status={request.status === "approved" ? "success" : "warning"} label={request.status ?? "en attente"} />,
  }));

  return (
    <div className="space-y-7">
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard label="Entrées d'audit" value={audit.length} hint="80 plus récentes" />
        <MetricCard label="Résultats non succès" value={failures} hint="À examiner" />
        <MetricCard label="Demandes caméra" value={camera.length} hint="Accès device agents" />
      </div>

      <section aria-label="Journal d'audit">
        <h2 className="mb-3 text-lg font-bold text-neutral-100">Exécutions d&apos;outils des agents</h2>
        <ResourceList
          rows={auditRows}
          ariaLabel="Journal d'audit"
          emptyState={<EmptyState icon="⚖" title="Aucune entrée d'audit" description="Les exécutions d'outils sensibles apparaîtront ici." />}
          className="[&_li]:border-white/10 [&_li]:bg-white/5 [&_li_*.text-neutral-800]:text-neutral-100"
        />
      </section>

      {cameraRows.length > 0 && (
        <section aria-label="Demandes caméra">
          <h2 className="mb-3 text-lg font-bold text-neutral-100">Demandes d&apos;accès caméra</h2>
          <ResourceList rows={cameraRows} ariaLabel="Demandes caméra" className="[&_li]:border-white/10 [&_li]:bg-white/5 [&_li_*.text-neutral-800]:text-neutral-100" />
        </section>
      )}
    </div>
  );
}
