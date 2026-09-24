"use client";

import { useState } from "react";

import { useDeveloper } from "@/components/developer/developer-context";
import { Panel, TabEmpty } from "@/components/developer/tabs/panel";

/** Onglet API & SDK — clés liées au projet et contrat SDK. */
export function ApiKeysPanel() {
  const { projects, keys, selectedProject, setSelectedProject, busy, setBusy, setMessage, api, loadCore } = useDeveloper();
  const [newKey, setNewKey] = useState("");

  const createKey = async () => {
    if (!selectedProject) {
      setMessage("Sélectionne un projet Gen3ia.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await api("/api/developer/api-keys", { method: "POST", body: JSON.stringify({ name: "SDK", projectId: selectedProject }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setNewKey(data.key);
      await loadCore();
      setMessage("Clé créée : elle est liée au projet sélectionné.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Création impossible");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (prefix: string) => {
    if (!confirm("Révoquer cette clé ?")) return;
    setBusy(true);
    try {
      const response = await api("/api/developer/api-keys", { method: "DELETE", body: JSON.stringify({ prefix }) });
      if (!response.ok) throw new Error((await response.json()).error);
      await loadCore();
      setMessage("Clé révoquée.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Révocation impossible");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-5">
      <Panel title="API & SDK" subtitle="Les clés Gen3ia ne sont pas globales : elles sont liées à un projet précis.">
        <div className="flex flex-col gap-3 md:flex-row">
          <select
            value={selectedProject}
            onChange={(event) => setSelectedProject(event.target.value)}
            className="flex-1 rounded-xl border p-3 text-sm"
          >
            <option value="">Choisir le projet lié</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || !selectedProject}
            onClick={() => void createKey()}
            className="rounded-xl bg-black px-5 py-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            Générer une clé
          </button>
        </div>
        {newKey && (
          <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <div className="text-xs font-semibold text-emerald-700">À copier maintenant — affichée une seule fois</div>
            <code className="mt-2 block break-all font-mono text-xs">{newKey}</code>
          </div>
        )}
      </Panel>
      <Panel title="Clés existantes" subtitle="La révocation coupe immédiatement l'accès.">
        {keys.length === 0 ? (
          <TabEmpty text="Aucune clé générée." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-xs text-[var(--g3-faint)]">
                  <th className="p-3">Clé</th>
                  <th className="p-3">Projet</th>
                  <th className="p-3">Statut</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.prefix} className="border-b last:border-0">
                    <td className="p-3 font-mono">{key.prefix}…</td>
                    <td className="p-3">{projects.find((project) => project.id === key.projectId)?.name || "Projet inconnu"}</td>
                    <td className="p-3">{key.status}</td>
                    <td className="p-3 text-right">
                      {key.status === "active" && (
                        <button type="button" onClick={() => void revoke(key.prefix)} className="text-red-600">
                          Révoquer
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="Contrat SDK" subtitle="Les deux éléments sont obligatoires pour une requête authentifiée par clé.">
        <pre className="overflow-x-auto rounded-2xl bg-neutral-950 p-4 text-xs text-[var(--g3-text-secondary)]">
          {"Authorization: Bearer g3x_...\nX-Gen3ia-Project-Id: <project_id>"}
        </pre>
      </Panel>
    </section>
  );
}
