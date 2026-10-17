"use client";

/**
 * Étape 1 — Module de capture d'écran (ScreenCapturer).
 *
 * Déclenche le partage d'écran natif via navigator.mediaDevices.getDisplayMedia,
 * extrait une frame toutes les FRAME_INTERVAL_MS (2 s, intervalle configurable)
 * dans un canvas, la réduit (≤ 1280 px de large) et l'encode en JPEG base64
 * optimisé (qualité 0.55 — payload réduit pour la latence temps réel).
 *
 * États gérés proprement : idle → requesting → active ⇄ paused → idle,
 * erreurs de permission (NotAllowedError) et fin de partage côté utilisateur
 * (track "ended"). Les frames sont ignorées quand l'onglet est masqué
 * (économie de débit — l'utilisateur regarde ailleurs).
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type CaptureStatus = "idle" | "unsupported" | "requesting" | "active" | "paused" | "error";

export interface ScreenCapturerController {
  status: CaptureStatus;
  error: string | null;
  previewUrl: string | null;
  frameCount: number;
  start: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

/** Intervalle d'extraction des frames (spécification : 1,5 à 2 s). */
export const FRAME_INTERVAL_MS = 2_000;
/** Largeur maximale d'encodage (au-delà : réduction — payload maîtrisé). */
const MAX_CAPTURE_WIDTH = 1280;
/** Qualité JPEG (0,55 : bon compromis lisibilité UI / taille base64). */
const JPEG_QUALITY = 0.55;

interface ScreenCapturerOptions {
  onFrame: (jpegBase64: string, width: number, height: number) => void;
}

export function useScreenCapturer({ onFrame }: ScreenCapturerOptions): ScreenCapturerController {
  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [frameCount, setFrameCount] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
      setStatus("unsupported");
      return;
    }
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    videoRef.current = video;
    canvasRef.current = document.createElement("canvas");
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      videoRef.current?.pause();
      if (videoRef.current) videoRef.current.srcObject = null;
      videoRef.current = null;
      canvasRef.current = null;
    };
  }, []);

  const captureOnce = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.videoWidth === 0 || document.hidden) return;
    const scale = Math.min(1, MAX_CAPTURE_WIDTH / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    setPreviewUrl(dataUrl);
    setFrameCount((count) => count + 1);
    onFrameRef.current(base64, canvas.width, canvas.height);
  }, []);

  const stopInterval = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const stopInternal = useCallback(() => {
    stopInterval();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    videoRef.current?.pause();
    if (videoRef.current) videoRef.current.srcObject = null;
  }, [stopInterval]);

  const start = useCallback(async () => {
    if (status === "requesting" || status === "active") return;
    setStatus("requesting");
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("Capture non initialisée.");
      video.srcObject = stream;
      await video.play();
      // Fin du partage déclenchée par l'utilisateur (bouton navigateur).
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        stopInternal();
        setStatus("idle");
      });
      setStatus("active");
      stopInterval();
      intervalRef.current = setInterval(captureOnce, FRAME_INTERVAL_MS);
      captureOnce();
    } catch (cause) {
      stopInternal();
      if (cause instanceof DOMException && cause.name === "NotAllowedError") {
        setStatus("idle");
        setError(null); // annulation volontaire du sélecteur : pas une erreur
        return;
      }
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Partage d'écran refusé.");
    }
  }, [captureOnce, status, stopInternal, stopInterval]);

  const pause = useCallback(() => {
    if (status !== "active") return;
    stopInterval();
    setStatus("paused");
  }, [status, stopInterval]);

  const resume = useCallback(() => {
    if (status !== "paused") return;
    stopInterval();
    intervalRef.current = setInterval(captureOnce, FRAME_INTERVAL_MS);
    setStatus("active");
  }, [captureOnce, status, stopInterval]);

  const stop = useCallback(() => {
    stopInternal();
    setStatus("idle");
    setPreviewUrl(null);
  }, [stopInternal]);

  return { status, error, previewUrl, frameCount, start, pause, resume, stop };
}
