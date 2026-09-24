"use client";

import { Fragment } from "react";

import { ApprovalCard } from "./approval-card";
import { RunTimeline } from "./run-timeline";
import { MarkdownContent } from "./markdown";
import { formatBytes } from "./labels";
import { LiveAppPreviewButton } from "./artifact-preview";
import type {
  ConversationApproval,
  ConversationArtifact,
  ConversationMessage,
  ConversationRun,
} from "@/lib/domain/conversations/types";

/**
 * Fil de messages : bulles utilisateur/assistant, pièces jointes, citations,
 * images générées, timeline d'exécution inline (blocs repliables) et cartes
 * de validation inline pour les actions sensibles.
 */

interface MessageThreadProps {
  messages: ConversationMessage[];
  runs: ConversationRun[];
  approvals: ConversationApproval[];
  artifacts: ConversationArtifact[];
  /** Message en cours de génération (état « streaming » visuel). */
  generating: boolean;
  /** Texte de la réponse en cours d'écriture (streaming token par token). */
  streamingContent?: string;
  /** Libellé de la phase de travail en cours (analyse, exécution…). */
  streamingStatus?: string;
  /** Image générée pendant le tour en cours (affichée immédiatement). */
  liveImageUrl?: string;
  /** Run en cours de construction (timeline vivante du tour en cours). */
  liveRun?: ConversationRun | null;
  onDecide: (approvalId: string, decision: "approved" | "rejected") => Promise<void>;
}

export function MessageThread({
  messages,
  runs,
  approvals,
  artifacts,
  generating,
  streamingContent,
  streamingStatus,
  liveImageUrl,
  liveRun,
  onDecide,
}: MessageThreadProps) {
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const streaming = typeof streamingContent === "string";

  return (
    <div className="space-y-4">
      {messages.map((message) => {
        const run = message.runId ? runsById.get(message.runId) : undefined;
        const runApprovals = run ? approvals.filter((a) => a.runId === run.id) : [];
        const runArtifacts = run
          ? artifacts.filter((a) => a.runId === run.id || a.conversationId === message.conversationId && run.steps.some((s) => s.artifactId === a.id))
          : artifacts.filter((a) => a.conversationId === message.conversationId);
        const messageArtifacts = run
          ? run.steps.map((s) => (s.artifactId ? artifactsById.get(s.artifactId) : undefined)).filter((a): a is ConversationArtifact => !!a)
          : [];

        return (
          <Fragment key={message.id}>
            <article
              className={
                message.role === "user"
                  ? "ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-[var(--g3-deep)] px-4 py-2.5 text-sm text-white"
                  : "mr-auto max-w-[92%] rounded-2xl rounded-bl-md border border-[var(--g3-border)] bg-[var(--g3-surface)] px-4 py-3 text-sm text-[var(--g3-text)]"
              }
              data-role={message.role}
            >
              {message.role === "assistant" ? (
                <div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                  <MarkdownContent content={message.content} />
                </div>
              ) : (
                <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
              )}

              {message.imageUrl && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={message.imageUrl}
                  alt="Image générée par Gen3ia"
                  className="mt-2.5 max-h-96 w-full rounded-xl border border-[var(--g3-border)] object-contain"
                  loading="lazy"
                />
              )}

              {message.attachments && message.attachments.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {message.attachments.map((attachment, index) => (
                    <li
                      key={`${message.id}-att-${index}`}
                      className={`inline-flex max-w-[220px] items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] ${
                        message.role === "user" ? "bg-[var(--g3-surface)]/15 text-white" : "border border-[var(--g3-border)] bg-[var(--g3-elevated)] text-[var(--g3-text-secondary)]"
                      }`}
                    >
                      <span aria-hidden>📎</span>
                      <span className="truncate">{attachment.filename}</span>
                      {attachment.sizeBytes ? <span className="opacity-60">{formatBytes(attachment.sizeBytes)}</span> : null}
                    </li>
                  ))}
                </ul>
              )}

              {message.citations && message.citations.length > 0 && (
                <div className="mt-2.5 border-t border-[var(--g3-border)] pt-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--g3-faint)]">Sources</p>
                  <ul className="mt-1 space-y-0.5">
                    {message.citations.map((citation, index) => (
                      <li key={`${message.id}-cit-${index}`} className="text-[11px] text-[var(--g3-muted)]">
                        {citation.url ? (
                          <a href={citation.url} target="_blank" rel="noopener noreferrer" className="text-sky-700 underline underline-offset-2">
                            {citation.source}
                          </a>
                        ) : (
                          <span>{citation.source}</span>
                        )}
                        {citation.snippet ? <span className="text-[var(--g3-faint)]"> — {citation.snippet.slice(0, 120)}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {messageArtifacts.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {messageArtifacts.map((artifact) => (
                    <li
                      key={artifact.id}
                      className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-2.5 py-1 text-[11px] text-[var(--g3-text-secondary)]"
                    >
                      <span aria-hidden>▣</span>
                      <span className="truncate">{artifact.title}</span>
                    </li>
                  ))}
                </ul>
              )}

              {/* Application créée par l'agent → aperçu en direct dans la conversation */}
              {messageArtifacts.map((artifact) => (
                <LiveAppPreviewButton key={`live-${artifact.id}`} artifact={artifact} />
              ))}
            </article>

            {run && <RunTimeline run={run} />}
            {runApprovals.filter((a) => a.status === "pending").map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} onDecide={onDecide} disabled={generating} />
            ))}
          </Fragment>
        );
      })}

      {liveRun && <RunTimeline run={liveRun} />}

      {streaming && (
        <div aria-live="polite">
          <article className="mr-auto max-w-[92%] rounded-2xl rounded-bl-md border border-[var(--g3-border)] bg-[var(--g3-surface)] px-4 py-3 text-sm text-[var(--g3-text)]">
            {streamingContent.length > 0 ? (
              <div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                <MarkdownContent content={streamingContent} />
                <span className="g3-caret" aria-hidden />
              </div>
            ) : (
              <span className="g3-dots" aria-hidden>
                <span /><span /><span />
              </span>
            )}
            {liveImageUrl && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={liveImageUrl}
                alt="Image générée par Gen3ia"
                className="mt-2.5 max-h-96 w-full rounded-xl border border-[var(--g3-border)] object-contain"
              />
            )}
          </article>
          {streamingStatus && (
            <p className="mt-1.5 flex items-center gap-1.5 pl-1 text-[11px] text-[var(--g3-muted)]">
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-neutral-400" aria-hidden />
              {streamingStatus}
            </p>
          )}
        </div>
      )}

      {generating && !streaming && (
        <div className="mr-auto flex items-center gap-2 rounded-2xl rounded-bl-md border border-[var(--g3-border)] bg-[var(--g3-surface)] px-4 py-3" aria-live="polite">
          <span className="g3-dots" aria-hidden>
            <span /><span /><span />
          </span>
          <span className="text-xs text-[var(--g3-muted)]">{streamingStatus || "Gen3ia travaille…"}</span>
        </div>
      )}
    </div>
  );
}
