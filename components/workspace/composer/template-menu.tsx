"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";

/**
 * Task 141 — menu « /modèle » : bibliothèque de PROMPT TEMPLATES personnels.
 *
 * Simplicité : chaque template se résume à un titre + un corps ; un clic insère
 * le corps dans le composer (le brouillon en cours est conservé, le template
 * s'ajoute à la suite). Flexibilité : le message EN COURS de rédaction peut
 * être enregistré comme modèle réutilisable, et tout modèle se supprime.
 */

export interface ComposerPromptTemplate {
  id: string;
  title: string;
  body: string;
}

interface TemplateMenuProps {
  /** Insère le corps du template dans le composer (à la suite du brouillon). */
  onInsert: (body: string) => void;
  /** Contenu actuel du composer (pour l'enregistrement comme modèle). */
  draft: string;
  /** Ouverture contrôlée (commande « /modèle ») — facultatif. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}

export function TemplateMenu({ onInsert, draft, open: controlledOpen, onOpenChange, disabled = false }: TemplateMenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    setInternalOpen(next);
    onOpenChange?.(next);
  };
  const [templates, setTemplates] = useState<ComposerPromptTemplate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Chargement paresseux : la liste n'est récupérée qu'à la première ouverture.
  useEffect(() => {
    if (!open || templates !== null || loading) return;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const response = await authFetch("/api/workspace/prompt-templates", { cache: "no-store" });
        if (!response.ok) throw new Error("Bibliothèque indisponible.");
        const data = (await response.json()) as { templates?: ComposerPromptTemplate[] };
        setTemplates(Array.isArray(data.templates) ? data.templates : []);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Bibliothèque indisponible.");
        setTemplates([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [open, templates, loading]);

  // Fermeture au clic extérieur / Échap.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const saveCurrent = useCallback(async () => {
    const body = draft.trim();
    if (!body || saving) return;
    setSaving(true);
    setError("");
    try {
      // Titre lisible par défaut : première ligne du brouillon, tronquée.
      const title = body.split("\n")[0].slice(0, 80) || `Modèle du ${new Date().toLocaleDateString("fr-FR")}`;
      const response = await authFetch("/api/workspace/prompt-templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Enregistrement impossible.");
      }
      const data = (await response.json()) as { template: ComposerPromptTemplate };
      setTemplates((current) => [data.template, ...(current ?? [])]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Enregistrement impossible.");
    } finally {
      setSaving(false);
    }
  }, [draft, saving]);

  const remove = useCallback(async (templateId: string) => {
    setError("");
    try {
      const response = await authFetch(`/api/workspace/prompt-templates/${templateId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Suppression impossible.");
      setTemplates((current) => (current ?? []).filter((template) => template.id !== templateId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Suppression impossible.");
    }
  }, []);

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Modèles de prompts"
        className="g3-chip !py-1 text-[11px] transition disabled:opacity-40"
        title="Vos modèles de prompts réutilisables"
      >
        <span aria-hidden>⚡</span>
        <span className="font-semibold">Modèles</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Bibliothèque de modèles de prompts"
          className="absolute bottom-full left-0 z-50 mb-2 w-[340px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-1.5 shadow-[var(--g3-glow-ring)]"
        >
          <p className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[.2em] text-[var(--g3-muted)]">
            Modèles de prompts
          </p>
          {error && <p className="px-2.5 pb-1.5 text-[10px] text-[var(--g3-danger-strong)]" role="alert">{error}</p>}
          <div className="max-h-64 overflow-y-auto g3-scroll">
            {loading ? (
              <p className="px-3 py-3 text-xs text-[var(--g3-faint)]">Chargement…</p>
            ) : (templates ?? []).length === 0 ? (
              <p className="px-3 py-3 text-xs text-[var(--g3-faint)]">
                Aucun modèle enregistré — rédigez un message puis « Enregistrer le brouillon ».
              </p>
            ) : (
              (templates ?? []).map((template) => (
                <div
                  key={template.id}
                  className="group flex w-full items-start gap-2 rounded-xl p-2.5 transition hover:bg-[var(--g3-hover)]"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onInsert(template.body);
                      setOpen(false);
                    }}
                    className="min-w-0 flex-1 text-left"
                    title="Insérer ce modèle dans le composer"
                  >
                    <span className="block truncate text-xs font-semibold text-[var(--g3-text)]">{template.title}</span>
                    <span className="mt-0.5 block truncate text-[10px] leading-4 text-[var(--g3-muted)]">
                      {template.body.replace(/\s+/g, " ").slice(0, 90)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(template.id)}
                    className="mt-0.5 shrink-0 rounded-lg px-1.5 py-1 text-[10px] text-[var(--g3-faint)] opacity-0 transition hover:bg-[var(--g3-danger-soft)] hover:text-[var(--g3-danger-strong)] group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={`Supprimer le modèle ${template.title}`}
                    title="Supprimer ce modèle"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="border-t border-[var(--g3-border)] p-1.5">
            <button
              type="button"
              role="menuitem"
              onClick={() => void saveCurrent()}
              disabled={!draft.trim() || saving}
              className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs font-semibold text-[var(--g3-text-secondary)] transition hover:bg-[var(--g3-hover)] disabled:opacity-40"
              title="Enregistrer le message en cours de rédaction comme modèle réutilisable"
            >
              <span aria-hidden>＋</span>
              {saving ? "Enregistrement…" : "Enregistrer le brouillon actuel"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
