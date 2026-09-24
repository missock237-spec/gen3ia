"use client";

import * as React from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { uploadPermanentFiles } from "@/lib/storage/upload-client";
import {
  buildQuickCreatePayload,
  canSubmitQuickCreate,
  quickCreateTypeOptions,
  type QuickCreateTypeKey,
} from "@/lib/agents/quick-create";
import type { AgentSummary } from "@/lib/agents/schema";

/**
 * Création simplifiée d'agent (remplace l'assistant de personnalisation) :
 * l'utilisateur renseigne UNIQUEMENT le nom, le type (agent de code,
 * marketing, enseignement, commercial, vocal, ou type personnalisé) et —
 * seulement si nécessaire — un fichier mémoire à importer. Tout le reste
 * (description, compétences, outils, charte) est déduit automatiquement :
 * l'agent est immédiatement prêt à discuter et exécuter.
 */
export function AgentQuickCreate({
  onSaved,
  onCancel,
}: {
  onSaved: (agent: AgentSummary) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = React.useState("");
  const [typeKey, setTypeKey] = React.useState<QuickCreateTypeKey>("code");
  const [customType, setCustomType] = React.useState("");
  const [memoryFile, setMemoryFile] = React.useState<{ path: string; name: string } | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [importError, setImportError] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState("");

  const options = React.useMemo(() => quickCreateTypeOptions(), []);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const input = { name, typeKey, customType, ...(memoryFile ? { memoryFile } : {}) };
  const ready = canSubmitQuickCreate(input) && !importing && !submitting;

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setImportError("");
    setImporting(true);
    try {
      const result = await uploadPermanentFiles([file]);
      const uploaded = result.uploaded[0];
      if (!uploaded) throw new Error(result.failed[0]?.error || "Téléversement impossible.");
      const path = uploaded.path || uploaded.filename;
      if (!path) throw new Error("Le stockage n'a pas retourné le chemin du fichier.");
      setMemoryFile({ path, name: uploaded.filename || file.name });
    } catch (reason) {
      setMemoryFile(null);
      setImportError(reason instanceof Error ? reason.message : "Le fichier n'a pas pu être importé.");
    } finally {
      setImporting(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    setSubmitting(true);
    setError("");
    try {
      const payload = buildQuickCreatePayload(input);
      const response = await authFetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Création impossible.");
      const agent = (data.agent ?? data) as AgentSummary;
      if (!agent?.id) throw new Error("L'agent créé est introuvable.");
      onSaved(agent);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Création impossible.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="g3-card mx-auto w-full max-w-2xl p-5 sm:p-7" aria-label="Créer un agent IA">
      <header className="space-y-1.5">
        <h2 className="text-lg font-bold text-[var(--g3-text)]">Créer un agent IA</h2>
        <p className="text-sm leading-6 text-[var(--g3-muted)]">
          Donnez un nom et choisissez un type : l&apos;agent est configuré automatiquement et prêt à exécuter vos tâches.
          Importez un fichier uniquement si l&apos;agent doit s&apos;appuyer sur un document de référence.
        </p>
      </header>

      <form onSubmit={submit} className="mt-5 space-y-5">
        <div>
          <label htmlFor="quick-agent-name" className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-[var(--g3-muted)]">
            Nom de l&apos;agent
          </label>
          <input
            id="quick-agent-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            required
            minLength={2}
            placeholder="Ex. : Assistant commercial boutique"
            className="w-full rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-4 py-3 text-sm text-[var(--g3-text)] outline-none transition focus:border-[var(--g3-border-strong)]"
          />
        </div>

        <div>
          <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-[var(--g3-muted)]">Type d&apos;agent</span>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Type d'agent">
            {options.map((option) => {
              const selected = typeKey === option.key;
              return (
                <button
                  key={option.key}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setTypeKey(option.key)}
                  className={`rounded-2xl border p-3.5 text-left transition ${selected ? "border-[var(--g3-primary)] bg-[var(--g3-elevated)] shadow-[0_8px_24px_-14px_rgba(99,102,241,0.5)]" : "border-[var(--g3-border)] bg-[var(--g3-surface)] hover:border-[var(--g3-border-strong)]"}`}
                >
                  <span className="block text-sm font-bold text-[var(--g3-text)]">{option.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-5 text-[var(--g3-faint)]">{option.description}</span>
                </button>
              );
            })}
          </div>
          {typeKey === "custom" && (
            <input
              value={customType}
              onChange={(event) => setCustomType(event.target.value)}
              maxLength={60}
              required
              placeholder="Précisez le type : juridique, immobilier, RH, finance…"
              aria-label="Type d'agent personnalisé"
              className="mt-2 w-full rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-4 py-3 text-sm text-[var(--g3-text)] outline-none transition focus:border-[var(--g3-border-strong)]"
            />
          )}
        </div>

        <div>
          <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-[var(--g3-muted)]">
            Fichier de référence <span className="font-medium normal-case text-[var(--g3-faint)]">(optionnel — importez seulement si nécessaire)</span>
          </span>
          {memoryFile ? (
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-emerald-300/40 bg-emerald-50 px-4 py-3">
              <p className="min-w-0 truncate text-sm font-semibold text-emerald-700">{memoryFile.name}</p>
              <button type="button" onClick={() => setMemoryFile(null)} className="shrink-0 rounded-full border border-emerald-300 px-3 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100">
                Retirer
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={importing}
              className="w-full rounded-2xl border border-dashed border-[var(--g3-border-strong)] bg-[var(--g3-surface)] px-4 py-4 text-sm font-semibold text-[var(--g3-muted)] transition hover:border-[var(--g3-primary)] hover:text-[var(--g3-text)] disabled:opacity-60"
            >
              {importing ? "Import en cours…" : "＋ Importer un fichier (PDF, DOCX, TXT, CSV, MD)"}
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.txt,.csv,.md,.json,.zip"
            className="hidden"
            onChange={(event) => void handleFile(event.target.files?.[0])}
          />
          {importError && <p className="mt-1.5 text-xs font-semibold text-red-600" role="alert">{importError}</p>}
        </div>

        {error && (
          <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700" role="alert">{error}</p>
        )}

        <div className="flex items-center justify-end gap-2">
          {onCancel && (
            <button type="button" onClick={onCancel} className="rounded-full border border-[var(--g3-border)] px-4 py-2.5 text-sm font-semibold text-[var(--g3-muted)] transition hover:bg-[var(--g3-elevated)]">
              Annuler
            </button>
          )}
          <button
            type="submit"
            disabled={!ready}
            className="g3-btn g3-btn-primary !rounded-full px-6 py-2.5 text-sm disabled:opacity-50"
          >
            {submitting ? "Création…" : "Créer l'agent"}
          </button>
        </div>
      </form>
    </section>
  );
}
