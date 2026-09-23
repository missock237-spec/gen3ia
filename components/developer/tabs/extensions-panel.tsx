"use client";

import { useDeveloper } from "@/components/developer/developer-context";
import { Panel, TabEmpty } from "@/components/developer/tabs/panel";

/** Onglet Extensions — versions, permissions, installations, exécutions. */
export function ExtensionsPanel() {
  const { extensions } = useDeveloper();

  return (
    <section>
      <Panel title="Extensions" subtitle="Versions, permissions, installations et exécutions.">
        {extensions.length === 0 ? (
          <TabEmpty text="Aucune extension. Utilise Build pour créer la première." />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {extensions.map((extension) => (
              <div key={extension.id} className="rounded-2xl border p-4">
                <div className="flex justify-between">
                  <b>{extension.name}</b>
                  <span className="text-xs">{extension.status}</span>
                </div>
                <div className="mt-2 text-xs text-neutral-500">{`${extension.id} · v${extension.latestVersion || "—"}`}</div>
                <div className="mt-3 text-xs">{`${extension.stats.installs} installations · ${extension.stats.executions} exécutions`}</div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {extension.permissions.map((permission) => (
                    <span key={permission} className="rounded bg-neutral-100 px-2 py-1 font-mono text-[10px]">
                      {permission}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </section>
  );
}
