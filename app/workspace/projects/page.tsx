"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { SectionHeader } from "@/components/shells/section-header";
import { EmptyState, LoadingState } from "@/components/shells/states";
import { authFetch } from "@/lib/firebase/auth-client";
import { formatRelative } from "@/components/workspace/labels";
import type { WorkspaceProject } from "@/lib/domain/projects/repository";

/**
 * /workspace/projects — Projets : l'équivalent de l'espace de travail
 * Claude. Chaque projet regroupe conversations, instructions persistantes,
 * fichiers, connecteurs autorisés et règles de confidentialité.
 */

export default function ProjectsPage() {
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authFetch("/api/workspace/projects?limit=50", { cache: "no-store" });
      if (response.ok) {
        const data = (await response.json()) as { projects: WorkspaceProject[] };
        setProjects(data.projects);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    setError("");
    try {
      const response = await authFetch("/api/workspace/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Création impossible.");
      }
      setName("");
      setDescription("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Création impossible.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="ESPACE DE TRAVAIL"
        title="Projets"
        description="Un projet regroupe vos conversations, des instructions persistantes, vos fichiers et sources, les connecteurs autorisés et vos règles de confidentialité. Idéal pour séparer sujets personnels, métier et techniques."
      />

      <div className="g3-card space-y-3 !p-4">
        <h2 className="text-sm font-semibold text-[var(--g3-text)]">Nouveau projet</h2>
        <div className="grid gap-2 md:grid-cols-2">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Nom du projet (ex. : Lancement produit)"
            className="g3-input text-sm"
            maxLength={120}
            aria-label="Nom du projet"
          />
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Description courte (optionnelle)"
            className="g3-input text-sm"
            maxLength={600}
            aria-label="Description du projet"
          />
        </div>
        {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
        <button type="button" onClick={() => void create()} disabled={creating || !name.trim()} className="g3-btn g3-btn-primary text-xs">
          {creating ? "Création…" : "Créer le projet"}
        </button>
      </div>

      {loading ? (
        <LoadingState label="Chargement des projets…" />
      ) : projects.length === 0 ? (
        <EmptyState
          icon="▦"
          title="Aucun projet"
          description="Créez votre premier projet pour regrouper conversations, instructions et fichiers dans un contexte persistant."
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" role="list">
          {projects.map((project) => (
            <li key={project.id} className="g3-card flex flex-col !p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-[var(--g3-text)]">▦ {project.name}</p>
                  <p className="mt-0.5 text-[10px] text-[var(--g3-faint)]">Mis à jour {formatRelative(project.updatedAt)}</p>
                </div>
                {project.status === "archived" && (
                  <span className="shrink-0 rounded-full border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-2 py-0.5 text-[10px] text-[var(--g3-muted)]">Archivé</span>
                )}
              </div>
              {project.description && <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-[var(--g3-muted)]">{project.description}</p>}
              <div className="mt-2.5 flex flex-wrap gap-1.5 text-[10px] text-[var(--g3-muted)]">
                {project.instructions && (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">instructions actives</span>
                )}
                {project.privacyRules && (
                  <span className="rounded-full bg-sky-50 px-2 py-0.5 text-sky-700">confidentialité</span>
                )}
                {project.authorizedConnectors.length > 0 && (
                  <span className="rounded-full bg-[var(--g3-elevated)] px-2 py-0.5">
                    {project.authorizedConnectors.length} connecteur(s)
                  </span>
                )}
              </div>
              <Link href={`/workspace/projects/${project.id}`} className="g3-btn g3-btn-ghost mt-3 w-full text-xs">
                Ouvrir le projet →
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
