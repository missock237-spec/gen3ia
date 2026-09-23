"use client";

import { useState } from "react";

import { ArtifactPanel } from "./artifact-panel";
import { RunTimeline } from "./run-timeline";
import { RUN_STATUS_LABELS, RUN_STATUS_STYLES } from "./labels";
import type {
  ConversationApproval,
  ConversationArtifact,
  ConversationRun,
} from "@/lib/domain/conversations/types";
import type { WorkspaceProject } from "@/lib/domain/projects/repository";

/**
 * Panneau droit optionnel de la conversation : plan d'exécution en cours,
 * outils utilisés, validations, fichiers et livrables de la conversation.
 * Repliable pour laisser toute la largeur au fil de discussion.
 */

interface ContextDrawerProps {
  open: boolean;
  onToggle: () => void;
  conversationTitle: string;
  project?: WorkspaceProject | null;
  runs: ConversationRun[];
  approvals: ConversationApproval[];
  artifacts: ConversationArtifact[];
  onDecide: (approvalId: string, decision: "approved" | "rejected") => Promise<void>;
}

type Section = "plan" | "artifacts" | "info";

export function ContextDrawer({
  open,
  onToggle,
  conversationTitle,
  project,
  runs,
  approvals,
  artifacts,
  onDecide,
}: ContextDrawerProps) {
  const [section, setSection] = useState<Section>("plan");

  if (!open) {
    return (
      <div className="hidden flex-col items-center gap-2 py-2 lg:flex">
        <button
          type="button"
          onClick={onToggle}
          className="g3-btn g3-btn-ghost h-9 w-9 justify-center !px-0"
          title="Afficher le contexte (plan, fichiers, outils)"
          aria-label="Afficher le panneau de contexte"
        >
          «
        </button>
      </div>
    );
  }

  const latestRun = runs[0];
  const usedTools = Array.from(new Set(runs.flatMap((run) => run.steps.map((step) => step.toolName).filter(Boolean)))) as string[];
  const pending = approvals.filter((a) => a.status === "pending");

  return (
    <aside className="hidden h-full w-full flex-col gap-3 overflow-hidden lg:flex" aria-label="Contexte de la conversation">
      <div className="flex items-center justify-between gap-2">
        <p className="g3-eyebrow !text-[10px]">Contexte</p>
        <button
          type="button"
          onClick={onToggle}
          className="text-xs text-neutral-400 hover:text-neutral-700"
          title="Replier le panneau"
          aria-label="Replier le panneau de contexte"
        >
          »
        </button>
      </div>

      <div className="g3-card !p-3">
        <p className="truncate text-xs font-semibold text-neutral-800" title={conversationTitle}>
          {conversationTitle || "Sans titre"}
        </p>
        {project && (
          <p className="mt-1 truncate text-[11px] text-neutral-500" title={project.instructions ?? undefined}>
            ▦ {project.name}
            {project.instructions ? " · instructions actives" : ""}
          </p>
        )}
      </div>

      <div className="g3-tabs" role="tablist">
        {(
          [
            { id: "plan", label: `Plan${pending.length > 0 ? ` (${pending.length})` : ""}` },
            { id: "artifacts", label: `Livrables (${artifacts.length})` },
            { id: "info", label: "Détails" },
          ] as Array<{ id: Section; label: string }>
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={section === tab.id}
            data-active={section === tab.id}
            onClick={() => setSection(tab.id)}
            className="g3-tab text-[11px]"
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto pr-0.5">
        {section === "plan" && (
          <div className="space-y-3">
            {latestRun ? (
              <>
                <RunTimeline run={latestRun} />
                {pending.map((approval) => (
                  <div key={approval.id} className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
                    <p className="text-xs font-semibold text-neutral-900">⚖ {approval.title}</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-neutral-600">{approval.impact}</p>
                    <p className="mt-1 font-mono text-[10px] text-neutral-500">{approval.toolName}</p>
                    <button
                      type="button"
                      onClick={() => void onDecide(approval.id, "approved")}
                      className="g3-btn g3-btn-primary mt-2 w-full !min-h-0 !py-1.5 text-[11px]"
                    >
                      Approuver
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDecide(approval.id, "rejected")}
                      className="g3-btn g3-btn-danger mt-1.5 w-full !min-h-0 !py-1.5 text-[11px]"
                    >
                      Rejeter
                    </button>
                  </div>
                ))}
              </>
            ) : (
              <p className="text-[11px] leading-relaxed text-neutral-500">
                Aucune exécution pour l&apos;instant. Décrivez un objectif : Gen3ia proposera un plan lisible avec ses étapes, outils et validations.
              </p>
            )}
          </div>
        )}

        {section === "artifacts" && (
          <ArtifactPanel artifacts={artifacts} variant="sidebar" className="text-xs" />
        )}

        {section === "info" && (
          <div className="space-y-3 text-[11px] leading-relaxed text-neutral-600">
            <div>
              <p className="font-medium text-neutral-700">Runs de la conversation</p>
              {runs.length === 0 ? (
                <p className="text-neutral-500">Aucun run.</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {runs.map((run) => (
                    <li key={run.id} className="flex items-center justify-between gap-2 rounded-lg bg-neutral-50 px-2 py-1.5">
                      <span className="truncate">{run.objective}</span>
                      <span className={`shrink-0 rounded-full border px-1.5 text-[9px] ${RUN_STATUS_STYLES[run.status]}`}>
                        {RUN_STATUS_LABELS[run.status]}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="font-medium text-neutral-700">Outils utilisés</p>
              {usedTools.length === 0 ? (
                <p className="text-neutral-500">Aucun outil pour le moment.</p>
              ) : (
                <ul className="mt-1 flex flex-wrap gap-1">
                  {usedTools.map((tool) => (
                    <li key={tool} className="rounded-full border border-neutral-200 bg-white px-2 py-0.5 font-mono text-[10px]">
                      {tool}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {project?.privacyRules && (
              <div>
                <p className="font-medium text-neutral-700">Règles de confidentialité</p>
                <p className="mt-1 whitespace-pre-wrap rounded-lg bg-neutral-50 px-2 py-1.5">{project.privacyRules}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
