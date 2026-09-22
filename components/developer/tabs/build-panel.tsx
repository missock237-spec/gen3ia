"use client";

import { useState } from "react";

import { useDeveloper } from "@/components/developer/developer-context";
import { Panel } from "@/components/developer/tabs/panel";

const TEMPLATE = JSON.stringify(
  {
    id: "mon-extension",
    name: "Mon Extension",
    version: "1.0.0",
    author: "Moi",
    description: "Extension Gen3ia",
    category: "productivity",
    tags: ["gen3ia"],
    permissions: ["http.fetch:api.exemple.com"],
    secrets: { api_key: { description: "Clé API externe" } },
    tools: [
      {
        id: "search",
        name: "Recherche",
        description: "Interroge mon API",
        inputSchema: { query: { type: "string", required: true } },
        outputSchema: { result: { type: "string" } },
        endpoint: {
          method: "GET",
          url: "https://api.exemple.com/search?q={{input.query}}",
          headers: [{ name: "Authorization", value: "Bearer {{secret.api_key}}" }],
          timeoutMs: 8000,
        },
      },
    ],
    skills: [],
    workflows: [],
    settings: [],
    pricing: { model: "free", maxExecutionsPerDay: 100 },
  },
  null,
  2,
);

/** Onglet Build — Extension / Tool Builder déclaratif. */
export function BuildPanel() {
  const { selectedProject, busy, setBusy, setMessage, api, loadCore } = useDeveloper();
  const [manifest, setManifest] = useState(TEMPLATE);

  const createExtension = async () => {
    setBusy(true);
    setMessage("");
    try {
      const parsed = JSON.parse(manifest);
      const response = await api("/api/extensions", { method: "POST", body: JSON.stringify({ manifest: parsed, projectId: selectedProject }) });
      const data = await response.json();
      if (!response.ok) throw new Error([data.error, ...(data.details ?? [])].filter(Boolean).join(" — "));
      setMessage("Extension créée en brouillon.");
      await loadCore();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Manifest JSON invalide");
    } finally {
      setBusy(false);
    }
  };

  const surfaces: Array<[string, string]> = [
    ["APIs & routes", "Workspace"],
    ["Tools", "Workspace"],
    ["Connecteurs OAuth", "Workspace"],
    ["Extensions", "Disponible"],
    ["Skills", "Workspace"],
    ["Webhooks", "Workspace"],
    ["Knowledge / RAG", "Workspace"],
    ["Secrets", "Workspace"],
    ["Sandbox", "Workspace"],
    ["Evaluations", "Workspace"],
    ["Deployments", "Workspace"],
  ];

  return (
    <section className="grid gap-5 lg:grid-cols-[1.2fr_.8fr]">
      <Panel title="Extension / Tool Builder" subtitle="Création déclarative.">
        <textarea
          value={manifest}
          onChange={(event) => setManifest(event.target.value)}
          className="min-h-[520px] w-full rounded-2xl border bg-[#fbfbf9] p-4 font-mono text-xs"
          spellCheck={false}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void createExtension()}
          className="mt-3 rounded-xl bg-black px-5 py-3 text-sm text-white disabled:opacity-40"
        >
          Créer le brouillon
        </button>
      </Panel>
      <Panel title="Surface développeur" subtitle="Modules">
        <div className="space-y-2">
          {surfaces.map(([label, state]) => (
            <div key={label} className="flex items-center justify-between rounded-xl border p-3 text-sm">
              <span>{label}</span>
              <span className="text-xs text-neutral-400">{state}</span>
            </div>
          ))}
        </div>
      </Panel>
    </section>
  );
}
