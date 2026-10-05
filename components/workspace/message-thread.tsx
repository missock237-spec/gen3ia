"use client";

import { Fragment, memo, useMemo } from "react";

import { ApprovalCard } from "./approval-card";
import { RunTimeline } from "./run-timeline";
import { MarkdownContent } from "./markdown";
import { formatBytes } from "./labels";
import { downloadUrl } from "@/lib/client/download";
import { LiveAppPreviewButton } from "./artifact-preview";
import { MediaProgressFrame } from "@/components/media/media-progress-frame";
import { VideoProductionCard } from "./video-production-card";
import { Gen3iaLogo } from "@/components/brand/gen3ia-logo";
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
 *
 * Performance (audit 2-a, lot C1) : le fil est re-rendu à CHAQUE token de
 * streaming. Les lignes déjà affichées sont mémoïsées (React.memo + props
 * stables précalculées : runs/approvals/artefacts indexés par Map) et le
 * rendu markdown est mémoïsé PAR CONTENU — seul le message en cours
 * d'écriture est re-parsé, jamais les N-1 messages reçus.
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
  /** Progression RÉELLE média (étapes serveur image) du tour en cours. */
  liveMedia?: { label: string; stage?: string; percent?: number | null } | null;
  /** Artefacts vidéo du tour en cours (production autopilotée à suivre). */
  liveVideoArtifacts?: ConversationArtifact[];
  /** Run en cours de construction (timeline vivante du tour en cours). */
  liveRun?: ConversationRun | null;
  onDecide: (approvalId: string, decision: "approved" | "rejected") => Promise<void>;
  /**
   * Étape 8 — demande d'édition d'une image affichée dans le fil : le
   * parent injecte l'image comme attachment réel du composer.
   */
  onEditImage?: (image: { url?: string; path?: string; filename?: string }) => void;
}

/** Références stables pour les lignes sans run/approval/artefact (memo). */
const EMPTY_APPROVALS: ConversationApproval[] = [];
const EMPTY_ARTIFACTS: ConversationArtifact[] = [];

/** Rendu markdown mémoïsé PAR CONTENU : un message persisté (contenu stable)
 * ne re-parse jamais son markdown pendant le streaming du message courant. */
const MemoizedMarkdown = memo(function MemoizedMarkdown({ content }: { content: string }) {
  return <MarkdownContent content={content} />;
});

interface MessageRowProps {
  message: ConversationMessage;
  run: ConversationRun | undefined;
  runApprovals: ConversationApproval[];
  messageArtifacts: ConversationArtifact[];
  generating: boolean;
  onDecide: (approvalId: string, decision: "approved" | "rejected") => Promise<void>;
  onEditImage?: (image: { url?: string; path?: string; filename?: string }) => void;
}

/** Ligne de message mémoïsée : pendant le streaming, seule la bulle en cours
 * d'écriture se re-rend — les lignes déjà reçues sont sautées. */
const MessageRow = memo(function MessageRow({
  message,
  run,
  runApprovals,
  messageArtifacts,
  generating,
  onDecide,
  onEditImage,
}: MessageRowProps) {
  return (
    <Fragment>
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
            <MemoizedMarkdown content={message.content} />
          </div>
        ) : (
          <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
        )}

        {message.imageUrl && (
          <figure className="mt-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={message.imageUrl}
              alt="Image générée par Gen3ia"
              className="max-h-96 w-full rounded-xl border border-[var(--g3-border)] object-contain"
              loading="lazy"
            />
            <figcaption className="mt-1 flex justify-end gap-1.5">
              {onEditImage && (
                <button
                  type="button"
                  onClick={() => onEditImage({ url: message.imageUrl, filename: `image-gen3ia-${Date.now()}.png` })}
                  className="inline-flex items-center gap-1 rounded-full border border-[var(--g3-border)] bg-[var(--g3-surface)] px-2.5 py-1 text-[10px] font-medium text-[var(--g3-muted)] transition hover:border-[var(--g3-border-strong)] hover:text-[var(--g3-text)]"
                >
                  <span aria-hidden>✎</span> Éditer l&apos;image
                </button>
              )}
              <button
                type="button"
                onClick={() => void downloadUrl(message.imageUrl as string, `image-gen3ia-${Date.now()}.png`)}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--g3-border)] bg-[var(--g3-surface)] px-2.5 py-1 text-[10px] font-medium text-[var(--g3-muted)] transition hover:border-[var(--g3-border-strong)] hover:text-[var(--g3-text)]"
              >
                <span aria-hidden>⬇</span> Télécharger l&apos;image
              </button>
            </figcaption>
          </figure>
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
});

export function MessageThread({
  messages,
  runs,
  approvals,
  artifacts,
  generating,
  streamingContent,
  streamingStatus,
  liveImageUrl,
  liveMedia,
  liveVideoArtifacts,
  liveRun,
  onDecide,
  onEditImage,
}: MessageThreadProps) {
  // Index précalculés (O(n)) : fin du approvals.filter imbriqué dans la map
  // (O(n²)) — chaque ligne reçoit des props à identité stable (memo efficace).
  const runsById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const artifactsById = useMemo(() => new Map(artifacts.map((artifact) => [artifact.id, artifact])), [artifacts]);
  const approvalsByRunId = useMemo(() => {
    const map = new Map<string, ConversationApproval[]>();
    for (const approval of approvals) {
      const list = map.get(approval.runId);
      if (list) list.push(approval);
      else map.set(approval.runId, [approval]);
    }
    return map;
  }, [approvals]);
  const artifactsByRunId = useMemo(() => {
    const map = new Map<string, ConversationArtifact[]>();
    for (const run of runs) {
      const list = run.steps
        .map((s) => (s.artifactId ? artifactsById.get(s.artifactId) : undefined))
        .filter((a): a is ConversationArtifact => !!a);
      map.set(run.id, list);
    }
    return map;
  }, [runs, artifactsById]);
  const streaming = typeof streamingContent === "string";
  // Artefacts vidéo PERSISTÉS de la conversation (reprise après refresh :
  // la carte continue de suivre la production réelle et fait avancer la
  // file par sondage tant qu'elle est affichée).
  const persistedVideoArtifacts = useMemo(
    () => artifacts.filter((artifact) => artifact.type === "video" && artifact.videoProjectId),
    [artifacts],
  );

  return (
    <div className="space-y-4">
      {messages.map((message) => {
        const run = message.runId ? runsById.get(message.runId) : undefined;
        const runApprovals = run ? approvalsByRunId.get(run.id) ?? EMPTY_APPROVALS : EMPTY_APPROVALS;
        const messageArtifacts = run ? artifactsByRunId.get(run.id) ?? EMPTY_ARTIFACTS : EMPTY_ARTIFACTS;

        return (
          <MessageRow
            key={message.id}
            message={message}
            run={run}
            runApprovals={runApprovals}
            messageArtifacts={messageArtifacts}
            generating={generating}
            onDecide={onDecide}
            onEditImage={onEditImage}
          />
        );
      })}

      {/* Cartes de production vidéo PERSISTÉES (reprise après refresh) :
          chaque artefact vidéo de la conversation continue d'afficher la
          progression réelle et le lecteur dès que le rendu est terminé. */}
      {persistedVideoArtifacts.length > 0 && (
        <div className="space-y-3">
          {persistedVideoArtifacts.map((artifact) => (
            <VideoProductionCard key={`persisted-video-${artifact.id}`} videoProjectId={artifact.videoProjectId as string} title={artifact.title} />
          ))}
        </div>
      )}

      {liveRun && <RunTimeline run={liveRun} />}

      {/* Cadre de progression RÉELLE des générations médias (image) : étapes
          serveur réelles (amélioration → génération → enregistrement) avec
          pourcentage, affiché tant que le média n'est pas terminé. */}
      {streaming && liveMedia && liveMedia.stage !== "complete" && (
        <div className="mr-auto w-full max-w-[92%]">
          <MediaProgressFrame
            status={liveMedia.stage === "failed" ? "failed" : "running"}
            stageLabel={liveMedia.label}
            percent={liveMedia.percent ?? null}
            tone="dark"
          />
        </div>
      )}

      {/* Cartes de production vidéo du tour EN COURS (temps réel). */}
      {(liveVideoArtifacts ?? []).map((artifact) => (
        <VideoProductionCard key={`live-video-${artifact.id}`} videoProjectId={artifact.videoProjectId as string} title={artifact.title} />
      ))}

      {streaming && (
        <div aria-live="polite" className="mr-auto flex items-start gap-2">
          <Gen3iaLogo size={28} working alt="" className="mt-1" />
          <div className="min-w-0 max-w-[92%]">
            <article className="rounded-2xl rounded-bl-md border border-[var(--g3-border)] bg-[var(--g3-surface)] px-4 py-3 text-sm text-[var(--g3-text)]">
            {streamingContent.length > 0 ? (
              <div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                <MemoizedMarkdown content={streamingContent} />
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
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-[var(--g3-primary-strong)]" aria-hidden />
              {streamingStatus}
            </p>
          )}
          </div>
        </div>
      )}

      {generating && !streaming && (
        <div className="mr-auto flex items-center gap-2 rounded-2xl rounded-bl-md border border-[var(--g3-border)] bg-[var(--g3-surface)] px-4 py-3" aria-live="polite">
          <Gen3iaLogo size={26} working alt="" />
          <span className="g3-dots" aria-hidden>
            <span /><span /><span />
          </span>
          <span className="text-xs text-[var(--g3-muted)]">{streamingStatus || "L'agent travaille…"}</span>
        </div>
      )}
    </div>
  );
}
