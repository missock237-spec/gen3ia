"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { SectionHeader } from "@/components/shells/section-header";
import { EmptyState, LoadingState } from "@/components/shells/states";
import { authFetch } from "@/lib/firebase/auth-client";
import { Chip, ErrorBanner } from "@/components/training/studio-bits";

import "./training.css";
import type { TrainingProject } from "@/lib/training/types";

/* ------------------------------------------------------------------ */
/* AI Training Studio — projets de l'utilisateur.                       */
/* Étape 1 du parcours : création guidée d'un projet d'entraînement.   */
/* ------------------------------------------------------------------ */

const FAMILIES = [
  { id: "text", label: "Langage / conversationnel", hint: "Chatbots, assistants, rédaction — entraînés par Gen (moteur Gen3 natif) ou fine-tuning LoRA/QLoRA" },
  { id: "image", label: "Images", hint: "Génération et compréhension d'images (capacités en préparation)" },
  { id: "audio", label: "Audio / voix", hint: "Reconnaissance et génération vocale (capacités en préparation)" },
  { id: "video", label: "Vidéo", hint: "Génération vidéo (capacités en préparation)" },
  { id: "multimodal", label: "Multimodal", hint: "Texte + image + audio (capacités en préparation)" },
  { id: "specialized", label: "Tâche spécialisée", hint: "Classification, extraction, détection" },
] as const;

const MODES = [
  { id: "auto", label: "Automatique", hint: "L'assistant prépare tout, vous validez" },
  { id: "assisted", label: "Assisté", hint: "Guidage étape par étape, vous gardez le contrôle" },
  { id: "advanced", label: "Avancé", hint: "Hyperparamètres et configurations accessibles" },
] as const;

export default function TrainingStudioPage() {
  const [projects, setProjects] = useState<TrainingProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [unauthenticated, setUnauthenticated] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authFetch("/api/training/projects", { cache: "no-store" });
      if (response.status === 401) {
        setUnauthenticated(true);
        return;
      }
      if (response.ok) {
        const data = (await response.json()) as { projects: TrainingProject[] };
        setProjects(data.projects ?? []);
      }
    } catch {
      /* réseau : on garde l'état précédent */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (unauthenticated) {
    return (
      <EmptyState icon="⚿" title="Connexion requise" description="Connectez-vous pour accéder à l'AI Training Studio." />
    );
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Gen3ia"
        title="AI Training"
        highlight="Studio"
        description="Confiez VOS données à Gen : elle entraîne elle-même vos modèles IA sur son moteur neuronal natif (CPU, apprentissage réel dès quelques paires) ou sur GPU (LoRA) — analyse de datasets, plans adaptés, précision mesurée, modèles exportables."
        action={
          <button
            type="button"
            onClick={() => setShowForm((visible) => !visible)}
            className="rounded-2xl bg-[var(--g3-gradient)] px-5 py-2.5 text-sm font-semibold text-[var(--g3-on-primary)] transition hover:opacity-90"
          >
            {showForm ? "Fermer" : "+ Nouveau projet"}
          </button>
        }
      />

      {showForm ? (
        <CreateProjectForm
          busy={creating}
          onSubmit={async (payload) => {
            setCreating(true);
            setError("");
            try {
              const response = await authFetch("/api/training/projects", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
              });
              if (!response.ok) {
                const data = (await response.json().catch(() => ({}))) as { error?: string };
                setError(data.error ?? "Création impossible.");
                return;
              }
              setShowForm(false);
              await load();
            } finally {
              setCreating(false);
            }
          }}
        />
      ) : null}

      {error ? <ErrorBanner message={error} /> : null}

      {loading ? (
        <LoadingState label="Chargement des projets d'entraînement…" rows={3} />
      ) : projects.length === 0 ? (
        <div className="ts-card">
          <EmptyState
            icon="⌬"
            title="Aucun projet d'entraînement"
            description="Créez votre premier projet : décrivez ce que vous voulez obtenir, l'assistant IA vous guidera vers la bonne méthode (fine-tuning LoRA, QLoRA, RAG…)."
            action={
              <button
                type="button"
                onClick={() => setShowForm(true)}
                className="rounded-2xl bg-[var(--g3-gradient)] px-5 py-2.5 text-sm font-semibold text-[var(--g3-on-primary)] transition hover:opacity-90"
              >
                Créer mon premier projet
              </button>
            }
          />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/workspace/training/${project.id}`}
              className="ts-card group p-5 transition hover:border-[var(--g3-primary-border)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate font-serif text-base font-semibold text-[var(--g3-text)] group-hover:text-[var(--g3-primary-strong)]">
                    {project.name}
                  </h3>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--g3-muted)]">
                    {project.objective || project.description || "Objectif non précisé"}
                  </p>
                </div>
                {project.status === "archived" ? <Chip variant="neutral">Archivé</Chip> : null}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Chip variant="primary">{project.family}</Chip>
                <Chip variant="neutral">{MODES.find((m) => m.id === project.mode)?.label ?? project.mode}</Chip>
                <span className="ml-auto text-xs text-[var(--g3-faint)]">
                  {new Date(project.createdAt).toLocaleDateString("fr-FR")}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      <div className="ts-hero p-6">
        <h2 className="font-serif text-lg font-semibold text-[var(--g3-text)]">Ce que le studio garantit</h2>
        <div className="mt-4 grid gap-4 text-sm leading-6 text-[var(--g3-muted)] md:grid-cols-3">
          <p>
            <strong className="text-[var(--g3-text-secondary)]">Zéro simulation en production.</strong> Une tâche ne passe
            jamais à « terminé » sans exécution réelle sur un GPU : sans fournisseur, elle reste en file d&apos;attente.
          </p>
          <p>
            <strong className="text-[var(--g3-text-secondary)]">Validation à l&apos;import.</strong> Formats pickle refusés, headers
            safetensors vérifiés, archives inspectées, datasets analysés ligne par ligne (doublons, données personnelles).
          </p>
          <p>
            <strong className="text-[var(--g3-text-secondary)]">Estimations étiquetées.</strong> VRAM, durée et coûts prévisionnels
            sont toujours présentés comme des estimations — jamais comme des mesures.
          </p>
        </div>
      </div>
    </div>
  );
}

function CreateProjectForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [objective, setObjective] = useState("");
  const [family, setFamily] = useState<string>("text");
  const [language, setLanguage] = useState("fr");
  const [mode, setMode] = useState<string>("assisted");
  const [dataTypes, setDataTypes] = useState<string[]>([]);

  const toggleDataType = (value: string) => {
    setDataTypes((current) => (current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value]));
  };

  return (
    <form
      className="ts-card space-y-4 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        void onSubmit({ name, description, family, objective, primaryLanguage: language, mode, dataTypes });
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">Nom du projet *</span>
          <input
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Assistant support client v2"
            className="w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none transition focus:border-[var(--g3-primary)]"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">Langue principale</span>
          <select
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            className="w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)]"
          >
            <option value="fr">Français</option>
            <option value="en">Anglais</option>
            <option value="bilingue">Bilingue FR/EN</option>
            <option value="multi">Multilingue</option>
          </select>
        </label>
      </div>

      <label className="block">
        <span className="mb-1.5 block text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">
          Objectif du modèle (en langage naturel)
        </span>
        <textarea
          rows={2}
          maxLength={2000}
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          placeholder="Je veux créer un assistant spécialisé dans le support client de mon entreprise…"
          className="w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none transition focus:border-[var(--g3-primary)]"
        />
      </label>

      <label className="block">
        <span className="mb-1.5 block text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">Description (optionnel)</span>
        <input
          maxLength={2000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none transition focus:border-[var(--g3-primary)]"
        />
      </label>

      <div>
        <span className="mb-2 block text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">Famille de modèles</span>
        <div className="grid gap-2 md:grid-cols-3">
          {FAMILIES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={family === entry.id}
              onClick={() => setFamily(entry.id)}
              className={`rounded-2xl px-3.5 py-2.5 text-left transition ${
                family === entry.id
                  ? "bg-[var(--g3-primary-soft)] text-[var(--g3-text)]"
                  : "bg-[var(--g3-elevated)] text-[var(--g3-muted)] hover:bg-[var(--g3-hover)]"
              }`}
            >
              <span className="block text-xs font-semibold">{entry.label}</span>
              <span className="mt-0.5 block text-[0.68rem] leading-4 text-[var(--g3-faint)]">{entry.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className="mb-2 block text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">Types de données prévus</span>
        <div className="flex flex-wrap gap-2">
          {["textes", "paires question-réponse", "conversations", "CSV", "documents", "images", "audio", "vidéo"].map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={dataTypes.includes(type)}
              onClick={() => toggleDataType(type)}
              className={`rounded-full px-3.5 py-1.5 text-xs transition ${
                dataTypes.includes(type)
                  ? "bg-[var(--g3-primary-soft)] text-[var(--g3-primary-strong)]"
                  : "bg-[var(--g3-elevated)] text-[var(--g3-muted)] hover:text-[var(--g3-text-secondary)]"
              }`}
            >
              {type}
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className="mb-2 block text-xs uppercase tracking-[.14em] text-[var(--g3-faint)]">Mode de fonctionnement</span>
        <div className="grid gap-2 md:grid-cols-3">
          {MODES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={mode === entry.id}
              onClick={() => setMode(entry.id)}
              className={`rounded-2xl px-3.5 py-2.5 text-left transition ${
                mode === entry.id
                  ? "bg-[var(--g3-primary-soft)] text-[var(--g3-text)]"
                  : "bg-[var(--g3-elevated)] text-[var(--g3-muted)] hover:bg-[var(--g3-hover)]"
              }`}
            >
              <span className="block text-xs font-semibold">{entry.label}</span>
              <span className="mt-0.5 block text-[0.68rem] leading-4 text-[var(--g3-faint)]">{entry.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2 border-t border-[var(--g3-border)] pt-4">
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="rounded-2xl bg-[var(--g3-gradient)] px-5 py-2.5 text-sm font-semibold text-[var(--g3-on-primary)] transition hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "Création…" : "Créer le projet"}
        </button>
      </div>
    </form>
  );
}
