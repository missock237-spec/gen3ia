"use client";

/**
 * HOOK MÉDIA WEBGPU — le GPU de l'utilisateur génère, gen3ia coordonne.
 *
 * V2 — ESSAIM : la requête photoréaliste/voix/vidéo est d'abord SOUMISE À
 * L'IA CENTRALE (/api/essaim/job) qui la décompose et distribue les parts
 * aux 5 meilleurs GPU du maillage (l'appareil local participe via l'agent
 * gen3). L'IA centrale associe les signaux, persiste l'œuvre et livre le
 * message + artefact — le hook les affiche. Repli HONNÊTE en cascade :
 *  essaim indisponible → génération LOCALE (votre GPU seul) → repli serveur
 *  (moteur neuronal abstrait). Jamais de faux succès, jamais de blocage.
 */

import { useCallback, useRef, useState } from "react";
import { détecterWebGpu } from "@/lib/neural/webgpu/detect";
import {
  soumettreJobEssaim,
  sonderJobEssaim,
} from "@/lib/essaim-media/agent-client";

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

  /** Suit un job d'essaim : sondage régulier, progression réelle par parts,
   *  livraison finale. Retourne false si l'essaim a échoué/écoule le temps
   *  (l'appelant bascule alors en génération locale). */
  const suivreEssaim = useCallback(
    async (job: JobWebGpu, jobId: string): Promise<boolean> => {
      const début = Date.now();
      const DURÉE_MAX = 8 * 60_000;
      while (Date.now() - début < DURÉE_MAX) {
        await new Promise((r) => setTimeout(r, 2_500));
        const s = await sonderJobEssaim(jobId);
        if (!s.ok) continue; // sonde ratée (réseau) : on persiste
        if (s.état === "termine" && s.livraison) {
          onMessage?.(
            s.livraison.message as unknown as NonNullable<RéponseComplète["message"]>,
            s.livraison.artifact as unknown as RéponseComplète["artifact"],
          );
          onProgress?.({ jobId: job.jobId, étape: "Œuvre d'essaim livrée.", pourcent: 100 });
          onStatut?.(null);
          return true;
        }
        if (s.état === "echoue") {
          onStatut?.(`Essaim gen3 : ${s.erreur ?? "échec de fusion"}`);
          return false;
        }
        const détail = `Essaim gen3 — ${s.terminés ?? 0}/${s.fragments ?? "?"} part(s) calculée(s)${(s.relances ?? 0) > 0 ? ` · ${s.relances} relance(s)` : ""}`;
        onProgress?.({ jobId: job.jobId, étape: détail, pourcent: Math.max(3, s.pourcent ?? 0) });
        onStatut?.(`${détail}…`);
      }
      return false; // délai épuisé : la voie locale prend la main
    },
    [onMessage, onProgress, onStatut],
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
        // 1. ESSAIM GEN3 : décomposition + distribution aux 5 meilleurs GPU.
        onStatut?.("L'IA centrale répartit votre requête dans l'essaim gen3…");
        const soumission = await soumettreJobEssaim({
          jobId: job.jobId,
          conversationId: job.conversationId,
          kind: job.kind,
          prompt: job.prompt,
          ratio: job.ratio,
          durationSeconds: job.durationSeconds,
        });
        if (soumission.ok && soumission.jobId) {
          const livré = await suivreEssaim(job, soumission.jobId);
          if (livré) {
            verrou.current.delete(job.jobId);
            return;
          }
          // Essaim échoué (fusion, plafond…) : le GPU LOCAL prend le relais.
          onStatut?.("Essaim indisponible — votre GPU prend le relais…");
        }
        // 2. GÉNÉRATION LOCALE (voie autonome, qualité haute).
        if (job.kind === "image") {
          const { générerImageWebGpu } = await import("@/lib/neural/webgpu/image-engine");
          const res = await générerImageWebGpu({
            prompt: job.prompt,
            ratio: job.ratio,
            qualité: "haute",
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
            segmenter: true,
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
    [compléter, lectureAutomatique, onProgress, onStatut, repli, sonder, suivreEssaim],
  );

  /** Lecture vocale HUMAINE d'un texte (mode chat voix — remplace speakFr). */
  const lireVoixHumaine = useCallback(async (texte: string): Promise<boolean> => {
    try {
      const { générerVoixHumaine } = await import("@/lib/neural/webgpu/voice-engine");
      const res = await générerVoixHumaine({ texte, segmenter: true });
      jouerBlobAudio(res.blob);
      return true;
    } catch {
      return false; // l'appelant retombe sur Web Speech puis texte
    }
  }, []);

  return { traiter, sonder, capacité, lireVoixHumaine };
}
