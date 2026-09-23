"use client";

import { useDeveloper } from "@/components/developer/developer-context";
import { Card, Panel } from "@/components/developer/tabs/panel";

/** Onglet Monitoring — exécutions, installations, transactions, projet actif. */
export function MonitoringPanel() {
  const { extensions, revenue, resourceSummary, project } = useDeveloper();

  return (
    <section className="grid gap-5 md:grid-cols-3">
      <Card title="Exécutions extensions" value={extensions.reduce((sum, extension) => sum + extension.stats.executions, 0)} />
      <Card title="Installations" value={extensions.reduce((sum, extension) => sum + extension.stats.installs, 0)} />
      <Card title="Transactions" value={revenue?.entries ?? 0} />
      <div className="md:col-span-3">
        <Panel title="Projet actif" subtitle={project?.name || "Aucun projet sélectionné"}>
          <div className="text-sm text-neutral-600">
            {project ? `ID: ${project.id} · ${project.framework} · ${project.environment}` : "Sélectionne un projet pour voir ses ressources."}
          </div>
          {resourceSummary && (
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {(
                [
                  ["Extensions", resourceSummary.extensions],
                  ["Clés", resourceSummary.activeApiKeys],
                  ["Exécutions", resourceSummary.executions],
                  ["Installations", resourceSummary.installations],
                  ["Brouillons", resourceSummary.draftExtensions],
                ] as Array<[string, number]>
              ).map(([label, value]) => (
                <div key={label} className="rounded-xl bg-neutral-50 p-3">
                  <div className="text-[10px] text-neutral-400">{label}</div>
                  <div className="mt-1 font-bold">{value}</div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </section>
  );
}
