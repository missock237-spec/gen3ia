"use client";

import { useState } from "react";

import { RUN_STATUS_LABELS, RUN_STATUS_STYLES, STEP_STATUS_LABELS, STEP_STATUS_MARKS } from "./labels";
import type { ConversationRun, RunStep } from "@/lib/domain/conversations/types";
import { Gen3iaLogo } from "@/components/brand/gen3ia-logo";

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
  understanding: "◎",
  plan: "≡",
  tools: "⚙",
  approval: "⚖",
  execution: "▸",
  result: "▣",
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

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)]/70" data-run-id={run.id}>
      <div className="flex items-center justify-between gap-2 border-b border-[var(--g3-border)] bg-[var(--g3-elevated)]/70 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {run.status === "running" ? (
            <Gen3iaLogo size={18} working alt="" />
          ) : (
            <span className="g3-side-icon shrink-0" aria-hidden>◷</span>
          )}
          <p className="truncate text-xs font-medium text-[var(--g3-text-secondary)]">{run.objective}</p>
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${RUN_STATUS_STYLES[run.status]}`}>
          {RUN_STATUS_LABELS[run.status]}
        </span>
      </div>

      {compact ? (
        <div className="px-3 py-2">
          <p className="text-[11px] leading-relaxed text-[var(--g3-muted)]">
            {run.steps.filter((s) => s.status === "done").length}/{run.steps.length} étapes
            {pendingCount > 0 ? ` · ${pendingCount} validation(s) en attente` : ""}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-neutral-100">
          {groups.map(({ phase, steps }) => {
            const open = openPhases.has(phase);
            const allDone = steps.every((s) => s.status === "done" || s.status === "skipped");
            return (
              <div key={phase}>
                <button
                  type="button"
                  onClick={() => toggle(phase)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--g3-elevated)]"
                  aria-expanded={open}
                >
                  <span className="flex items-center gap-2 text-xs font-medium text-[var(--g3-text-secondary)]">
                    <span className="g3-side-icon" aria-hidden>{PHASE_ICONS[phase]}</span>
                    {PHASE_LABELS[phase]}
                    <span className="text-[10px] font-normal text-[var(--g3-faint)]">({steps.length})</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={`text-[10px] ${allDone ? "text-emerald-600" : "text-[var(--g3-faint)]"}`}>
                      {allDone ? "✓" : open ? "▾" : "▸"}
                    </span>
                  </span>
                </button>
                {open && (
                  <ul className="space-y-2 px-3 pb-3 pt-1">
                    {steps.map((step) => (
                      <li key={step.id} className="rounded-lg bg-[var(--g3-elevated)] px-3 py-2">
                        <p className="flex items-start gap-2 text-xs font-medium text-[var(--g3-text)]">
                          <span aria-hidden className={step.status === "failed" ? "text-red-500" : step.status === "done" ? "text-emerald-600" : "text-amber-600"}>
                            {STEP_STATUS_MARKS[step.status]}
                          </span>
                          <span className="flex-1">{step.title}</span>
                          <span className="shrink-0 text-[10px] font-normal text-[var(--g3-muted)]">{STEP_STATUS_LABELS[step.status]}</span>
                        </p>
                        {step.toolName && (
                          <p className="mt-1 pl-5 font-mono text-[10px] text-[var(--g3-muted)]">
                            outil : {step.toolName}
                          </p>
                        )}
                        {step.detail && <p className="mt-1 whitespace-pre-wrap pl-5 text-[11px] leading-relaxed text-[var(--g3-muted)]">{step.detail}</p>}
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
