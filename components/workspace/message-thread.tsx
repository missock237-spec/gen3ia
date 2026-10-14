"use client";

import { Fragment, memo, useCallback, useMemo, useState } from "react";

import { ApprovalCard } from "./approval-card";
import { RunTimeline } from "./run-timeline";
import { ConnectorConnectCard } from "./connector-connect-card";
import { MarkdownContent } from "./markdown";
import { formatBytes } from "./labels";
import { downloadUrl } from "@/lib/client/download";
import { AudioDelivery, attachAudioArtifactsToMessages } from "./audio-delivery";
import { LiveAppPreviewButton } from "./artifact-preview";
import { MediaProgressFrame } from "@/components/media/media-progress-frame";
import { VideoProductionCard } from "./video-production-card";
import { Gen3iaLogo } from "@/components/brand/gen3ia-logo";
import { ResponseAdSlot } from "@/components/ads/response-ad-slot";
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
  /** Task 141 — injecte un texte dans le composer (chip de suivi, « Réutiliser »). */
  onPrefill?: (text: string) => void;
  /** Task 141 — régénère la dernière réponse (renvoie le dernier message utilisateur). */
  onRegenerate?: () => void;
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
  /** Artefacts audio livrés DIRECTEMENT avec ce message (lecteur intégré). */
  audioArtifacts: ConversationArtifact[];
  generating: boolean;
  onDecide: (approvalId: string, decision: "approved" | "rejected") => Promise<void>;
  onEditImage?: (image: { url?: string; path?: string; filename?: string }) => void;
  onPrefill?: (text: string) => void;
  onRegenerate?: () => void;
  /** Dernière réponse résolue du fil : c'est là que vivent « Régénérer » et
   * les chips de suivi (Task 141) — jamais sur les anciennes réponses. */
  isLastResolvedAssistant?: boolean;
  /**
   * Contexte de ciblage publicitaire (Gen Ads contextuel) : la demande qui a
   * déclenché cette réponse + un extrait de la réponse — la publicité
   * affichée doit présenter une SIMILITUDE avec ce contexte.
   */
  adContext?: string;
}

/** Ligne de message mémoïsée : pendant le streaming, seule la bulle en cours
 * d'écriture se re-rend — les lignes déjà reçues sont sautées. */
const MessageRow = memo(function MessageRow({
  message,
  run,
  runApprovals,
  messageArtifacts,
  audioArtifacts,
  generating,
  onDecide,
  onEditImage,
  onPrefill,
  onRegenerate,
  isLastResolvedAssistant = false,
  adContext,
}: MessageRowProps) {
  // Task 141 — retour visuel du bouton « Copier » (✓ pendant 1,5 s).
  const [copied, setCopied] = useState(false);
  const copyContent = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* presse-papiers indisponible : aucune action */
    }
  }, [message.content]);

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
        {/* Task 141 — badge de l'agent dédié qui a rédigé cette réponse : la
            traçabilité visuelle de QUI a répondu, tour après tour. */}
        {message.role === "assistant" && message.agentName && (
          <p className="mb-1.5 inline-flex items-center gap-1 rounded-full border border-[var(--g3-primary-border)] bg-[var(--g3-primary-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--g3-primary-strong)]">
            <span aria-hidden>◈</span> {message.agentName}
          </p>
        )}
        {message.role === "assistant" ? (
          <div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            {/* Task 135 — question de clarification 🔄 : encart distinct pour que
                l'utilisateur comprenne qu'une RÉPONSE est attendue (jamais
                confondue avec un livrable ou une réponse finale). */}
            {message.content.trim().startsWith("🔄 Précision") && (
              <p className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                <span aria-hidden>🔄</span> Précision demandée — votre réponse est attendue
              </p>
            )}
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
                    <a href={citation.url} target="_blank" rel="noopener noreferrer" className="text-[var(--g3-info)] underline underline-offset-2">
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
            {/* Les artefacts AUDIO ne sont PAS répétés en pastille : ils sont
                livrés DIRECTEMENT ci-dessous en lecteur intégré (Task 123). */}
            {messageArtifacts.filter((artifact) => artifact.type !== "audio").map((artifact) => (
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

        {/* LIVRAISON DIRECTE DE L'AUDIO (Task 123) : un VRAI lecteur HTML5
            par artefact audio du message — source résolue à la demande depuis
            la clé R2 permanente (storagePath), plus un téléchargement direct.
            S'affiche même sans texte explicite : l'existence de l'artefact
            audio EST la livraison. */}
        {audioArtifacts.map((artifact) => (
          <AudioDelivery
            key={`audio-${artifact.id}`}
            title={artifact.title}
            storagePath={artifact.storagePath}
            url={artifact.url}
            filename={artifact.filename}
          />
        ))}

        {/* Application créée par l'agent → aperçu en direct dans la conversation */}
        {messageArtifacts.map((artifact) => (
          <LiveAppPreviewButton key={`live-${artifact.id}`} artifact={artifact} />
        ))}
      </article>

      {/* GEN ADS — publicité d'annonceur sous chaque RÉPONSE résolue par
          l'IA (demande utilisateur) : emplacement compact « response_inline »,
          pool partagé + CIBLAGE CONTEXTUEL — l'annonce affichée présente une
          similitude sémantique avec la demande de l'utilisateur (question +
          réponse) ; sans annonce pertinente, RIEN ne s'affiche. */}
      {message.role === "assistant" && (
        <ResponseAdSlot slotKey={`msg:${message.id}`} context={adContext} />
      )}

      {/* Task 141 — ACTIONS RAPIDES sous chaque réponse : Copier (presse-
          papiers), Réutiliser (injecte le texte dans le composer pour le
          transformer), Régénérer (dernière réponse uniquement — renvoie le
          dernier message utilisateur). */}
      {message.role === "assistant" && message.generationStatus !== "failed" && (
        <div className="mr-auto mt-1 flex max-w-[92%] flex-wrap items-center gap-1 pl-0.5">
          <button
            type="button"
            onClick={() => void copyContent()}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--g3-border)] bg-transparent px-2 py-0.5 text-[10px] font-medium text-[var(--g3-muted)] transition hover:border-[var(--g3-border-strong)] hover:text-[var(--g3-text)]"
            aria-label="Copier la réponse"
            title="Copier la réponse dans le presse-papiers"
          >
            <span aria-hidden>{copied ? "✓" : "⧉"}</span> {copied ? "Copié" : "Copier"}
          </button>
          {onPrefill && (
            <button
              type="button"
              onClick={() => onPrefill(message.content)}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--g3-border)] bg-transparent px-2 py-0.5 text-[10px] font-medium text-[var(--g3-muted)] transition hover:border-[var(--g3-border-strong)] hover:text-[var(--g3-text)]"
              aria-label="Réutiliser cette réponse dans le composer"
              title="Injecter cette réponse dans le composer pour la transformer"
            >
              <span aria-hidden>↺</span> Réutiliser
            </button>
          )}
          {isLastResolvedAssistant && onRegenerate && !generating && (
            <button
              type="button"
              onClick={onRegenerate}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--g3-border)] bg-transparent px-2 py-0.5 text-[10px] font-medium text-[var(--g3-muted)] transition hover:border-[var(--g3-border-strong)] hover:text-[var(--g3-text)]"
              aria-label="Régénérer la réponse"
              title="Renvoyer le dernier message pour une nouvelle réponse"
            >
              <span aria-hidden>⟳</span> Régénérer
            </button>
          )}
        </div>
      )}

      {/* Task 141 — CHIPS DE SUIVI sous la DERNIÈRE réponse résolue : les
          suggestions générées avec la réponse deviennent des actions d'un
          clic — le texte est injecté dans le composer (l'utilisateur garde
          la main, la suggestion n'est jamais envoyée seule). */}
      {message.role === "assistant" && isLastResolvedAssistant && !generating && (message.suggestions ?? []).length > 0 && onPrefill && (
        <div className="mr-auto mt-1.5 flex max-w-[92%] flex-wrap items-center gap-1.5" aria-label="Suggestions de suivi">
          {(message.suggestions ?? []).map((suggestion) => (
            <button
              key={`${message.id}-sug-${suggestion}`}
              type="button"
              onClick={() => onPrefill(suggestion)}
              className="g3-chip text-[11px]"
              title="Insérer cette suggestion dans le composer"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      {message.role === "assistant" && (message.missingConnectors ?? []).length > 0 && (
        <ConnectorConnectCard toolkits={message.missingConnectors ?? []} />
      )}

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
  onPrefill,
  onRegenerate,
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
  // GEN ADS — CIBLAGE CONTEXTUEL : pour chaque réponse assistant, le contexte
  // publicitaire = la demande de l'utilisateur qui l'a déclenchée + un extrait
  // de la réponse elle-même. La publicité affichée doit présenter une
  // SIMILITUDE avec ce contexte (jamais un choix aléatoire).
  const adContextByMessageId = useMemo(() => {
    const contexts = new Map<string, string>();
    let lastUserQuery = "";
    for (const message of messages) {
      if (message.role === "user") {
        lastUserQuery = message.content;
      } else if (message.role === "assistant") {
        contexts.set(
          message.id,
          `${lastUserQuery} ${message.content.slice(0, 400)}`.trim().slice(0, 1200),
        );
      }
    }
    return contexts;
  }, [messages]);
  // AUDIO LIVRÉ DIRECTEMENT (Task 123) : association message ↔ artefacts audio
  // (tours vocaux SANS run, comme livrables d'étape d'un run) — le lecteur
  // intégré apparaît dès que l'artefact arrive (événement de flux ou
  // rechargement), sans rechargement de page.
  const audioByMessageId = useMemo(
    () => attachAudioArtifactsToMessages(messages, artifacts.filter((artifact) => artifact.type === "audio")),
    [messages, artifacts],
  );
  // Artefacts vidéo PERSISTÉS de la conversation (reprise après refresh :
  // la carte continue de suivre la production réelle et fait avancer la
  // file par sondage tant qu'elle est affichée).
  const persistedVideoArtifacts = useMemo(
    () => artifacts.filter((artifact) => artifact.type === "video" && artifact.videoProjectId),
    [artifacts],
  );
  // Task 141 — dernière réponse RÉSOLUE du fil (hors échec) : c'est sous
  // elle que vivent « Régénérer » et les chips de suivi. Les id « local-… »
  // (messages optimistes) ne comptent pas : seules les réponses persistées
  // portent des suggestions.
  const lastResolvedAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && !message.id.startsWith("local-") && message.generationStatus !== "failed") {
        return message.id;
      }
    }
    return null;
  }, [messages]);

  return (
    <div className="space-y-4">
      {messages.map((message) => {
        const run = message.runId ? runsById.get(message.runId) : undefined;
        const runApprovals = run ? approvalsByRunId.get(run.id) ?? EMPTY_APPROVALS : EMPTY_APPROVALS;
        const messageArtifacts = run ? artifactsByRunId.get(run.id) ?? EMPTY_ARTIFACTS : EMPTY_ARTIFACTS;
        // Union dédupliquée : audio lié au run + audio associé au message
        // (tour vocal direct) — la pastille générique les omet, le lecteur les rend.
        const rowAudio = audioByMessageId.get(message.id) ?? EMPTY_ARTIFACTS;
        const messageAudio = messageArtifacts.filter((artifact) => artifact.type === "audio");
        const audioArtifacts = messageAudio.length > 0
          ? [...messageAudio, ...rowAudio.filter((artifact) => !messageAudio.some((a) => a.id === artifact.id))]
          : rowAudio;

        return (
          <MessageRow
            key={message.id}
            message={message}
            run={run}
            runApprovals={runApprovals}
            messageArtifacts={messageArtifacts}
            audioArtifacts={audioArtifacts}
            generating={generating}
            onDecide={onDecide}
            onEditImage={onEditImage}
            onPrefill={onPrefill}
            onRegenerate={onRegenerate}
            isLastResolvedAssistant={message.id === lastResolvedAssistantId}
            adContext={adContextByMessageId.get(message.id)}
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
