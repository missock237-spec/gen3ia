"use client";

import { useState } from "react";

import { useDeveloper } from "@/components/developer/developer-context";
import { Panel, TabEmpty } from "@/components/developer/tabs/panel";

/** Onglet Projets — création et sélection des applications isolées. */
export function ProjectsPanel() {
  const { projects, selectedProject, setSelectedProject, busy, setBusy, setMessage, api, loadCore } = useDeveloper();
  const [newProject, setNewProject] = useState({ name: "", description: "", framework: "nextjs" });

  const createProject = async () => {
    setBusy(true);
    setMessage("");
    try {
      const response = await api("/api/developer/projects", { method: "POST", body: JSON.stringify(newProject) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setMessage("Projet Gen3ia créé.");
      setNewProject({ name: "", description: "", framework: "nextjs" });
      await loadCore();
      setSelectedProject(data.project.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Création impossible");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-5 lg:grid-cols-[.8fr_1.2fr]">
      <Panel title="Nouveau projet" subtitle="Un projet est l'unité de sécurité des clés.">
        <div className="space-y-3">
          <input
            value={newProject.name}
            onChange={(event) => setNewProject({ ...newProject, name: event.target.value })}
            placeholder="Nom du projet"
            className="w-full rounded-xl border p-3 text-sm"
          />
          <textarea
            value={newProject.description}
            onChange={(event) => setNewProject({ ...newProject, description: event.target.value })}
            placeholder="Description"
            className="min-h-24 w-full rounded-xl border p-3 text-sm"
          />
          <select
            value={newProject.framework}
            onChange={(event) => setNewProject({ ...newProject, framework: event.target.value })}
            className="w-full rounded-xl border p-3 text-sm"
          >
            <option value="nextjs">Next.js</option>
            <option value="node">Node.js</option>
            <option value="python">Python</option>
            <option value="other">Autre</option>
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={() => void createProject()}
            className="w-full rounded-xl bg-black p-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            Créer le projet
          </button>
        </div>
      </Panel>
      <Panel title="Mes projets" subtitle="Projets enregistrés dans Gen3ia.">
        {projects.length === 0 ? (
          <TabEmpty text="Aucun projet. Crée le premier à gauche." />
        ) : (
          <div className="space-y-2">
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => setSelectedProject(project.id)}
                className={`flex w-full items-center justify-between rounded-2xl border p-4 text-left ${
                  selectedProject === project.id ? "border-sky-400 bg-sky-50" : "bg-[var(--g3-surface)]"
                }`}
              >
                <div>
                  <div className="font-semibold">{project.name}</div>
                  <div className="mt-1 text-xs text-[var(--g3-muted)]">{`${project.framework} · ${project.environment} · ${project.slug}`}</div>
                </div>
                <span className="rounded-full bg-[var(--g3-elevated)] px-2 py-1 text-[10px]">{project.status}</span>
              </button>
            ))}
          </div>
        )}
      </Panel>
    </section>
  );
}
