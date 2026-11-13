"use client";

/**
 * CARRÉ DE PROGRESSION MÉDIA — suivi de génération vidéo en temps réel.
 * Exigence produit : PLUS de barre de progression — UN CARRÉ (bloc carré)
 * affichant EN GRAND LE POURCENTAGE de la création, mis à jour en direct :
 *
 * - div carrée (aspect-ratio 1/1, 128 px) dont le fond SE REMPLIT DE BAS EN
 *   HAUT avec la couleur accent du thème, pourcentage centré au-dessus
 *   (« 47 % », font-bold tabular-nums) ;
 * - POURCENTAGE MONOTONE : le maximum déjà affiché vit dans une ref — jamais
 *   de régression même si le serveur renvoie un statut incohérent ;
 * - état indéterminé (aucun pourcentage reçu) : le carré pulse et le libellé
 *   d'étape s'affiche dessous ;
 * - statut français sous le carré (En file / En cours / Terminé / Échec /
 *   Annulé) + libellé d'étape + chronomètre réel (tick 1 s si `startedAt`) ;
 * - deux thèmes identiques au MediaProgressFrame : dark (atelier par défaut)
 *   et light (palette crème .g3-agent-light du chat) ;
 * - AUCUNE BARRE : le composant ne rend jamais d'élément de barre — le carré
 *   expose lui-même sa valeur (rôle meter : aria-valuenow / valuemin / max).
 *
 * Le mouvement respecte prefers-reduced-motion (variantes motion-reduce
 * Tailwind — le composant reste autonome, sans dépendance globals.css).
 */

import { useEffect, useRef, useState } from "react";

import {
  clampPercent,
  formatElapsed,
  maxPercentMonotone,
  MEDIA_PROGRESS_STATUS_LABELS,
  type MediaProgressStatus,
  type MediaProgressTone,
} from "./media-progress-logic";

export interface MediaProgressSquareProps {
  /** État d'exécution de la génération. */
  status: MediaProgressStatus;
  /** Étape courante, ex. « Rendu final (montage, audio, sous-titres) ». */
  stageLabel?: string;
  /** Progression déterminée 0..100 ; null/undefined → mode indéterminé. */
  percent?: number | null;
  /** Ligne secondaire, ex. « « Titre » · progression en temps réel ». */
  detail?: string;
  /** Message d'erreur affiché quand status = "failed". */
  error?: string;
  /** « dark » = atelier par défaut ; « light » = thème crème .g3-agent-light. */
  tone?: MediaProgressTone;
  /** Instant de départ (epoch ms) : active le chronomètre réel (tick 1 s). */
  startedAt?: number;
}

/* Thèmes — mêmes tokens que le cadre de progression (dark = atelier par
   défaut ; light = crème neutre §14 de globals.css, accents 2 couleurs). */
const TONE_CARTE: Record<MediaProgressTone, string> = {
  dark: "border-neutral-200 bg-white",
  light: "border-[var(--g3-border)] bg-[var(--g3-bg)]",
};
const TONE_POURCENTAGE: Record<MediaProgressTone, string> = {
  dark: "text-neutral-900",
  light: "text-[var(--g3-text)]",
};
const TONE_ETAPE: Record<MediaProgressTone, string> = {
  dark: "text-neutral-900",
  light: "text-[var(--g3-text)]",
};
const TONE_DETAIL: Record<MediaProgressTone, string> = {
  dark: "text-neutral-500",
  light: "text-[var(--g3-muted)]",
};
const TONE_CHRONO: Record<MediaProgressTone, string> = {
  dark: "text-neutral-400",
  light: "text-[var(--g3-faint)]",
};
const TONE_POINT: Record<MediaProgressTone, string> = {
  dark: "bg-[var(--g3-secondary)]",
  light: "bg-[var(--g3-primary)]",
};
const TONE_ERREUR: Record<MediaProgressTone, string> = {
  dark: "text-[var(--g3-danger-strong)]",
  light: "text-[var(--g3-danger-strong)]",
};
/* Remplissage vertical interne : fond doux + liseré accent en surface du
   « liquide » montant. Échec/annulation : même géométrie en rouge danger. */
const TONE_REMPLISSAGE: Record<MediaProgressTone, string> = {
  dark: "bg-[var(--g3-secondary-soft)]",
  light: "bg-[var(--g3-primary-soft)]",
};
const TONE_REMPLISSAGE_KO: Record<MediaProgressTone, string> = {
  dark: "bg-[var(--g3-danger-soft)]",
  light: "bg-[var(--g3-danger-soft)]",
};
const TONE_LISERE: Record<MediaProgressTone, string> = {
  dark: "bg-[var(--g3-secondary)]",
  light: "bg-[var(--g3-primary)]",
};
const TONE_LISERE_KO: Record<MediaProgressTone, string> = {
  dark: "bg-[var(--g3-danger-strong)]",
  light: "bg-[var(--g3-danger-strong)]",
};
const STATUS_PASTILLE: Record<MediaProgressStatus, Record<MediaProgressTone, string>> = {
  queued: {
    dark: "bg-neutral-100 text-neutral-600",
    light: "bg-[var(--g3-elevated)] text-[var(--g3-text-secondary)]",
  },
  running: {
    dark: "bg-[var(--g3-secondary-soft)] text-[var(--g3-info)]",
    light: "bg-[var(--g3-primary-soft)] text-[var(--g3-primary-strong)]",
  },
  paused: {
    dark: "bg-[var(--g3-warning-soft)] text-[var(--g3-warning-strong)]",
    light: "bg-[var(--g3-warning-soft)] text-[var(--g3-warning-strong)]",
  },
  complete: {
    dark: "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]",
    light: "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]",
  },
  failed: {
    dark: "bg-[var(--g3-danger-soft)] text-[var(--g3-danger-strong)]",
    light: "bg-[var(--g3-danger-soft)] text-[var(--g3-danger-strong)]",
  },
  cancelled: {
    dark: "bg-neutral-100 text-neutral-500",
    light: "bg-[var(--g3-elevated)] text-[var(--g3-muted)]",
  },
};

export function MediaProgressSquare({
  status,
  stageLabel,
  percent,
  detail,
  error,
  tone = "dark",
  startedAt,
}: MediaProgressSquareProps) {
  // Chronomètre réel : tick 1 s tant que le carré est monté (nettoyage strict).
  // `now` démarre à null pour éviter tout écart d'hydratation SSR/client.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  // POURCENTAGE MONOTONE : le max déjà affiché traverse les rendus ET les
  // trous (percent null entre deux événements SSE) via la ref interne.
  const monotoneRef = useRef<number | null>(null);
  const borne = clampPercent(percent);
  if (borne !== null) {
    monotoneRef.current = maxPercentMonotone(monotoneRef.current, borne);
  }
  // Complétion : le carré affiche toujours 100 % (défense en profondeur —
  // le serveur peut terminer sans dernier événement de progression).
  const affiche = status === "complete" ? Math.max(monotoneRef.current ?? 0, 100) : monotoneRef.current;
  const enEchec = status === "failed" || status === "cancelled";
  const indetermine = affiche === null;
  // Pulse UNIQUEMENT en indéterminé actif : un carré qui progresse vit par
  // son remplissage, pas par une animation globale.
  const pulse = indetermine && (status === "queued" || status === "running" || status === "paused");
  const elapsed = startedAt !== undefined && now !== null ? formatElapsed(now - startedAt) : null;

  const libelleAria = [
    MEDIA_PROGRESS_STATUS_LABELS[status],
    affiche !== null ? `${affiche} %` : null,
    stageLabel ?? null,
  ]
    .filter(Boolean)
    .join(" — ");

  return (
    <div
      className="g3-mps flex flex-col items-center gap-2.5 text-center"
      role="status"
      aria-live="polite"
      aria-label={libelleAria}
      data-status={status}
    >
      {/* LE CARRÉ — fond qui se remplit de bas en haut, pourcentage en grand.
          Il expose LUI-MÊME sa valeur (rôle meter, jamais de barre). */}
      <div
        role="meter"
        aria-label={libelleAria}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={affiche ?? undefined}
        aria-valuetext={affiche !== null ? `${affiche} %` : undefined}
        className={`relative aspect-square h-32 w-32 shrink-0 overflow-hidden rounded-2xl border ${TONE_CARTE[tone]} ${
          pulse ? "animate-pulse motion-reduce:animate-none" : ""
        }`}
      >
        {affiche !== null ? (
          <div
            aria-hidden
            className={`absolute inset-x-0 bottom-0 ${
              enEchec ? TONE_REMPLISSAGE_KO[tone] : TONE_REMPLISSAGE[tone]
            } transition-[height] duration-500 ease-out motion-reduce:transition-none`}
            style={{ height: `${affiche}%` }}
          >
            <span aria-hidden className={`absolute inset-x-0 top-0 h-[2px] ${enEchec ? TONE_LISERE_KO[tone] : TONE_LISERE[tone]}`} />
          </div>
        ) : null}
        <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center p-2">
          <span className={`text-3xl font-bold tabular-nums leading-none ${TONE_POURCENTAGE[tone]}`}>
            {affiche !== null ? `${affiche} %` : enEchec ? "—" : ""}
          </span>
        </div>
      </div>

      {/* Statut FR + étape + chronomètre, SOUS le carré. */}
      <div className="flex flex-col items-center gap-1">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_PASTILLE[status][tone]}`}>
          {MEDIA_PROGRESS_STATUS_LABELS[status]}
        </span>
        {stageLabel ? (
          <span className={`max-w-48 text-xs font-medium leading-snug ${TONE_ETAPE[tone]}`}>
            {status === "running" ? (
              <span
                aria-hidden
                className={`mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full motion-reduce:animate-none ${TONE_POINT[tone]}`}
              />
            ) : null}
            {stageLabel}
          </span>
        ) : null}
        {elapsed ? (
          <span aria-hidden className={`font-mono text-[11px] tabular-nums ${TONE_CHRONO[tone]}`}>
            {elapsed}
          </span>
        ) : null}
        {detail ? <span className={`text-[11px] ${TONE_DETAIL[tone]}`}>{detail}</span> : null}
        {status === "failed" && error ? <span className={`text-[11px] ${TONE_ERREUR[tone]}`}>{error}</span> : null}
      </div>
    </div>
  );
}
