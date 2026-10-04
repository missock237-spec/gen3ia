"use client";

import { useEffect, useRef, useState } from "react";

import { MediaProgressFrame, formatElapsed } from "@/components/media/media-progress-frame";
import type { MediaProgressStatus } from "@/components/media/media-progress-logic";

/**
 * CARTE DE PRODUCTION VIDÉO (temps réel) — suit la file autopilotée
 * `videoProductionJobs` via GET /api/video/projects/[id]/production :
 * progression RÉELLE serveur (stages plan→script→assets→voice→render,
 * pourcentage pondéré), chrono réel, et lecteur <video> du rendu final
 * (URL signée R2) dès que le job de rendu est terminé.
 *
 * La route de statut est AUSSI le moteur de continuation par sondage :
 * chaque interrogation fait avancer le job d'un tick borné quand QStash
 * n'est pas disponible — garder cette carte ouverte fait avancer la
 * production, sans jamais la doubler (claim transactionnel côté serveur).
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
  queueMode?: "qstash" | "poll";
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

export function VideoProductionCard({ videoProjectId, title, tone = "dark" }: { videoProjectId: string; title?: string; tone?: "dark" | "light" }) {
  const [status, setStatus] = useState<ProductionStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const startedRef = useRef<number>(Date.now());

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    const resolvePlayback = async (renderJobId: string) => {
      try {
        const response = await fetch(`/api/video/projects/${videoProjectId}/render`, { signal: controller.signal });
        if (!response.ok) return;
        const data = (await response.json()) as { jobs?: Array<{ id: string; status: string; output?: { playbackUrl?: string } }> };
        const job = data.jobs?.find((candidate) => candidate.id === renderJobId) ?? data.jobs?.find((candidate) => candidate.status === "completed");
        const url = job?.output?.playbackUrl;
        if (url && !cancelled) setPlaybackUrl(url);
      } catch {
        /* sondage suivant */
      }
    };

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
          setStatus(null);
          return;
        }
        startedRef.current = data.createdAt ? Date.parse(data.createdAt) || startedRef.current : startedRef.current;
        setStatus(data);
        if (data.status === "completed" && data.renderJobId && !playbackUrl) {
          void resolvePlayback(data.renderJobId);
        }
      } catch {
        /* réseau instable : le prochain tick réessaie */
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoProjectId]);

  const active = status && status.status !== "completed" && status.status !== "failed" && status.status !== "cancelled";
  const percent = status ? Math.max(0, Math.min(100, status.progress <= 1 ? status.progress * 100 : status.progress)) : null;

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
          detail={title ? `« ${title} » · suivi toutes les 5 s` : "Suivi en temps réel (5 s)"}
          error={status.error ?? undefined}
          tone={tone}
          startedAt={startedRef.current}
        />
      )}
      {status?.status === "completed" && (
        <p className="text-[11px] text-[var(--g3-muted)]">
          Vidéo terminée en {formatElapsed(status.createdAt ? Math.max(0, Date.now() - Date.parse(status.createdAt)) : 0)} — lecteur ci-dessous, projet complet dans l&apos;atelier vidéo.
        </p>
      )}
      {playbackUrl && (
        <video controls src={playbackUrl} className="w-full rounded-xl border border-[var(--g3-border)]" preload="metadata" />
      )}
      {active && <span className="sr-only">Production vidéo en cours : {STAGE_LABELS[status.stage] ?? status.stage}</span>}
    </div>
  );
}
