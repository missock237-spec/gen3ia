"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { MediaProgressFrame, formatElapsed } from "@/components/media/media-progress-frame";
import type { MediaProgressStatus } from "@/components/media/media-progress-logic";

/**
 * CARTE DE PRODUCTION VIDÉO (temps réel) — Task 106-d.
 *
 * CANAL PRIMAIRE : flux SSE GET /api/video/projects/[id]/production/stream
 * (Task 106-c) — progression poussée toutes les ~2,5 s, sans polling, et
 * la boucle serveur fait avancer la production en mode sondage (moteur de
 * continuation préservé).
 *
 * REPLI : sondage GET /api/video/projects/[id]/production (5 s visibles,
 * 10 s en arrière-plan en mode poll) si l'EventSource échoue ou se termine
 * sans statut terminal (borne 280 s du flux) — le comportement historique
 * est conservé à l'identique en repli.
 *
 * LIVRAISON ENRICHIE : dès que le rendu est terminé, le lecteur <video>
 * (URL signée R2) s'affiche AVEC les formats dérivés (TikTok/Shorts/Reels…)
 * et leurs liens de téléchargement, ainsi que les avertissements de scènes
 * (tolérance par scène Task 106-c).
 */

interface ProductionStatus {
  jobId: string;
  projectId: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  stage: string;
  progress: number;
  error: string | null;
  renderJobId: string | null;
  title?: string;
  createdAt?: string;
  queueMode?: "queue" | "poll";
  warnings?: string[];
}

interface RenderExport {
  target: string;
  status: string;
  playbackUrl?: string | null;
}

const STAGE_LABELS: Record<string, string> = {
  project: "Création du projet vidéo",
  plan: "Plan du réalisateur",
  script: "Écriture du scénario",
  assets: "Génération des visuels de scènes",
  voice: "Narration vocale",
  render: "Rendu final (montage, audio, sous-titres)",
  done: "Production terminée",
};

const EXPORT_LABELS: Record<string, string> = {
  master_16_9: "Master 16:9",
  youtube_16_9: "YouTube 16:9",
  shorts_9_16: "Shorts 9:16",
  tiktok_9_16: "TikTok 9:16",
  reels_9_16: "Reels 9:16",
  square_1_1: "Carré 1:1",
  facebook_16_9: "Facebook 16:9",
};

function statusToProgress(status: ProductionStatus["status"]): MediaProgressStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "processing":
      return "running";
    case "completed":
      return "complete";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function VideoProductionCard({ videoProjectId, title, tone = "dark" }: { videoProjectId: string; title?: string; tone?: "dark" | "light" }) {
  const [status, setStatus] = useState<ProductionStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [exports, setExports] = useState<RenderExport[]>([]);
  const startedRef = useRef<number>(Date.now());
  // Miroir du statut pour les callbacks EventSource (pas de closure périmée).
  const statusRef = useRef<ProductionStatus | null>(null);
  const applyStatus = useCallback((next: ProductionStatus | null) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  /** Livraison : lecteur + formats dérivés du dernier rendu terminé. */
  const resolveDelivery = useCallback(
    async (signal: AbortSignal) => {
      try {
        const response = await fetch(`/api/video/projects/${videoProjectId}/render`, { signal });
        if (!response.ok) return;
        const data = (await response.json()) as {
          jobs?: Array<{ status: string; output?: { playbackUrl?: string | null }; exports?: RenderExport[] }>;
        };
        const job = data.jobs?.find((candidate) => candidate.status === "completed");
        if (!job) return;
        if (job.output?.playbackUrl) setPlaybackUrl(job.output.playbackUrl);
        const done = (job.exports ?? []).filter((e) => e.status === "done" && e.playbackUrl);
        if (done.length > 0) setExports(done);
      } catch {
        /* livraison retentée au prochain statut */
      }
    },
    [videoProjectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let finished = false;
    let source: EventSource | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;

    const isTerminal = (candidate: ProductionStatus["status"]) => TERMINAL_STATUSES.has(candidate);

    const stopAll = () => {
      if (source !== null) {
        source.close();
        source = null;
      }
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };

    const onTerminal = (data: ProductionStatus) => {
      finished = true;
      stopAll();
      if (data.status === "completed") void resolveDelivery(controller.signal);
    };

    // ── Canal primaire : SSE (progression poussée + moteur de continuation) ──
    const openStream = () => {
      if (typeof window === "undefined" || typeof EventSource === "undefined") return false;
      try {
        source = new EventSource(`/api/video/projects/${videoProjectId}/production/stream`);
        source.onmessage = (event) => {
          if (cancelled) return;
          try {
            const payload = JSON.parse(event.data) as {
              type: string;
              error?: string;
              jobId?: string;
              stage?: string;
              status?: ProductionStatus["status"];
              progress?: number;
              sceneCursor?: number;
              warnings?: string[];
              renderJobId?: string;
              createdAt?: string;
            };
            if (payload.type === "progress") {
              setLoadError("");
              const previous = statusRef.current;
              applyStatus({
                ...(previous ?? ({} as ProductionStatus)),
                jobId: payload.jobId ?? previous?.jobId ?? "",
                projectId: videoProjectId,
                status: payload.status ?? previous?.status ?? "processing",
                stage: payload.stage ?? previous?.stage ?? "project",
                progress: payload.progress ?? previous?.progress ?? 0,
                error: previous?.error ?? null,
                renderJobId: payload.renderJobId ?? previous?.renderJobId ?? null,
                warnings: payload.warnings ?? previous?.warnings,
                createdAt: previous?.createdAt,
              });
              if (payload.createdAt) startedRef.current = Date.parse(payload.createdAt) || startedRef.current;
            } else if (payload.type === "done" || payload.type === "failed") {
              const terminal: ProductionStatus = {
                ...(statusRef.current ?? ({} as ProductionStatus)),
                jobId: payload.jobId ?? statusRef.current?.jobId ?? "",
                projectId: videoProjectId,
                status: payload.type === "done" ? "completed" : "failed",
                stage: payload.type === "done" ? "done" : statusRef.current?.stage ?? "render",
                progress: payload.type === "done" ? 1 : statusRef.current?.progress ?? 0,
                error: payload.type === "failed" ? payload.error ?? "Production échouée." : statusRef.current?.error ?? null,
                renderJobId: payload.renderJobId ?? statusRef.current?.renderJobId ?? null,
                createdAt: statusRef.current?.createdAt,
                queueMode: statusRef.current?.queueMode,
              };
              applyStatus(terminal);
              onTerminal(terminal);
            } else if (payload.type === "timeout" || payload.type === "error") {
              // Borne du flux (280 s) ou incident : repli sondage historique.
              if (source !== null) {
                source.close();
                source = null;
              }
              startPolling();
            }
          } catch {
            /* événement illisible : le suivant corrigera */
          }
        };
        source.onerror = () => {
          // Connexion perdue/refusée : repli sondage (comportement historique).
          if (source !== null) {
            source.close();
            source = null;
          }
          if (!cancelled && !finished) startPolling();
        };
        return true;
      } catch {
        return false;
      }
    };

    // ── Repli : sondage GET (moteur de continuation en mode poll) ──
    const poll = async () => {
      try {
        const response = await fetch(`/api/video/projects/${videoProjectId}/production`, { signal: controller.signal });
        if (!response.ok) {
          if (!cancelled) setLoadError("Suivi de production indisponible pour le moment.");
          return;
        }
        const data = (await response.json()) as ProductionStatus | { job: null };
        if (cancelled) return;
        setLoadError("");
        if ("job" in data) {
          applyStatus(null);
          return;
        }
        startedRef.current = data.createdAt ? Date.parse(data.createdAt) || startedRef.current : startedRef.current;
        applyStatus(data);
        if (isTerminal(data.status)) onTerminal(data);
      } catch {
        /* réseau instable : le prochain tick réessaie */
      }
    };

    const startPolling = () => {
      if (cancelled || finished || interval !== null) return;
      interval = setInterval(() => void poll(), 5_000);
      void poll();
    };

    void openStream();
    // Sécurité : si aucun flux n'a pu être ouvert (SSR/vieux navigateurs),
    // le sondage historique prend le relais immédiatement.
    if (source === null) startPolling();

    // Filet : si après 90 s le statut est toujours inconnu (flux muet),
    // basculer sur le sondage (couvre les proxys qui tamponnent le SSE).
    const watchdog = setTimeout(() => {
      if (!cancelled && !finished && statusRef.current === null && source !== null) {
        if (source !== null) {
          source.close();
          source = null;
        }
        startPolling();
      }
    }, 90_000);

    return () => {
      cancelled = true;
      finished = true;
      clearTimeout(watchdog);
      stopAll();
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoProjectId, resolveDelivery]);

  const active = status && !TERMINAL_STATUSES.has(status.status);
  const percent = status ? Math.max(0, Math.min(100, status.progress <= 1 ? status.progress * 100 : status.progress)) : null;
  const visibleWarnings = status?.warnings?.slice(-2) ?? [];

  if (!status && !loadError) {
    return (
      <MediaProgressFrame
        status="queued"
        stageLabel="Lancement de la production vidéo"
        tone={tone}
        compact
        startedAt={startedRef.current}
      />
    );
  }

  return (
    <div className="space-y-2" data-video-production={videoProjectId}>
      {loadError && <p className="text-[11px] text-[var(--g3-muted)]">{loadError}</p>}
      {status && (
        <MediaProgressFrame
          status={statusToProgress(status.status)}
          stageLabel={STAGE_LABELS[status.stage] ?? "Production vidéo"}
          percent={status.status === "completed" ? 100 : percent}
          detail={title ? `« ${title} » · progression en temps réel` : "Progression en temps réel"}
          error={status.error ?? undefined}
          tone={tone}
          startedAt={startedRef.current}
        />
      )}
      {active && visibleWarnings.length > 0 && (
        <ul className="space-y-1" aria-label="Avertissements de production">
          {visibleWarnings.map((warning, index) => (
            <li key={index} className="text-[11px] text-[var(--g3-muted)]">
              ⚠ {warning}
            </li>
          ))}
        </ul>
      )}
      {status?.status === "completed" && (
        <p className="text-[11px] text-[var(--g3-muted)]">
          Vidéo terminée en {formatElapsed(status.createdAt ? Math.max(0, Date.now() - Date.parse(status.createdAt)) : 0)} — lecteur ci-dessous, projet complet dans l&apos;atelier vidéo.
        </p>
      )}
      {playbackUrl && (
        <>
          <video controls src={playbackUrl} className="w-full rounded-xl border border-[var(--g3-border)]" preload="metadata" />
          <a
            href={playbackUrl}
            download
            className="inline-block text-[11px] underline decoration-dotted text-[var(--g3-muted)] hover:text-[var(--g3-fg)]"
          >
            Télécharger la vidéo (master)
          </a>
        </>
      )}
      {exports.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Formats dérivés">
          {exports.map((item) => (
            <a
              key={item.target}
              href={item.playbackUrl ?? "#"}
              download
              className="rounded-full border border-[var(--g3-border)] px-2 py-0.5 text-[11px] text-[var(--g3-muted)] hover:text-[var(--g3-fg)]"
            >
              {EXPORT_LABELS[item.target] ?? item.target} ↓
            </a>
          ))}
        </div>
      )}
      {active && status && <span className="sr-only">Production vidéo en cours : {STAGE_LABELS[status.stage] ?? status.stage}</span>}
    </div>
  );
}
