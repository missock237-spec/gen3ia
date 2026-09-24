"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { SectionHeader } from "@/components/shells/section-header";
import { ResourceList, type ResourceRow } from "@/components/shells/resource-list";
import { EmptyState, LoadingState, MetricCard } from "@/components/shells/states";
import { PermissionNotice } from "@/components/shells/permission-notice";
import { authFetch } from "@/lib/firebase/auth-client";

/**
 * /studio/results — Résultats de l'espace utilisateur : fichiers, rapports,
 * images et livrables générés par les missions, plus les missions terminées.
 */

interface PermanentFile {
  path: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  uploadedAt: string;
  source: string;
}

interface StorageUsage {
  usedBytes?: number;
  quotaBytes?: number;
  fileCount?: number;
}

interface CompletedMission {
  id: string;
  objective: string;
  status: string;
  updatedAt: number;
  completedAt?: number;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 o";
  const units = ["o", "Ko", "Mo", "Go"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function fileIcon(contentType: string): string {
  if (contentType.startsWith("image/")) return "🖼";
  if (contentType.startsWith("video/")) return "▶";
  if (contentType.startsWith("audio/")) return "♪";
  if (contentType.includes("pdf")) return "▤";
  if (contentType.includes("zip") || contentType.includes("tar")) return "▣";
  if (contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml")) return "≡";
  return "▢";
}

function formatDate(value: string | number): string {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}

export default function ResultsPage() {
  const [files, setFiles] = useState<PermanentFile[]>([]);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [missions, setMissions] = useState<CompletedMission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [unauthenticated, setUnauthenticated] = useState(false);
  const [busyPath, setBusyPath] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setUnauthenticated(false);
    try {
      const [storageResponse, tasksResponse] = await Promise.allSettled([
        authFetch("/api/storage/permanent", { cache: "no-store" }),
        authFetch("/api/workspace/tasks?limit=30", { cache: "no-store" }),
      ]);
      if (storageResponse.status === "fulfilled") {
        const response = storageResponse.value;
        if (response.status === 401) setUnauthenticated(true);
        else if (response.ok) {
          const data = (await response.json()) as { files?: PermanentFile[]; usage?: StorageUsage };
          setFiles(data.files ?? []);
          setUsage(data.usage ?? null);
        }
      }
      if (tasksResponse.status === "fulfilled" && tasksResponse.value.ok) {
        const data = (await tasksResponse.value.json()) as { tasks?: CompletedMission[] };
        setMissions((data.tasks ?? []).filter((task) => ["completed", "failed", "cancelled"].includes(task.status)));
      }
      if (storageResponse.status === "rejected") throw new Error("Le stockage est momentanément indisponible.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Impossible de charger vos résultats.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const download = async (path: string) => {
    setBusyPath(path);
    try {
      const response = await authFetch(`/api/storage/permanent?path=${encodeURIComponent(path)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Téléchargement impossible.");
      const data = (await response.json()) as { url?: string };
      if (data.url) window.open(data.url, "_blank", "noopener,noreferrer");
    } catch {
      /* silencieux : le navigateur n'ouvre rien en cas d'échec */
    } finally {
      setBusyPath("");
    }
  };

  const fileRows: ResourceRow[] = useMemo(
    () =>
      files.map((file) => ({
        id: file.path,
        icon: fileIcon(file.contentType),
        title: file.filename,
        meta: `${formatBytes(file.sizeBytes)} · ${formatDate(file.uploadedAt)} · ${file.contentType.split("/")[1] ?? file.contentType}`,
        action: (
          <button
            type="button"
            onClick={() => void download(file.path)}
            disabled={busyPath === file.path}
            className="rounded-full border border-[var(--g3-border-strong)] bg-[var(--g3-surface)] px-3.5 py-1.5 text-xs font-semibold text-[var(--g3-text-secondary)] transition hover:border-[var(--g3-border)] hover:text-[var(--g3-text)] disabled:opacity-50"
          >
            {busyPath === file.path ? "…" : "Télécharger"}
          </button>
        ),
      })),
    [files, busyPath],
  );

  const missionRows: ResourceRow[] = useMemo(
    () =>
      missions.map((mission) => ({
        id: mission.id,
        href: `/studio?taskId=${encodeURIComponent(mission.id)}`,
        title: mission.objective.length > 100 ? `${mission.objective.slice(0, 100)}…` : mission.objective,
        meta: `Terminée le ${formatDate(mission.completedAt ?? mission.updatedAt)}`,
        status: mission.status,
      })),
    [missions],
  );

  const totalBytes = files.reduce((sum, file) => sum + (file.sizeBytes || 0), 0);

  return (
    <div className="space-y-7">
      <SectionHeader
        eyebrow="ESPACE DE TRAVAIL / RÉSULTATS"
        title="Résultats"
        description="Tous les livrables générés par vos missions : fichiers, rapports, images et documents, regroupés au même endroit."
        breadcrumbs={[{ label: "Missions", href: "/studio" }, { label: "Résultats" }]}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard label="Livrables" value={files.length} hint="Fichiers stockés" />
        <MetricCard label="Volume" value={formatBytes(totalBytes)} hint={usage?.quotaBytes ? `Quota ${formatBytes(usage.quotaBytes)}` : "Stockage permanent"} />
        <MetricCard label="Missions closes" value={missions.length} hint="Historique récent" />
      </div>

      {error && (
        <PermissionNotice
          tone="danger"
          title="Chargement impossible"
          description={error}
          actions={
            <button type="button" onClick={() => void load()} className="rounded-full border border-[var(--g3-border-strong)] bg-[var(--g3-surface)] px-4 py-2 text-xs font-semibold">
              Réessayer
            </button>
          }
        />
      )}

      {unauthenticated && (
        <PermissionNotice
          tone="info"
          title="Connectez-vous pour retrouver vos livrables"
          actions={
            <Link href="/login" className="rounded-full bg-[var(--g3-deep)] px-4 py-2 text-xs font-semibold text-white">
              Se connecter
            </Link>
          }
        />
      )}

      {loading && <LoadingState rows={4} />}

      {!loading && (
        <>
          <section aria-label="Fichiers et livrables">
            <h2 className="mb-3 font-serif text-lg font-semibold text-[var(--g3-text)]">Fichiers & livrables</h2>
            <ResourceList
              rows={fileRows}
              ariaLabel="Fichiers générés"
              emptyState={
                <EmptyState
                  icon="▣"
                  title="Aucun livrable pour le moment"
                  description="Les fichiers générés par vos missions apparaissent ici automatiquement."
                  action={
                    <Link href="/studio/create" className="g3-btn g3-btn-primary text-xs">
                      Lancer une mission
                    </Link>
                  }
                />
              }
            />
          </section>

          <section aria-label="Missions terminées">
            <h2 className="mb-3 font-serif text-lg font-semibold text-[var(--g3-text)]">Missions closes</h2>
            <ResourceList
              rows={missionRows}
              ariaLabel="Missions terminées"
              emptyState={<EmptyState icon="◈" title="Aucune mission terminée récemment" description="Les missions achevées restent consultables ici avec leurs livrables." />}
            />
          </section>
        </>
      )}
    </div>
  );
}
