"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Task 141 — sélecteur d'agent du composer conversationnel.
 *
 * Un même chat, plusieurs personnalités : l'utilisateur choisit QUI répond au
 * prochain message — « Gen IA » (l'agent universel de la plateforme) ou l'un
 * de ses agents dédiés (persona, compétences, garde-fous, modèle préféré).
 *
 * Flexibilité : le choix est PAR MESSAGE (comme le contexte projet) et peut
 * changer en cours de conversation — le fil affiche l'agent de chaque tour.
 * Simplicité : une pill au-dessus du champ, la commande « /agent » dans le
 * champ, et le repli silencieux sur Gen IA si l'agent disparaît.
 */

/** Option d'agent affichée dans le sélecteur (résumé allégé côté client). */
export interface ComposerAgentOption {
  id: string;
  name: string;
  description?: string;
  typeLabel?: string;
  status: string;
  agentMode?: string;
}

interface AgentPickerProps {
  /** Agents actifs de l'utilisateur (chargés par le parent). */
  agents: ComposerAgentOption[];
  /** Agent choisi pour le prochain message (undefined = Gen IA universel). */
  agentId?: string;
  onChange: (agentId: string | undefined) => void;
  disabled?: boolean;
  /** Ouverture contrôlée (commande « /agent » du composer) — facultatif. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function AgentPicker({ agents, agentId, onChange, disabled = false, open: controlledOpen, onOpenChange }: AgentPickerProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    setInternalOpen(next);
    onOpenChange?.(next);
  };
  const rootRef = useRef<HTMLDivElement>(null);

  // Fermeture au clic extérieur / Échap (même contrat que les menus du composer).
  // setOpen est une fonction stable en comportement (recréée au rendu) : la
  // ré-attacher à chaque rendu serait du bruit sans effet observable.
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

  // Garde : l'agent sélectionné qui disparaît de la liste (supprimé, archivé)
  // ramène le sélecteur sur Gen IA — jamais d'état fantôme.
  const selected = agents.find((agent) => agent.id === agentId) ?? null;
  useEffect(() => {
    if (agentId && !selected) onChange(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, selected]);

  const selectable = agents.filter((agent) => agent.status === "active" && agent.agentMode !== "call");

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Choisir l'agent qui répond"
        className="g3-chip !py-1 text-[11px] transition disabled:opacity-40"
        data-selected={selected ? "true" : undefined}
        title={selected ? `Agent : ${selected.name}` : "Gen IA — agent universel (par défaut)"}
      >
        <span aria-hidden>{selected ? "◈" : "✦"}</span>
        <span className="max-w-[180px] truncate font-semibold">
          {selected ? selected.name : "Gen IA"}
        </span>
        <span aria-hidden className="text-[var(--g3-faint)]">▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Agent qui répond au prochain message"
          className="absolute bottom-full left-0 z-50 mb-2 w-[320px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-1.5 shadow-[var(--g3-glow-ring)]"
        >
          <p className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[.2em] text-[var(--g3-muted)]">
            Qui répond ?
          </p>
          <div className="max-h-72 overflow-y-auto g3-scroll">
            <button
              type="button"
              role="option"
              aria-selected={!agentId}
              onClick={() => {
                onChange(undefined);
                setOpen(false);
              }}
              className={
                "flex w-full items-start gap-2.5 rounded-xl p-2.5 text-left transition " +
                (!agentId ? "bg-[var(--g3-hover)]" : "hover:bg-[var(--g3-hover)]")
              }
            >
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--g3-deep)] text-xs" aria-hidden>
                ✦
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-semibold text-[var(--g3-text)]">Gen IA</span>
                <span className="mt-0.5 block text-[10px] leading-4 text-[var(--g3-muted)]">
                  L&apos;agent universel de Gen3ia — toutes les capacités, sans spécialisation.
                </span>
              </span>
            </button>

            {selectable.length === 0 ? (
              <p className="px-3 py-3 text-xs text-[var(--g3-faint)]">
                Aucun agent dédié actif — créez-en un dans le Studio pour personnaliser les réponses.
              </p>
            ) : (
              selectable.map((agent) => {
                const isSelected = agent.id === agentId;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onChange(agent.id);
                      setOpen(false);
                    }}
                    className={
                      "flex w-full items-start gap-2.5 rounded-xl p-2.5 text-left transition " +
                      (isSelected ? "bg-[var(--g3-hover)]" : "hover:bg-[var(--g3-hover)]")
                    }
                  >
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--g3-primary-soft)] text-xs" aria-hidden>
                      ◈
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-semibold text-[var(--g3-text)]">
                        {agent.name}
                        {agent.typeLabel ? (
                          <span className="ml-1.5 font-normal text-[var(--g3-faint)]">· {agent.typeLabel}</span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block line-clamp-2 text-[10px] leading-4 text-[var(--g3-muted)]">
                        {agent.description || "Agent dédié — persona et compétences personnalisées."}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {/* Task 143 — axe 3 : conversation VOCALE avec l'agent choisi —
              session micro temps réel (STT + réponse + TTS), partage d'écran
              optionnel : l'agent voit l'écran ET parle. */}
          <div className="mt-1 border-t border-[var(--g3-border)] px-2.5 pb-1 pt-2">
            <a
              href={agentId ? `/live/voix?agent=${encodeURIComponent(agentId)}` : "/live/voix"}
              className="flex items-center gap-2 rounded-xl px-1 py-1.5 text-[11px] font-semibold text-[var(--g3-primary-strong)] transition hover:bg-[var(--g3-hover)]"
              title="Ouvrir une session vocale en direct avec cet agent"
            >
              <span aria-hidden>🎙</span>
              {agentId ? "Parler avec cet agent (vocal)" : "Mode vocal (Gen IA)"}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
