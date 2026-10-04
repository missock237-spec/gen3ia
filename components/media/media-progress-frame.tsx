"use client";

/**
 * CADRE DE PROGRESSION MÉDIA — Task 1-c (Mission utilisateur 2) :
 * « à chaque génération d'image ou de vidéo, un cadre qui montre la
 * progression RÉELLE en temps réel ».
 *
 * Primitif partagé purement présentationnel :
 * - barre déterminée 0..100 (h-1.5, transitions Tailwind) OU indéterminée
 *   (réutilise l'animation `.g3-progress` de globals.css) ;
 * - pastille de statut en français (En file / En cours / En pause / Terminé /
 *   Échec / Annulé) + point pulsant pendant l'exécution ;
 * - chronomètre réel auto-tiqué chaque seconde quand `startedAt` est fourni ;
 * - actions fantômes « Annuler » / « Réessayer » ;
 * - deux thèmes : dark (atelier par défaut) et light (palette crème de la
 *   section 14 « CHAT AGENT IA — THÈME CRÈME » de globals.css / .g3-agent-light).
 * Le mouvement respecte prefers-reduced-motion (section 15 de globals.css).
 */

import { useEffect, useState } from "react";
import {
  clampPercent,
  formatElapsed,
  MEDIA_PROGRESS_STATUS_LABELS,
  type MediaProgressStatus,
  type MediaProgressTone,
} from "./media-progress-logic";

/** Ré-exports publics pour les surfaces consommatrices (Phase 2). */
export { clampPercent, formatElapsed, MEDIA_PROGRESS_STATUS_LABELS } from "./media-progress-logic";
export type { MediaProgressStatus, MediaProgressTone } from "./media-progress-logic";

export interface MediaProgressFrameProps {
  /** État d'exécution de la génération. */
  status: MediaProgressStatus;
  /** Étape courante, ex. « Génération de l'image », « Segment 3/12 », « Assemblage audio ». */
  stageLabel?: string;
  /** Progression déterminée 0..100 ; null/undefined → mode indéterminé. */
  percent?: number | null;
  /** Ligne secondaire, ex. « 4 images de scènes générées ». */
  detail?: string;
  /** Message d'erreur affiché quand status = "failed". */
  error?: string;
  /** « dark » = atelier par défaut ; « light » = thème crème .g3-agent-light. */
  tone?: MediaProgressTone;
  /** Variante dense (listes, intégrations inline). */
  compact?: boolean;
  /** Action d'annulation — bouton fantôme « Annuler » (états actifs uniquement). */
  onCancel?: () => void;
  /** Action de reprise — bouton fantôme « Réessayer » (statut failed uniquement). */
  onRetry?: () => void;
  /** Instant de départ (epoch ms) : active le chronomètre réel (tick 1 s). */
  startedAt?: number;
}

/* Thème dark = atelier par défaut ; light = palette hex crème (globals.css §14). */
const TONE_CARD: Record<MediaProgressTone, string> = {
  dark: "border-neutral-200 bg-white",
  light: "border-[#E5E1D5] bg-[#FAF9F5]",
};
const TONE_STAGE: Record<MediaProgressTone, string> = {
  dark: "text-neutral-900",
  light: "text-[#1F1E1A]",
};
const TONE_DETAIL: Record<MediaProgressTone, string> = {
  dark: "text-neutral-500",
  light: "text-[#83817A]",
};
const TONE_ELAPSED: Record<MediaProgressTone, string> = {
  dark: "text-neutral-400",
  light: "text-[#A9A79E]",
};
const TONE_TRACK: Record<MediaProgressTone, string> = {
  dark: "bg-neutral-100",
  light: "bg-[#EAE5D9]",
};
const TONE_FILL: Record<MediaProgressTone, string> = {
  dark: "bg-blue-500",
  light: "bg-[#D97757]",
};
const TONE_DOT: Record<MediaProgressTone, string> = {
  dark: "bg-blue-500",
  light: "bg-[#D97757]",
};
const TONE_ERROR: Record<MediaProgressTone, string> = {
  dark: "text-rose-600",
  light: "text-[#9F2F2F]",
};
const TONE_CANCEL: Record<MediaProgressTone, string> = {
  dark: "border-neutral-200 text-neutral-600 hover:bg-neutral-50",
  light: "border-[#D3CDBB] text-[#3D3B34] hover:bg-[#EAE5D9]",
};
const TONE_RETRY: Record<MediaProgressTone, string> = {
  dark: "border-blue-200 text-blue-700 hover:bg-blue-50",
  light: "border-[#D97757] text-[#C05B3D] hover:bg-[rgba(217,119,87,0.12)]",
};
const STATUS_PILL: Record<MediaProgressStatus, Record<MediaProgressTone, string>> = {
  queued: {
    dark: "bg-neutral-100 text-neutral-600",
    light: "bg-[#EAE5D9] text-[#3D3B34]",
  },
  running: {
    dark: "bg-blue-100 text-blue-700",
    light: "bg-[rgba(217,119,87,0.12)] text-[#C05B3D]",
  },
  paused: {
    dark: "bg-amber-100 text-amber-700",
    light: "bg-[rgba(180,128,31,0.12)] text-[#8A6117]",
  },
  complete: {
    dark: "bg-emerald-100 text-emerald-700",
    light: "bg-[rgba(63,125,68,0.12)] text-[#2F5F33]",
  },
  failed: {
    dark: "bg-rose-100 text-rose-700",
    light: "bg-[rgba(194,65,65,0.10)] text-[#9F2F2F]",
  },
  cancelled: {
    dark: "bg-neutral-100 text-neutral-500",
    light: "bg-[#EAE5D9] text-[#83817A]",
  },
};

export function MediaProgressFrame({
  status,
  stageLabel,
  percent,
  detail,
  error,
  tone = "dark",
  compact = false,
  onCancel,
  onRetry,
  startedAt,
}: MediaProgressFrameProps) {
  // Chronomètre réel : tick 1 s tant que le cadre est monté (nettoyage strict).
  // `now` démarre à null pour éviter tout écart d'hydratation SSR/client.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const bounded = clampPercent(percent);
  // Échec/annulation : pas de barre (le message d'erreur remplace la progression).
  const showBar = status !== "failed" && status !== "cancelled";
  const elapsed = startedAt !== undefined && now !== null ? formatElapsed(now - startedAt) : null;
  const progressLabel = stageLabel ?? MEDIA_PROGRESS_STATUS_LABELS[status];

  return (
    <div
      className={`g3-mpf rounded-xl border ${TONE_CARD[tone]} ${compact ? "p-3" : "p-4"}`}
      role="status"
      aria-live="polite"
      data-status={status}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_PILL[status][tone]}`}>
            {MEDIA_PROGRESS_STATUS_LABELS[status]}
          </span>
          {stageLabel ? (
            <span className={`truncate text-sm font-medium ${TONE_STAGE[tone]}`}>
              {status === "running" ? (
                <span
                  aria-hidden
                  className={`g3-mpf-pulse mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full ${TONE_DOT[tone]}`}
                />
              ) : null}
              {stageLabel}
            </span>
          ) : null}
        </div>
        <div className={`flex shrink-0 items-center gap-2 text-xs ${TONE_ELAPSED[tone]}`}>
          {bounded !== null ? <span className="font-semibold tabular-nums">{bounded} %</span> : null}
          {elapsed ? (
            <span aria-hidden className="font-mono tabular-nums">
              {elapsed}
            </span>
          ) : null}
        </div>
      </div>

      {showBar ? (
        bounded !== null ? (
          <div
            className={`h-1.5 overflow-hidden rounded ${TONE_TRACK[tone]}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={bounded}
            aria-label={progressLabel}
          >
            <div
              className={`h-1.5 rounded ${TONE_FILL[tone]} transition-all duration-500 ease-out`}
              style={{ width: `${bounded}%` }}
            />
          </div>
        ) : (
          <div className="g3-progress" role="progressbar" aria-label={progressLabel} />
        )
      ) : null}

      {status === "failed" && error ? <p className={`text-xs ${TONE_ERROR[tone]}`}>{error}</p> : null}
      {detail ? <p className={`${compact ? "text-[11px]" : "text-xs"} ${TONE_DETAIL[tone]}`}>{detail}</p> : null}

      {onCancel || onRetry ? (
        <div className="flex gap-2">
          {onCancel && (status === "queued" || status === "running" || status === "paused") ? (
            <button type="button" onClick={onCancel} className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${TONE_CANCEL[tone]}`}>
              Annuler
            </button>
          ) : null}
          {onRetry && status === "failed" ? (
            <button type="button" onClick={onRetry} className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${TONE_RETRY[tone]}`}>
              Réessayer
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
