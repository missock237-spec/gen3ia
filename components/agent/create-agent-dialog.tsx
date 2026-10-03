"use client";

import * as React from "react";
import { authFetch } from "@/lib/firebase/auth-client";
import { uploadPermanentFiles } from "@/lib/storage/upload-client";
import type { AgentType } from "@/lib/agents/agent-types";

const TYPES: Array<{ value: AgentType; label: string }> = [
  { value: "code", label: "Code" },
  { value: "marketing", label: "Marketing" },
  { value: "teaching", label: "Enseignement" },
  { value: "commercial", label: "Commercial" },
  { value: "vocal", label: "Vocal" },
  { value: "custom", label: "Type personnalisé" },
];

export function CreateAgentDialog({ onCreated, onClose }: { onCreated: () => void; onClose: () => void }) {
  const [name, setName] = React.useState("");
  const [type, setType] = React.useState<AgentType>("custom");
  const [customType, setCustomType] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    const typeLabel = type === "custom" ? customType.trim() : TYPES.find((item) => item.value === type)?.label ?? type;
    if (trimmedName.length < 2) return setError("Le nom de l’agent doit contenir au moins 2 caractères.");
    if (type === "custom" && typeLabel.length < 2) return setError("Indiquez le type de votre agent.");
    setBusy(true);
    setError("");
    try {
      let memoryFile: { path: string; name: string } | undefined;
      if (file) {
        const upload = await uploadPermanentFiles([file]);
        const item = upload.uploaded[0];
        if (!item?.path) throw new Error(upload.failed[0]?.error || "Impossible d’importer le fichier.");
        memoryFile = { path: item.path, name: file.name };
      }

      const response = await authFetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          description: `Agent spécialisé en ${typeLabel.toLowerCase()}.`,
          type,
          typeLabel,
          skills: [typeLabel],
          agentMode: type === "vocal" ? "call" : "standard",
          ...(memoryFile ? { memoryFile } : {}),
          autonomous: true,
          subagentsEnabled: true,
          maxSubagents: 3,
          authorizationMode: "always_ask",
          memoryEnabled: true,
          webResearchEnabled: true,
          documentGenerationEnabled: true,
          voiceEnabled: type === "vocal",
          status: "active",
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Création de l’agent impossible.");
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Création impossible.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Créer un agent">
      <form onSubmit={submit} className="w-full max-w-lg rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-[var(--g3-text)]">Créer un agent</h2>
            <p className="mt-1 text-xs leading-5 text-[var(--g3-muted)]">Nom, type et fichier de référence facultatif. Les compétences et le prompt sont construits automatiquement pendant l’exécution.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-xl px-2 py-1 text-sm text-[var(--g3-muted)] hover:bg-[var(--g3-elevated)]" aria-label="Fermer">×</button>
        </div>

        <label className="mt-5 block text-xs font-semibold text-[var(--g3-text-secondary)]">
          Nom de l’agent
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required className="mt-2 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-2.5 text-sm outline-none focus:border-violet-500" placeholder="Ex. Mon agent commercial" />
        </label>

        <label className="mt-4 block text-xs font-semibold text-[var(--g3-text-secondary)]">
          Type
          <select value={type} onChange={(e) => setType(e.target.value as AgentType)} className="mt-2 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-2.5 text-sm outline-none focus:border-violet-500">
            {TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>

        {type === "custom" && (
          <label className="mt-4 block text-xs font-semibold text-[var(--g3-text-secondary)]">
            Type personnalisé
            <input value={customType} onChange={(e) => setCustomType(e.target.value)} maxLength={80} className="mt-2 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-2.5 text-sm outline-none focus:border-violet-500" placeholder="Ex. Juridique, immobilier, support…" />
          </label>
        )}

        <label className="mt-4 block text-xs font-semibold text-[var(--g3-text-secondary)]">
          Fichier de référence <span className="font-normal text-[var(--g3-faint)]">(facultatif)</span>
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-2 block w-full text-xs text-[var(--g3-muted)]" />
        </label>

        {file && <p className="mt-2 text-[11px] text-[var(--g3-muted)]">Fichier sélectionné : {file.name}</p>}
        {error && <p className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-300">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-xl border border-[var(--g3-border)] px-4 py-2 text-xs font-semibold text-[var(--g3-muted)]">Annuler</button>
          <button type="submit" disabled={busy} className="rounded-xl bg-violet-600 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">{busy ? "Création…" : "Créer l’agent"}</button>
        </div>
      </form>
    </div>
  );
}
