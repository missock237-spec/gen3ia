"use client";

import { Fragment, useState } from "react";

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
  liveRun,
  onDecide,
}: MessageThreadProps) {
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const streaming = typeof streamingContent === "string";

  return (
    <div className="space-y-6">
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
            <div className={message.role === "user" ? "group flex justify-end" : "group flex gap-3"}>
            {message.role !== "user" && <AssistantAvatar />}
            <article
              className={
                message.role === "user"
                  ? "max-w-[85%] rounded-[18px] rounded-br-md bg-[var(--g3-surface-2)] px-4 py-2.5 text-[14.5px] leading-relaxed text-[var(--g3-ink)]"
                  : "min-w-0 flex-1 pt-0.5 text-[14.5px] leading-7 text-[var(--g3-ink-2)]"
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
                  className="mt-2.5 max-h-96 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] object-contain"
                  loading="lazy"
                />
              )}

              {message.attachments && message.attachments.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {message.attachments.map((attachment, index) => (
                    <li
                      key={`${message.id}-att-${index}`}
                      className={`inline-flex max-w-[220px] items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] ${
                        message.role === "user" ? "border border-[var(--g3-border)] bg-[var(--g3-surface)] text-[var(--g3-ink-2)]" : "border border-[var(--g3-border)] bg-[var(--g3-surface)] text-[var(--g3-ink-2)]"
                      }`}
                    >
                      <PaperclipIcon />
                      <span className="truncate">{attachment.filename}</span>
                      {attachment.sizeBytes ? <span className="opacity-60">{formatBytes(attachment.sizeBytes)}</span> : null}
                    </li>
                  ))}
                </ul>
              )}

              {message.citations && message.citations.length > 0 && (
                <div className="mt-2.5 border-t border-[var(--g3-border)] pt-2">
                  <p className="text-[11px] font-medium text-[var(--g3-muted)]">Sources</p>
                  <ul className="mt-1 space-y-0.5">
                    {message.citations.map((citation, index) => (
                      <li key={`${message.id}-cit-${index}`} className="text-[11px] text-neutral-500">
                        {citation.url ? (
                          <a href={citation.url} target="_blank" rel="noopener noreferrer" className="text-[var(--g3-accent)] underline decoration-[var(--g3-accent-ring)] underline-offset-2 hover:decoration-[var(--g3-accent)]">
                            {citation.source}
                          </a>
                        ) : (
                          <span>{citation.source}</span>
                        )}
                        {citation.snippet ? <span className="text-neutral-400"> — {citation.snippet.slice(0, 120)}</span> : null}
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
                      className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-[var(--g3-border)] bg-[var(--g3-surface)] px-2.5 py-1 text-[11px] text-[var(--g3-ink-2)] shadow-[var(--g3-shadow-xs)]"
                    >
                      <FileIcon />
                      <span className="truncate">{artifact.title}</span>
                    </li>
                  ))}
                </ul>
              )}

              {/* Application créée par l'agent → aperçu en direct dans la conversation */}
              {messageArtifacts.map((artifact) => (
                <LiveAppPreviewButton key={`live-${artifact.id}`} artifact={artifact} />
              ))}

              {message.role === "assistant" && message.content && (
                <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <CopyButton text={message.content} />
                </div>
              )}
            </article>
            </div>

            {(run || runApprovals.some((a) => a.status === "pending")) && (
              <div className="pl-10">
                {run && <RunTimeline run={run} />}
                {runApprovals.filter((a) => a.status === "pending").map((approval) => (
                  <ApprovalCard key={approval.id} approval={approval} onDecide={onDecide} disabled={generating} />
                ))}
              </div>
            )}
          </Fragment>
        );
      })}

      {liveRun && <div className="pl-10"><RunTimeline run={liveRun} /></div>}

      {streaming && (
        <div aria-live="polite" className="flex gap-3">
          <AssistantAvatar active />
          <div className="min-w-0 flex-1">
          <article className="pt-0.5 text-[14.5px] leading-7 text-[var(--g3-ink-2)]">
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
          </article>
          {streamingStatus && (
            <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-[var(--g3-muted)]">
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-[var(--g3-accent)]" aria-hidden />
              <span className="g3-shimmer-text">{streamingStatus}</span>
            </p>
          )}
          </div>
        </div>
      )}

      {generating && !streaming && (
        <div className="flex items-center gap-3" aria-live="polite">
          <AssistantAvatar active />
          <span className="g3-shimmer-text text-[13px] text-[var(--g3-muted)]">{streamingStatus || "Gen3ia travaille…"}</span>
        </div>
      )}
    </div>
  );
}

function AssistantAvatar({ active = false }: { active?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-[var(--g3-ink)] text-[9px] font-bold tracking-tight text-white shadow-[var(--g3-shadow-sm)] ${active ? "g3-avatar-pulse" : ""}`}
    >
      G3
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } catch {
          /* presse-papiers indisponible */
        }
      }}
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-[var(--g3-muted)] transition-colors hover:bg-[var(--g3-surface-2)] hover:text-[var(--g3-ink)]"
      aria-label={copied ? "Réponse copiée" : "Copier la réponse"}
    >
      <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {copied ? <path d="M20 6 9 17l-5-5" /> : <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>}
      </svg>
      {copied ? "Copié" : "Copier"}
    </button>
  );
}

function PaperclipIcon() {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-70"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" /></svg>
  );
}

function FileIcon() {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--g3-accent)]"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>
  );
}
