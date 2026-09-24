"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { MissionComposer } from "@/components/workspace/mission-composer";
import { SectionHeader } from "@/components/shells/section-header";
import { ResourceList, type ResourceRow } from "@/components/shells/resource-list";
import { StatusBadge } from "@/components/shells/status-badge";
import { EmptyState, LoadingState } from "@/components/shells/states";
import { PermissionNotice } from "@/components/shells/permission-notice";
import { authFetch } from "@/lib/firebase/auth-client";

/**
 * /studio — Missions : centre de gravité de l'espace utilisateur.
 * L'utilisateur décrit un objectif dans le composer global ; Gen3ia crée une
 * mission (plan + étapes + validations). Les missions sont regroupées par
 * statut : à valider, en cours, brouillons, historique.
 */

interface MissionSummary {
  id: string;
  objective: string;
  status: string;
  updatedAt: number;
  createdAt: number;
}

const GROUPS: Array<{ id: string; title: string; description: string; statuses: string[] }> = [
  { id: "validation", title: "À valider", description: "Missions qui attendent votre feu vert.", statuses: ["awaiting_approval"] },
  { id: "active", title: "En cours", description: "Missions validées en cours d'exécution.", statuses: ["approved", "running", "paused"] },
  { id: "drafts", title: "Brouillons", description: "Missions en préparation, non soumises.", statuses: ["draft"] },
  { id: "history", title: "Historique", description: "Missions terminées, échouées ou annulées.", statuses: ["completed", "failed", "cancelled"] },
];

function relativeDate(ms: number): string {
  const diff = Date.now() - ms;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `il y a ${days} j`;
  return new Date(ms).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

export default function MissionsPage() {
  const [mounted, setMounted] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [unauthenticated, setUnauthenticated] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setTaskId(params.get("taskId") ?? "");
    setMounted(true);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setUnauthenticated(false);
    try {
      const response = await authFetch("/api/workspace/tasks?limit=40", { cache: "no-store" });
      if (response.status === 401) {
        setUnauthenticated(true);
        return;
      }
      if (!response.ok) throw new Error("Impossible de charger vos missions pour le moment.");
      const data = (await response.json()) as { tasks?: MissionSummary[] };
      setMissions(data.tasks ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Impossible de charger vos missions.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const byGroup = new Map<string, MissionSummary[]>();
    for (const group of GROUPS) byGroup.set(group.id, []);
    for (const mission of missions) {
      const group = GROUPS.find((candidate) => candidate.statuses.includes(mission.status));
      byGroup.get(group?.id ?? "history")!.push(mission);
    }
    return byGroup;
  }, [missions]);

  const rowsFor = (items: MissionSummary[]): ResourceRow[] =>
    items.map((mission) => ({
      id: mission.id,
      href: `/studio?taskId=${encodeURIComponent(mission.id)}`,
      title: mission.objective.length > 110 ? `${mission.objective.slice(0, 110)}…` : mission.objective,
      meta: `Mise à jour ${relativeDate(mission.updatedAt)}`,
      status: mission.status,
    }));

  // Vue détaillée d'une mission (plan, étapes, validations)
  if (mounted && taskId) {
    return (
      <div className="space-y-5">
        <SectionHeader
          eyebrow="ESPACE DE TRAVAIL / MISSIONS"
          title="Mission"
          description="Plan en étapes, exécution et validations. Chaque changement d'état est historisé."
          breadcrumbs={[{ label: "Missions", href: "/studio" }, { label: "Détail" }]}
          action={
            <Link href="/studio" className="g3-btn g3-btn-ghost text-xs">
              ← Toutes les missions
            </Link>
          }
        />
        <LazyTaskPanel taskId={taskId} />
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <SectionHeader
        eyebrow="ESPACE DE TRAVAIL"
        title="Missions"
        description="Décrivez un objectif : Gen3ia crée une mission avec étapes, statut et validations nécessaires. Les connecteurs utilisés restent visibles dans le contexte de chaque mission."
        action={
          <>
            <Link href="/studio/create" className="g3-btn g3-btn-ghost text-xs">
              Modèles de missions
            </Link>
            <Link href="/studio/agents" className="g3-btn g3-btn-primary text-xs">
              Agents & chat
            </Link>
          </>
        }
      />

      <MissionComposer compact />

      {unauthenticated && (
        <PermissionNotice
          tone="info"
          title="Connectez-vous pour retrouver vos missions"
          description="Vos missions, validations et livrables sont associés à votre compte Gen3ia."
          actions={
            <Link href="/login" className="rounded-full bg-[var(--g3-deep)] px-4 py-2 text-xs font-semibold text-white">
              Se connecter
            </Link>
          }
        />
      )}

      {error && !unauthenticated && (
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

      {loading && !mounted && <LoadingState rows={4} />}

      {mounted && !unauthenticated && (
        <div className="space-y-7">
          {GROUPS.map((group) => {
            const items = grouped.get(group.id) ?? [];
            if (items.length === 0 && (loading || missions.length === 0)) return null;
            return (
              <section key={group.id} aria-label={group.title}>
                <div className="mb-3 flex items-baseline justify-between gap-3">
                  <h2 className="font-serif text-lg font-semibold text-[var(--g3-text)]">
                    {group.title}
                    <span className="ml-2 rounded-full bg-[var(--g3-elevated)] px-2 py-0.5 text-xs font-semibold text-[var(--g3-muted)]">{items.length}</span>
                  </h2>
                  <p className="hidden text-xs text-[var(--g3-faint)] md:block">{group.description}</p>
                </div>
                {loading ? (
                  <LoadingState rows={2} />
                ) : items.length === 0 ? (
                  <EmptyState
                    icon="◌"
                    title={`Aucune mission ${group.title.toLowerCase()}`}
                    description={group.id === "validation" ? "Lancez une mission ci-dessus : elle apparaîtra ici pour validation." : undefined}
                  />
                ) : (
                  <ResourceList rows={rowsFor(items)} ariaLabel={`Missions : ${group.title}`} />
                )}
              </section>
            );
          })}

          {missions.length === 0 && !loading && !error && (
            <EmptyState
              icon="◈"
              title="Lancez votre première mission"
              description="Décrivez un objectif ci-dessus, ou partez d'un modèle métier (landing page, contrats, congés, cashflow…)."
              action={
                <Link href="/studio/create" className="g3-btn g3-btn-primary text-xs">
                  Explorer les modèles
                </Link>
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Chargement paresseux du panneau de mission (composant lourd : plan DAG,
 * validations, exécution) — évite de le Monter pour la simple liste.
 */
function LazyTaskPanel({ taskId }: { taskId: string }) {
  const [panel, setPanel] = useState<React.ReactNode>(null);

  useEffect(() => {
    let cancelled = false;
    void import("@/components/agent/workspace-task-panel").then((module) => {
      if (!cancelled) setPanel(<module.WorkspaceTaskPanel taskId={taskId} />);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  return panel ?? <LoadingState rows={4} label="Chargement de la mission…" />;
}
