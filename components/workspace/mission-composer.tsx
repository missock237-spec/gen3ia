"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import {
  MISSION_TEMPLATES,
  templateById,
  templateCategories,
  type MissionTemplate,
} from "@/lib/missions/templates";

/**
 * MissionComposer — composer global de mission.
 * Flux cible : l'utilisateur décrit un objectif → Gen3ia crée une mission
 * (plan + étapes + validations) → redirection vers la vue détaillée.
 * Les modules métier sont proposés comme modèles (chips), pas comme menu.
 */
export function MissionComposer({
  compact = false,
  autoFocus = false,
}: {
  /** Version compacte (bandeau des Missions) : pas de grille de modèles. */
  compact?: boolean;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const [templateId, setTemplateId] = useState("free");
  const [objective, setObjective] = useState("");
  const [category, setCategory] = useState<string>("Toutes");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const template = useMemo(() => templateById(templateId) ?? MISSION_TEMPLATES[0], [templateId]);
  const categories = useMemo(() => templateCategories(), []);
  const visibleTemplates = useMemo(
    () =>
      category === "Toutes"
        ? MISSION_TEMPLATES
        : MISSION_TEMPLATES.filter((candidate) => candidate.category === category),
    [category],
  );

  const selectTemplate = (candidate: MissionTemplate) => {
    setTemplateId(candidate.id);
    // Pré-remplit l'objectif si l'utilisateur n'a pas encore saisi de texte
    // libre, ou si le texte correspond encore au modèle précédent.
    const previous = templateById(templateId);
    if (!objective.trim() || (previous && objective === previous.objectiveSample)) {
      setObjective(candidate.objectiveSample);
    }
  };

  const submit = async () => {
    if (busy) return;
    setError("");
    const text = objective.trim();
    if (text.length < 3) {
      setError("Décrivez votre objectif (3 caractères minimum).");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/workspace/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ objective: text }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        task?: { id?: string };
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Création impossible pour le moment.");
      if (data.task?.id) {
        router.push(`/studio?taskId=${encodeURIComponent(data.task.id)}`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Création impossible pour le moment.");
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="Composer une mission"
      className="rounded-3xl border border-[var(--g3-border)] bg-white p-5 shadow-[0_14px_40px_-24px_rgba(28,27,24,0.35)] md:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-serif text-lg font-semibold text-neutral-900">Nouvelle mission</h2>
        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700">
          plan + validations automatiques
        </span>
      </div>

      {!compact && (
        <>
          {/* Filtres de catégories (modules métier = modèles, pas de menu) */}
          <div className="mt-4 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtrer les modèles">
            {["Toutes", ...categories].map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setCategory(item)}
                aria-pressed={category === item}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                  category === item
                    ? "border-neutral-900 bg-neutral-900 text-white"
                    : "border-[rgba(23,23,20,0.12)] bg-white text-neutral-500 hover:border-neutral-300 hover:text-neutral-900"
                }`}
              >
                {item}
              </button>
            ))}
          </div>

          {/* Grille des modèles de mission */}
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" role="radiogroup" aria-label="Modèle de mission">
            {visibleTemplates.map((candidate) => {
              const selected = candidate.id === templateId;
              return (
                <button
                  key={candidate.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => selectTemplate(candidate)}
                  className={`rounded-2xl border p-3.5 text-left transition ${
                    selected
                      ? "border-neutral-900 bg-neutral-900 text-white shadow-[0_10px_26px_-14px_rgba(28,27,24,0.55)]"
                      : "border-[rgba(23,23,20,0.1)] bg-white text-neutral-700 hover:border-neutral-300"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span aria-hidden="true">{candidate.icon}</span>
                    <span className="text-sm font-semibold">{candidate.label}</span>
                  </div>
                  <p className={`mt-1.5 line-clamp-2 text-xs leading-5 ${selected ? "text-neutral-300" : "text-neutral-500"}`}>
                    {candidate.description}
                  </p>
                  <div className={`mt-2 flex flex-wrap gap-1 ${selected ? "text-neutral-400" : "text-neutral-400"}`}>
                    {candidate.engines.map((engine) => (
                      <span key={engine} className="rounded-md bg-black/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide">
                        {engine}
                      </span>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}

      {compact && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {MISSION_TEMPLATES.filter((candidate) => candidate.id !== "free")
            .slice(0, 6)
            .map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => selectTemplate(candidate)}
                aria-pressed={templateId === candidate.id}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                  templateId === candidate.id
                    ? "border-neutral-900 bg-neutral-900 text-white"
                    : "border-[rgba(23,23,20,0.12)] bg-white text-neutral-500 hover:border-neutral-300 hover:text-neutral-900"
                }`}
              >
                <span aria-hidden="true" className="mr-1">{candidate.icon}</span>
                {candidate.label}
              </button>
            ))}
          <a
            href="/studio/create"
            className="rounded-full border border-dashed border-[rgba(23,23,20,0.2)] px-3 py-1.5 text-xs font-medium text-neutral-500 transition hover:text-neutral-900"
          >
            Tous les modèles →
          </a>
        </div>
      )}

      <div className="mt-4">
        <label htmlFor="mission-objective" className="sr-only">
          Objectif de la mission
        </label>
        <textarea
          id="mission-objective"
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit();
          }}
          placeholder={template.placeholder}
          rows={compact ? 3 : 4}
          autoFocus={autoFocus}
          className="w-full resize-y rounded-2xl border border-[rgba(23,23,20,0.12)] bg-[#fbfaf7] p-4 text-sm leading-6 text-neutral-800 outline-none transition placeholder:text-neutral-400 focus:border-neutral-500 focus:bg-white"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-neutral-400">
            Gen3ia crée un plan en étapes et vous demande les validations nécessaires. ⌘+Entrée pour lancer.
          </p>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-full bg-neutral-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-700 disabled:opacity-50"
          >
            {busy ? "Création…" : "Lancer la mission"}
            <span aria-hidden="true">→</span>
          </button>
        </div>
        {error && (
          <p className="mt-2.5 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
