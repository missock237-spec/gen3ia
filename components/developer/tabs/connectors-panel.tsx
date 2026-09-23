"use client";

import { useEffect, useState } from "react";

import { useDeveloper } from "@/components/developer/developer-context";
import { Panel } from "@/components/developer/tabs/panel";

/** Onglet Connecteurs — catalogue Composio + connexions/outils du projet. */
export function ConnectorsPanel() {
  const {
    selectedProject,
    projectConnectors,
    connectors,
    busy,
    setBusy,
    setMessage,
    api,
    loadConnectors,
    loadProjectConnectors,
    loadProjectTools,
    projectTools,
  } = useDeveloper();
  const [connectorSearch, setConnectorSearch] = useState("");
  const [toolSearch, setToolSearch] = useState("");

  useEffect(() => {
    void loadConnectors("");
    void loadProjectConnectors();
    void loadProjectTools("");
  }, [loadConnectors, loadProjectConnectors, loadProjectTools]);

  const connectToolkit = async (toolkit: string) => {
    if (!selectedProject) {
      setMessage("Sélectionne un projet avant de connecter une application.");
      return;
    }
    setBusy(true);
    try {
      const response = await api("/api/integrations/composio/connect", { method: "POST", body: JSON.stringify({ toolkit, projectId: selectedProject }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (data.authorizationUrl) window.location.assign(data.authorizationUrl);
      else await loadProjectConnectors();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Connexion impossible");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-5">
      <Panel title="Connecteurs Composio" subtitle="Catalogue dynamique des applications disponibles dans Composio.">
        <div className="flex gap-2">
          <input
            value={connectorSearch}
            onChange={(event) => setConnectorSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void loadConnectors(event.currentTarget.value);
            }}
            placeholder="Rechercher une application..."
            className="flex-1 rounded-xl border p-3 text-sm"
          />
          <button type="button" onClick={() => void loadConnectors(connectorSearch)} className="rounded-xl bg-black px-4 text-sm text-white">
            Rechercher
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {projectConnectors.map((connection) => (
            <span key={connection.id} className="rounded-full border bg-emerald-50 px-3 py-1.5 text-xs">
              <b>{connection.toolkit}</b>
            </span>
          ))}
        </div>
        <div className="mt-5 rounded-2xl border bg-neutral-50 p-4">
          <div className="font-semibold text-sm">Outils disponibles pour le projet</div>
          <div className="mt-2 flex gap-2">
            <input
              value={toolSearch}
              onChange={(event) => setToolSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void loadProjectTools(event.currentTarget.value);
              }}
              placeholder="Rechercher une action..."
              className="flex-1 rounded-xl border bg-white p-2.5 text-xs"
            />
            <button type="button" onClick={() => void loadProjectTools(toolSearch)} className="rounded-xl border bg-white px-3 text-xs">
              Rechercher
            </button>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {projectTools.slice(0, 40).map((tool, index) => (
              <div key={tool.slug + index} className="rounded-xl border bg-white p-3">
                <div className="font-mono text-[11px]">{tool.slug}</div>
                <div className="mt-1 text-xs text-neutral-500">{tool.name || tool.toolkit || "Composio tool"}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {connectors.map((connector) => {
            const connected = projectConnectors.some((connection) => connection.toolkit === connector.toolkit);
            return (
              <div key={connector.toolkit} className="rounded-2xl border p-4">
                <div className="flex items-center gap-3">
                  {connector.logo ? (
                    /* eslint-disable-next-line @next/next/no-img-element -- Composio sert des logos de centaines de domaines imprévisibles ; next/image exige une allowlist statique impossible pour 800+ apps. */
                    <img src={connector.logo} alt="" className="h-8 w-8 rounded-lg" />
                  ) : (
                    <div className="grid h-8 w-8 place-items-center rounded-lg bg-neutral-100 text-xs font-bold">{connector.label.slice(0, 1)}</div>
                  )}
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{connector.label}</div>
                    <div className="text-[10px] text-neutral-400">{connector.toolkit}</div>
                  </div>
                </div>
                <p className="mt-3 line-clamp-2 text-xs text-neutral-500">{connector.description || "Application Composio"}</p>
                <button
                  type="button"
                  disabled={busy || connected}
                  onClick={() => void connectToolkit(connector.toolkit)}
                  className="mt-4 w-full rounded-xl bg-black px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
                >
                  {connected ? "Connecté au projet" : "Connecter au projet"}
                </button>
              </div>
            );
          })}
        </div>
      </Panel>
    </section>
  );
}
