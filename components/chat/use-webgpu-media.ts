"use client";

/**
 * HOOK MÉDIA WEBGPU — le GPU de l'utilisateur génère, gen3ia coordonne.
 *
 * Consomme les événements `webgpu_media` du flux de conversation :
 *  1. sonde WebGPU (honnête — refuse vite si absent) ;
 *  2. exécute le moteur local (image SD photoréalisme / voix Kokoro /
 *     vidéo keyframes+ffmpeg.wasm) avec progression affichée ;
 *  3. envoie le résultat à /api/media/webgpu-complete (persistance R2 +
 *     message + artefact dans la conversation) ;
 *  4. en cas d'échec quelconque → /api/media/webgpu-fallback : le serveur
 *     reprend le tour avec le moteur neuronal abstrait (jamais de faux
 *     succès, jamais de blocage).
 */

import { useCallback, useRef, useState } from "react";
import { détecterWebGpu } from "@/lib/neural/webgpu/detect";

export interface JobWebGpu {
  jobId: string;
  conversationId: string;
  kind: "image" | "voice" | "video";
  prompt: string;
  ratio?: string;
  durationSeconds?: number;
  engine: { repo: string; manifest: string };
}

export interface ProgressionWebGpu {
  jobId: string;
  étape: string;
  pourcent: number;
}

interface RéponseComplète {
  ok?: boolean;
  message?: { id: string; content: string; imageUrl?: string | null };
  artifact?: { id: string; url?: string; type?: string };
  error?: string;
}

/** Déclenche la lecture d'un blob audio (helper partagé voix). */
function jouerBlobAudio(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  void audio.play().catch(() => URL.revokeObjectURL(url));
}

export function useWebGpuMedia(options: {
  onMessage?: (message: NonNullable<RéponseComplète["message"]>, artifact?: RéponseComplète["artifact"]) => void;
  onProgress?: (p: ProgressionWebGpu) => void;
  onStatut?: (statut: string | null) => void;
  /** Lecture audio automatique pour la voix (mode chat vocal). */
  lectureAutomatique?: boolean;
}) {
  const { onMessage, onProgress, onStatut, lectureAutomatique } = options;
  const [capacité, setCapacité] = useState<{ disponible: boolean; raison?: string } | null>(null);
  const verrou = useRef<Set<string>>(new Set());

  const sonder = useCallback(async () => {
    const c = await détecterWebGpu();
    setCapacité({ disponible: c.disponible, raison: c.raison });
    return c;
  }, []);

  const repli = useCallback(
    async (job: JobWebGpu, raison: string) => {
      try {
        const r = await fetch("/api/media/webgpu-fallback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jobId: job.jobId,
            conversationId: job.conversationId,
            kind: job.kind,
            prompt: job.prompt,
            ratio: job.ratio,
            durationSeconds: job.durationSeconds,
            raison,
          }),
        });
        const data = (await r.json()) as RéponseComplète;
        if (data.message) onMessage?.(data.message, data.artifact);
        onStatut?.(null);
      } catch {
        onStatut?.("Repli serveur indisponible — réessayez.");
      }
    },
    [onMessage, onStatut],
  );

  const compléter = useCallback(
    async (job: JobWebGpu, blob: Blob, méta: Record<string, unknown>) => {
      const form = new FormData();
      form.set("jobId", job.jobId);
      form.set("conversationId", job.conversationId);
      form.set("kind", job.kind);
      form.set("prompt", job.prompt);
      if (job.ratio) form.set("ratio", job.ratio);
      form.set("meta", JSON.stringify(méta));
      const ext = blob.type === "video/mp4" ? "mp4" : blob.type === "audio/wav" ? "wav" : "png";
      form.set("file", blob, `gen3-webgpu-${job.jobId.slice(0, 8)}.${ext}`);
      const r = await fetch("/api/media/webgpu-complete", { method: "POST", body: form });
      const data = (await r.json()) as RéponseComplète;
      if (!r.ok || !data.message) throw new Error(data.error ?? "Persistance du média échouée");
      onMessage?.(data.message, data.artifact);
    },
    [onMessage],
  );

  /** Point d'entrée : traiter un événement webgpu_media du flux. */
  const traiter = useCallback(
    async (job: JobWebGpu) => {
      if (verrou.current.has(job.jobId)) return; // idempotence stricte
      verrou.current.add(job.jobId);
      onStatut?.("Vérification de votre GPU…");
      const cap = await sonder();
      setCapacité({ disponible: cap.disponible, raison: cap.raison });
      if (!cap.disponible) {
        await repli(job, cap.raison ?? "WebGPU indisponible");
        verrou.current.delete(job.jobId);
        return;
      }
      try {
        if (job.kind === "image") {
          const { générerImageWebGpu } = await import("@/lib/neural/webgpu/image-engine");
          const res = await générerImageWebGpu({
            prompt: job.prompt,
            ratio: job.ratio,
            onProgress: (i) => {
              onProgress?.({ jobId: job.jobId, étape: i.étape, pourcent: i.pourcent });
              onStatut?.(i.étape);
            },
          });
          await compléter(job, res.blob, {
            moteur: "sd-webgpu",
            adaptateur: res.adaptateur,
            pas: res.pas,
            seed: res.seed,
            largeur: res.largeur,
            hauteur: res.hauteur,
            duréeMs: res.duréeMs,
          });
        } else if (job.kind === "voice") {
          const { générerVoixHumaine } = await import("@/lib/neural/webgpu/voice-engine");
          const res = await générerVoixHumaine({
            texte: job.prompt,
            onProgress: (i) => {
              onProgress?.({ jobId: job.jobId, étape: i.étape, pourcent: i.pourcent });
              onStatut?.(i.étape);
            },
          });
          if (lectureAutomatique) jouerBlobAudio(res.blob);
          await compléter(job, res.blob, {
            moteur: res.moteur,
            voix: res.voix,
            duréeSecondes: res.duréeSecondes,
            duréeMs: res.duréeMs,
          });
        } else {
          const { générerVidéoWebGpu } = await import("@/lib/neural/webgpu/video-engine");
          const res = await générerVidéoWebGpu({
            prompt: job.prompt,
            ratio: job.ratio ?? "16:9",
            onProgress: (i) => {
              onProgress?.({ jobId: job.jobId, étape: i.étape, pourcent: i.pourcent });
              onStatut?.(i.étape);
            },
          });
          await compléter(job, res.blob, {
            moteur: res.moteur,
            nbKeyframes: res.nbKeyframes,
            duréeSecondes: res.duréeSecondes,
            duréeMs: res.duréeMs,
          });
        }
        onStatut?.(null);
      } catch (e) {
        await repli(job, e instanceof Error ? e.message : "Génération WebGPU échouée");
      } finally {
        verrou.current.delete(job.jobId);
      }
    },
    [compléter, lectureAutomatique, onProgress, onStatut, repli, sonder],
  );

  /** Lecture vocale HUMAINE d'un texte (mode chat voix — remplace speakFr). */
  const lireVoixHumaine = useCallback(async (texte: string): Promise<boolean> => {
    try {
      const { générerVoixHumaine } = await import("@/lib/neural/webgpu/voice-engine");
      const res = await générerVoixHumaine({ texte });
      jouerBlobAudio(res.blob);
      return true;
    } catch {
      return false; // l'appelant retombe sur Web Speech puis texte
    }
  }, []);

  return { traiter, sonder, capacité, lireVoixHumaine };
}
