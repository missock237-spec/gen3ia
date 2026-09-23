"use client";

import { useState } from "react";

import { NavIcon } from "@/components/ui/nav-icon";

import { RUN_STATUS_LABELS, RUN_STATUS_STYLES, STEP_STATUS_LABELS, STEP_STATUS_MARKS } from "./labels";
import type { ConversationRun, RunStep } from "@/lib/domain/conversations/types";

/**
 * Timeline d'exécution — blocs repliables affichés dans la conversation :
 * compréhension de la demande → plan proposé → outils sélectionnés →
 * approbation requise → exécution → résultat et artefacts.
 * Le détail technique reste replié par défaut pour ne pas envahir la lecture.
 */

const PHASE_ORDER = ["understanding", "plan", "tools", "approval", "execution", "result"] as const;
type Phase = (typeof PHASE_ORDER)[number];

const PHASE_LABELS: Record<Phase, string> = {
  understanding: "Compréhension",
  plan: "Plan proposé",
  tools: "Outils",
  approval: "Validation",
  execution: "Exécution",
  result: "Résultat",
};

const PHASE_ICONS: Record<Phase, string> = {
  understanding: "✦",
  plan: "◈",
  tools: "⚙",
  approval: "⚖",
  execution: "▶",
  result: "□",
};

function groupSteps(steps: RunStep[]): Array<{ phase: Phase; steps: RunStep[] }> {
  const groups = new Map<Phase, RunStep[]>();
  for (const step of steps) {
    const phase = (PHASE_ORDER.includes(step.phase as Phase) ? step.phase : "result") as Phase;
    const bucket = groups.get(phase) ?? [];
    bucket.push(step);
    groups.set(phase, bucket);
  }
  return PHASE_ORDER.filter((phase) => groups.has(phase)).map((phase) => ({ phase, steps: groups.get(phase)! }));
}

interface RunTimelineProps {
  run: ConversationRun;
  compact?: boolean;
}

export function RunTimeline({ run, compact = false }: RunTimelineProps) {
  const [openPhases, setOpenPhases] = useState<Set<Phase>>(() => new Set(["result"]));

  const toggle = (phase: Phase) => {
    setOpenPhases((current) => {
      const next = new Set(current);
      if (next.has(phase)) next.delete(phase);
      else next.add(phase);
      return next;
    });
  };

  const groups = groupSteps(run.steps);
  const pendingCount = run.steps.filter((s) => s.status === "awaiting").length;
  const doneCount = run.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const progress = run.steps.length ? Math.round((doneCount / run.steps.length) * 100) : 0;
  const isRunning = run.status === "running" || run.status === "planning";

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] shadow-[var(--g3-shadow-xs)]" data-run-id={run.id}>
      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`grid size-6 shrink-0 place-items-center rounded-md ${isRunning ? "bg-[var(--g3-accent-soft)] text-[var(--g3-accent)]" : "bg-[var(--g3-surface-2)] text-[var(--g3-muted)]"}`} aria-hidden>
            {isRunning ? <span className="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" /> : <NavIcon glyph="∿" size={13} />}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-[var(--g3-ink)]">{run.objective}</p>
            <p className="text-[11px] tabular-nums text-[var(--g3-muted)]">{doneCount}/{run.steps.length} étapes{pendingCount > 0 ? ` · ${pendingCount} validation(s) en attente` : ""}</p>
          </div>
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${RUN_STATUS_STYLES[run.status]}`}>
          {RUN_STATUS_LABELS[run.status]}
        </span>
      </div>
      <div className="h-0.5 bg-[var(--g3-surface-2)]" aria-hidden>
        <div className="h-full bg-[var(--g3-accent)] transition-[width] duration-500" style={{ width: `${progress}%` }} />
      </div>

      {compact ? (
        null
      ) : (
        <div className="divide-y divide-[var(--g3-border)] border-t border-[var(--g3-border)]">
          {groups.map(({ phase, steps }) => {
            const open = openPhases.has(phase);
            const allDone = steps.every((s) => s.status === "done" || s.status === "skipped");
            return (
              <div key={phase}>
                <button
                  type="button"
                  onClick={() => toggle(phase)}
                  className="flex w-full items-center justify-between gap-2 px-3.5 py-2 text-left transition-colors hover:bg-[var(--g3-bg)]"
                  aria-expanded={open}
                >
                  <span className="flex items-center gap-2 text-[12.5px] font-medium text-[var(--g3-ink-2)]">
                    <NavIcon glyph={PHASE_ICONS[phase]} size={14} className="text-[var(--g3-muted)]" />
                    {PHASE_LABELS[phase]}
                    <span className="text-[11px] font-normal tabular-nums text-[var(--g3-subtle)]">{steps.length}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    {allDone && (
                      <svg aria-label="Terminé" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-emerald-600"><path d="M20 6 9 17l-5-5" /></svg>
                    )}
                    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`text-[var(--g3-subtle)] transition-transform ${open ? "" : "-rotate-90"}`}><path d="m6 9 6 6 6-6" /></svg>
                  </span>
                </button>
                {open && (
                  <ul className="relative ml-[21px] space-y-2 border-l border-[var(--g3-border)] pb-3 pl-4 pr-3.5 pt-1">
                    {steps.map((step) => (
                      <li key={step.id} className="relative rounded-lg px-1 py-1">
                        <p className="flex items-start gap-2 text-[12.5px] font-medium text-[var(--g3-ink)]">
                          <span aria-hidden className={step.status === "failed" ? "text-red-500" : step.status === "done" ? "text-emerald-600" : "text-amber-600"}>
                            {STEP_STATUS_MARKS[step.status]}
                          </span>
                          <span className="flex-1">{step.title}</span>
                          <span className="shrink-0 text-[11px] font-normal text-[var(--g3-muted)]">{STEP_STATUS_LABELS[step.status]}</span>
                        </p>
                        {step.toolName && (
                          <p className="mt-1 pl-5 font-mono text-[11px] text-[var(--g3-muted)]">
                            outil : {step.toolName}
                          </p>
                        )}
                        {step.detail && <p className="mt-1 whitespace-pre-wrap pl-5 text-[12px] leading-relaxed text-[var(--g3-muted)]">{step.detail}</p>}
                        {step.output && (
                          <pre className="g3-code mt-1.5 ml-5 max-h-44 overflow-auto rounded-lg p-2 text-[10px] leading-relaxed">{step.output}</pre>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
