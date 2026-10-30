"use client";

import { useState } from "react";

import { useDeveloper } from "@/components/developer/developer-context";
import { Panel, TabEmpty } from "@/components/developer/tabs/panel";
import { ExtensionSecrets } from "@/components/developer/tabs/secrets-panel";

/** Onglet Extensions — versions, permissions, installations, exécutions,
 *  et gestion des SECRETS d'extension (it.43 : câblage de l'API
 *  /api/developer/secrets — valeurs serveur uniquement, jamais retournées). */
export function ExtensionsPanel() {
  const { extensions } = useDeveloper();
  const [secretsOuverts, setSecretsOuverts] = useState<Record<string, boolean>>({});

  const basculerSecrets = (id: string) =>
    setSecretsOuverts((courants) => ({ ...courants, [id]: !courants[id] }));

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
                <div className="mt-2 text-xs text-[var(--g3-muted)]">{`${extension.id} · v${extension.latestVersion || "—"}`}</div>
                <div className="mt-3 text-xs">{`${extension.stats.installs} installations · ${extension.stats.executions} exécutions`}</div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {extension.permissions.map((permission) => (
                    <span key={permission} className="rounded bg-[var(--g3-elevated)] px-2 py-1 font-mono text-[10px]">
                      {permission}
                    </span>
                  ))}
                </div>
                <div className="mt-3">
                  <button type="button" onClick={() => basculerSecrets(extension.id)} className="text-xs underline">
                    {secretsOuverts[extension.id] ? "Masquer les secrets" : "Secrets…"}
                  </button>
                  {secretsOuverts[extension.id] && <ExtensionSecrets extensionId={extension.id} />}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </section>
  );
}
