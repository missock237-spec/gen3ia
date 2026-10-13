"use client";

import { useEffect, useRef } from "react";

import { COMPOSER_MODEL_OPTIONS } from "@/lib/ui/composer-models";

/**
 * Task 141 — menu « /moteur » : choix du modèle IA qui rédige la réponse.
 *
 * Une pill discrète au-dessus du composer (« Moteur : Automatique ▾ ») et les
 * mêmes options via la commande « /moteur ». « Automatique » (défaut) laisse
 * le routeur résilient de Gen3ia choisir — les autres options fixent le
 * couple provider/model pour CE message, sans engagement (re-chongeable à
 * tout moment, jamais persisté côté serveur).
 */

interface ModelMenuProps {
  /** Identifiant de l'option choisie (undefined/null = automatique). */
  modelId?: string;
  onChange: (modelId: string | undefined) => void;
  /** Ouverture contrôlée (commande « /moteur ») — facultatif. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}

export function ModelMenu({ modelId, onChange, open: controlledOpen, onOpenChange, disabled = false }: ModelMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const open = controlledOpen ?? false;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onOpenChange?.(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange?.(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  const selected = COMPOSER_MODEL_OPTIONS.find((option) => option.id === modelId) ?? COMPOSER_MODEL_OPTIONS[0];

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onOpenChange?.(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Choisir le modèle IA"
        className="g3-chip !py-1 text-[11px] transition disabled:opacity-40"
        title="Modèle IA qui rédige les réponses"
      >
        <span aria-hidden>⚙</span>
        <span className="max-w-[160px] truncate font-semibold">Moteur : {selected.label}</span>
        <span aria-hidden className="text-[var(--g3-faint)]">▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Modèle IA de la réponse"
          className="absolute bottom-full left-0 z-50 mb-2 w-[320px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-1.5 shadow-[var(--g3-glow-ring)]"
        >
          <p className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[.2em] text-[var(--g3-muted)]">
            Moteur de réponse
          </p>
          <div className="max-h-64 overflow-y-auto g3-scroll">
            {COMPOSER_MODEL_OPTIONS.map((option) => {
              const isSelected = option.id === selected.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onChange(option.id === "auto" ? undefined : option.id);
                    onOpenChange?.(false);
                  }}
                  className={
                    "flex w-full items-start gap-2.5 rounded-xl p-2.5 text-left transition " +
                    (isSelected ? "bg-[var(--g3-hover)]" : "hover:bg-[var(--g3-hover)]")
                  }
                >
                  <span
                    className="mt-1 h-2 w-2 shrink-0 rounded-full"
                    style={{ background: isSelected ? "var(--g3-primary)" : "var(--g3-faint)" }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold text-[var(--g3-text)]">{option.label}</span>
                    <span className="mt-0.5 block text-[10px] leading-4 text-[var(--g3-muted)]">{option.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
