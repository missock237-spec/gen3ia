"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { authFetch } from "@/lib/firebase/auth-client";
import type { LiveAction } from "@/lib/live/types";

/**
 * AGENT LIVE — EXÉCUTEUR NAVIGATEUR UNIQUE (it.53 : « un seul exécuteur,
 * deux surfaces »).
 *
 * Avant it.53, la boucle de capture (armement, getDisplayMedia /
 * getUserMedia, envoi des frames, journal, HITL, arrêt) existait EN DEUX
 * COPIES divergentes : le panneau du chat (components/live/
 * live-interne-panel) et le dashboard /live (app/live/live-dashboard) —
 * la copie du dashboard avait déjà dérivé (pas de caméra, pas de carte
 * d'approbation inline, statuts incohérents). Ce composant est désor-
 * mais l'UNIQUE exécuteur navigateur du pipeline interne gen3 :
 *  - POST /api/live/sessions/[id]/start — armement (deviceId) ;
 *  - POST /api/live/sessions/[id]/frames — images capturées (écran PC
 *    via getDisplayMedia, caméra mobile via getUserMedia — 3 s, JPEG
 *    ≤1280 px), décisions rendues par le moteur de vision INTERNE
 *    (lib/live/vision-decider) : observation, objectif atteint, action,
 *    approbation HITL, pause, dédup d'écran inchangé ;
 *  - PUT /api/live/sessions/[id]/frames — résultat d'action (ok / échec
 *    honnête, le moteur adapte ses décisions suivantes) ;
 *  - POST /api/live/sessions/[id]/actions/[actionId]/approve —
 *    approbation HITL (carte inline) ;
 *  - POST /api/live/sessions/[id] { action: "stop" } — arrêt réel.
 *
 * Les DEUX surfaces consomment ce même composant :
 *  - le chat IA (live-interne-panel : carte d'activation → exécuteur) ;
 *  - l'espace /live (live-dashboard : « Tester dans ce navigateur » →
 *    exécuteur — qui gagne la caméra mobile et la carte HITL inline).
 *
 * Honnêteté : en navigateur, l'agent OBSERVE et DÉCRIT — les actions
 * souris/clavier/fichiers sont notifiées à la porte comme non
 * exécutables ; aucune voix n'est annoncée (guidage textuel dans le
 * journal) ; 401/403/429 → message de la porte, codes terminaux
 * (LIVE_STOPPED / LIVE_EXPIRED / LIVE_FAILED / LIVE_DEVICE_MISMATCH)
 * → boucle arrêtée proprement (plus AUCUNE boucle qui réessaie en
 * boucle sur une session morte) ; échecs réseau consécutifs signalés.
 * Robustesse : jeton de génération anti-course (reactStrictMode double
 * le montage — la génération périmée n'attache ni flux ni boucle).
 *
 * Aucune clé API, aucun service tiers : tout le traitement passe par
 * les portes maison (authFetch same-origin, cookie gen3ia_session).
 */

export type SourceCapture = "screen" | "camera";
export type CameraFacing = "environment" | "user";

interface FrameResponse {
  decision: { done: boolean; message: string } | null;
  action?: { actionId: string; action: LiveAction };
  pendingApproval?: { actionId: string; action: LiveAction };
  pendingAction?: { actionId: string; approvedAt?: number | null } | null;
  paused?: boolean;
  pauseReason?: string;
  error?: string;
  code?: string;
  /** Écran inchangé : le serveur a répondu sans nouvelle analyse (dédup). */
  unchanged?: boolean;
  /** Perception réellement disponible : guidage structurel ou dégradé. */
  perception?: "structural-guided" | "structural-degraded";
}

type ObservationKind = "observation" | "action" | "result" | "pause" | "info" | "error";

interface ObservationEntry {
  id: number;
  at: number;
  kind: ObservationKind;
  text: string;
}

const KIND_STYLES: Record<ObservationKind, string> = {
  observation: "text-[var(--g3-text-secondary)]",
  action: "text-[var(--g3-info)] font-medium",
  result: "text-[var(--g3-muted)]",
  pause: "text-[var(--g3-warning-strong)]",
  info: "text-[var(--g3-success-strong)]",
  error: "text-[var(--g3-danger-strong)]",
};

const KIND_ICONS: Record<ObservationKind, string> = {
  observation: "◦",
  action: "→",
  result: "·",
  pause: "⏸",
  info: "✓",
  error: "×",
};

const FRAME_INTERVAL_MS = 3_000;
const MAX_CAPTURE_WIDTH = 1280;
const BROWSER_UNSUPPORTED_ERROR =
  "Action réservée à un client PC : en mode navigateur, l'agent observe et décrit, mais ne peut pas agir sur l'ordinateur.";

/** Codes de la porte frames qui signifient « la session n'acceptera plus
 *  d'images » : la boucle s'arrête au lieu de réessayer indéfiniment. */
const CODES_TERMINAUX = new Set(["LIVE_STOPPED", "LIVE_EXPIRED", "LIVE_FAILED", "LIVE_DEVICE_MISMATCH"]);

function describeAction(action: LiveAction): string {
  switch (action.type) {
    case "mouse.move":
      return `Déplacer la souris vers (${Math.round(action.x)}, ${Math.round(action.y)})`;
    case "mouse.click":
      return `Clic ${action.button === "left" ? "gauche" : action.button === "right" ? "droit" : "milieu"}`;
    case "keyboard.type":
      return `Saisir du texte (${action.text.length} caractères)`;
    case "keyboard.key":
      return `Appuyer sur la touche « ${action.key} »`;
    case "wait":
      return `Observer pendant ${action.ms >= 1000 ? `${Math.round(action.ms / 1000)} s` : `${action.ms} ms`}`;
    case "file.read":
      return `Lire le fichier ${action.path}`;
    case "file.write":
      return `Écrire le fichier ${action.path}`;
    default:
      return "Action inconnue";
  }
}

function makeDeviceId(): string {
  const raw = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `web-${raw.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 16)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString("fr-FR", { timeStyle: "medium" });
}

export interface LiveExecuteurProps {
  /** Session LIVE existante (créée par la carte du chat ou le dashboard). */
  sessionId: string;
  /** Source de capture initiale (écran PC par défaut, caméra mobile). */
  sourceInitiale?: SourceCapture;
  /** Caméra initiale (arrière par défaut — l'environnement de l'utilisateur). */
  cameraFacingInitiale?: CameraFacing;
  /** Fermeture (retour à la carte d'activation du chat / désélection du dashboard). */
  onFermer?: () => void;
}

export function LiveExecuteur({ sessionId, sourceInitiale = "screen", cameraFacingInitiale = "environment", onFermer }: LiveExecuteurProps) {
  const [statut, setStatut] = useState<"demarrage" | "actif" | "arrete">("demarrage");
  const [sourceActuelle, setSourceActuelle] = useState<SourceCapture>(sourceInitiale);
  const [cameraFacing, setCameraFacing] = useState<CameraFacing>(cameraFacingInitiale);
  const [observations, setObservations] = useState<ObservationEntry[]>([]);
  const [pendingApproval, setPendingApproval] = useState<{ actionId: string; action: LiveAction } | null>(null);
  const [approbBusy, setApprobBusy] = useState(false);
  const [erreurExecution, setErreurExecution] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sendingRef = useRef(false);
  /** Compteur d'échecs réseau consécutifs — visibles dans le journal. */
  const frameFailuresRef = useRef(0);
  const deviceIdRef = useRef<string | null>(null);
  const loggedPauseRef = useRef<string | null>(null);
  const observationIdRef = useRef(0);
  /** Jeton de génération : toute réponse (start, frames) dont la génération
   *  est périmée est ignorée — protège le double-montage StrictMode et le
   *  changement de session. */
  const generationRef = useRef(0);
  /** Source/caméra lus PAR RÉFÉRENCE pour garder `demarrer` stable
   *  (l'effet de montage ne doit jamais repartir à cause d'un picker). */
  const sourceRef = useRef<SourceCapture>(sourceInitiale);
  const facingRef = useRef<CameraFacing>(cameraFacingInitiale);

  const log = useCallback((kind: ObservationKind, text: string) => {
    observationIdRef.current += 1;
    const entry: ObservationEntry = { id: observationIdRef.current, at: Date.now(), kind, text };
    setObservations((current) => [...current.slice(-120), entry]);
  }, []);

  const stopCaptureLoop = useCallback(() => {
    if (loopRef.current) {
      clearInterval(loopRef.current);
      loopRef.current = null;
    }
  }, []);

  const teardownStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const sendActionResult = useCallback(async (actionId: string, ok: boolean, errorMessage?: string) => {
    const deviceId = deviceIdRef.current;
    if (!deviceId) return;
    try {
      await authFetch(`/api/live/sessions/${sessionId}/frames`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId, actionId, ok, ...(errorMessage ? { error: errorMessage } : {}) }),
      });
    } catch {
      // Le résultat sera considéré perdu côté serveur (reprise explicite).
    }
  }, [sessionId]);

  const executeBrowserAction = useCallback(
    async (action: { actionId: string; action: LiveAction }) => {
      log("action", `Action de l'agent : ${describeAction(action.action)}`);
      if (action.action.type === "wait") {
        await sleep(action.action.ms);
        await sendActionResult(action.actionId, true);
        log("result", "Attente terminée — l'agent poursuit son observation.");
        return;
      }
      // Le navigateur ne contrôle ni la souris, ni le clavier, ni les
      // fichiers : le résultat honnête est un échec explicite, que le
      // moteur de vision interne intègre pour adapter ses décisions.
      await sendActionResult(action.actionId, false, BROWSER_UNSUPPORTED_ERROR);
      log("result", `Non exécutable dans le navigateur : ${describeAction(action.action)}.`);
    },
    [log, sendActionResult],
  );

  const captureAndSendFrame = useCallback(async () => {
    if (sendingRef.current) return;
    const deviceId = deviceIdRef.current;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!deviceId || !video || !stream || stream.getVideoTracks().every((track) => track.readyState !== "live")) return;
    if (document.visibilityState !== "visible") return;
    sendingRef.current = true;
    try {
      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;
      if (!sourceWidth || !sourceHeight) return;
      const scale = Math.min(1, MAX_CAPTURE_WIDTH / sourceWidth);
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(video, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
      const jpegBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      if (jpegBase64.length < 64) return;

      const response = await authFetch(`/api/live/sessions/${sessionId}/frames`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId,
          timestamp: Date.now(),
          width,
          height,
          jpegBase64,
        }),
      });

      if (response.status === 409) {
        const data = (await response.json().catch(() => ({}))) as FrameResponse;
        if (data.code === "LIVE_PAUSED") {
          const key = data.pendingAction?.actionId ?? "paused";
          if (loggedPauseRef.current !== key) {
            loggedPauseRef.current = key;
            log("pause", data.pendingAction ? "Action sensible en attente de votre validation ci-contre." : data.error || "Session en pause.");
          }
          return;
        }
        if (data.code && CODES_TERMINAUX.has(data.code)) {
          // Session arrêtée / expirée / reprise par un autre client :
          // la boucle s'arrête au lieu de réessayer indéfiniment.
          stopCaptureLoop();
          teardownStream();
          deviceIdRef.current = null;
          setStatut("arrete");
          setPendingApproval(null);
          log("error", data.error || "La session n'accepte plus d'images — capture arrêtée.");
          return;
        }
        return;
      }
      if (response.status === 410) {
        stopCaptureLoop();
        teardownStream();
        deviceIdRef.current = null;
        setStatut("arrete");
        setPendingApproval(null);
        log("error", "Session Live expirée — capture arrêtée.");
        return;
      }
      if (response.status === 429 || response.status === 403 || response.status === 401) {
        const data = (await response.json().catch(() => ({}))) as FrameResponse;
        if (loggedPauseRef.current !== `http-${response.status}`) {
          loggedPauseRef.current = `http-${response.status}`;
          log("error", data.error || "Envoi d'image refusé par le serveur.");
        }
        return;
      }
      if (!response.ok) return;

      const data = (await response.json()) as FrameResponse;
      frameFailuresRef.current = 0;
      // Écran inchangé (dédup serveur) : rien de nouveau à journaliser.
      if (data.unchanged) return;
      setPendingApproval(data.pendingApproval ?? null);
      if (data.decision?.message) {
        log(data.decision.done ? "info" : "observation", data.decision.message);
      }
      if (data.decision?.done) {
        stopCaptureLoop();
        setStatut("arrete");
        log("info", "Objectif atteint — la capture est arrêtée. La session reste consultable ci-dessous.");
        return;
      }
      if (data.pendingApproval) {
        log("pause", `Action sensible à approuver : ${describeAction(data.pendingApproval.action)}`);
        return;
      }
      if (data.action) {
        await executeBrowserAction(data.action);
      }
    } catch {
      // Frame perdue (réseau, onglet) : la boucle suivante réessaie — mais
      // l'utilisateur est informé dès 2 échecs consécutifs (plus aucun
      // échec silencieux).
      frameFailuresRef.current += 1;
      if (frameFailuresRef.current === 2) {
        log("error", "Connexion instable : plusieurs images n'ont pas pu être envoyées. La session continue de réessayer.");
      }
    } finally {
      sendingRef.current = false;
    }
  }, [executeBrowserAction, log, sessionId, stopCaptureLoop, teardownStream]);

  const arreter = useCallback(
    async (stopSession: boolean) => {
      generationRef.current += 1;
      stopCaptureLoop();
      teardownStream();
      deviceIdRef.current = null;
      setPendingApproval(null);
      setStatut("arrete");
      if (stopSession) {
        try {
          await authFetch(`/api/live/sessions/${sessionId}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "stop" }),
          });
        } catch {}
        log("info", "Session Live arrêtée.");
      }
    },
    [log, sessionId, stopCaptureLoop, teardownStream],
  );

  const demarrer = useCallback(async () => {
    const generation = ++generationRef.current;
    setStatut("demarrage");
    setErreurExecution(null);
    loggedPauseRef.current = null;
    try {
      const deviceId = makeDeviceId();

      // it.54 (demande propriétaire : « un seul bouton, le système
      // détecte l'appareil ») : la source est DÉTECTÉE PAR LE SYSTÈME
      // AVANT l'armement — la vérité est la capacité réelle du
      // navigateur (le partage d'écran n'existe pas sur les navigateurs
      // mobiles, la caméra existe partout) : si l'écran est demandé mais
      // indisponible, la bascule vers la caméra est automatique et
      // annoncée. La source est déclarée à la porte /start (la garde
      // « PC only » ne concerne que l'écran).
      let sourceEffective = sourceRef.current;
      if (sourceEffective === "screen" && !navigator.mediaDevices?.getDisplayMedia) {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Ni partage d'écran ni caméra disponibles dans ce navigateur.");
        }
        sourceEffective = "camera";
        sourceRef.current = "camera";
        setSourceActuelle("camera");
        log("info", "Détection automatique : partage d'écran indisponible ici (téléphone) — bascule sur la caméra.");
      }
      if (sourceEffective === "camera" && !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Caméra indisponible dans ce navigateur.");
      }

      const startResponse = await authFetch(`/api/live/sessions/${sessionId}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId, source: sourceEffective }),
      });
      if (!startResponse.ok) {
        const data = (await startResponse.json().catch(() => ({}))) as FrameResponse;
        throw new Error(data.error || "Démarrage impossible");
      }
      if (generation !== generationRef.current) return;

      let stream: MediaStream;
      if (sourceEffective === "screen") {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false });
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facingRef.current, width: { ideal: 1280 } },
          audio: false,
        });
      }
      if (generation !== generationRef.current) {
        // Génération périmée (double-montage StrictMode, session changée) :
        // le flux capturé est rendu immédiatement, sans attachement.
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      deviceIdRef.current = deviceId;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      const generationDuPiste = generation;
      stream.getVideoTracks().forEach((track) =>
        track.addEventListener("ended", () => {
          if (generationDuPiste !== generationRef.current) return;
          log("info", sourceRef.current === "screen" ? "Partage d'écran interrompu depuis le navigateur." : "Caméra interrompue depuis le navigateur.");
          void arreter(false);
        }),
      );

      setStatut("actif");
      log("info", sourceRef.current === "screen"
        ? "Source détectée : écran (ordinateur) — le moteur interne gen3 observe et vous guide."
        : "Source détectée : caméra (téléphone) — le moteur interne gen3 observe et vous guide.");

      stopCaptureLoop();
      loopRef.current = setInterval(() => {
        void captureAndSendFrame();
      }, FRAME_INTERVAL_MS);
    } catch (error) {
      if (generation !== generationRef.current) return;
      teardownStream();
      deviceIdRef.current = null;
      setStatut("arrete");
      const message = error instanceof Error ? error.message : "Démarrage impossible";
      setErreurExecution(
        /permission|denied|dismissed/i.test(message)
          ? "Capture refusée : sélectionnez l'écran (ou autorisez la caméra) pour démarrer l'agent."
          : message,
      );
    }
  }, [arreter, captureAndSendFrame, log, sessionId, stopCaptureLoop, teardownStream]);

  // Démarrage au montage — une seule fois par session (le jeton de
  // génération neutralise le double-montage StrictMode : la génération
  // périmée n'attache ni flux ni boucle, la seconde génération pilote).
  useEffect(() => {
    void demarrer();
    return () => {
      generationRef.current += 1;
      stopCaptureLoop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [demarrer, stopCaptureLoop]);

  const approuverAction = useCallback(async () => {
    const deviceId = deviceIdRef.current;
    if (!deviceId || !pendingApproval || approbBusy) return;
    setApprobBusy(true);
    try {
      const response = await authFetch(`/api/live/sessions/${sessionId}/actions/${pendingApproval.actionId}/approve`, { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        log("error", data.error ?? "Approbation impossible.");
      } else {
        log("info", "Action sensible approuvée — l'agent reprend dès la prochaine image.");
        setPendingApproval(null);
        loggedPauseRef.current = null;
      }
    } catch {
      log("error", "Approbation impossible (réseau).");
    } finally {
      setApprobBusy(false);
    }
  }, [approbBusy, log, pendingApproval, sessionId]);

  const choisirSource = (next: SourceCapture) => {
    setSourceActuelle(next);
    sourceRef.current = next;
  };
  const basculerCamera = () => {
    const next = cameraFacing === "environment" ? "user" : "environment";
    setCameraFacing(next);
    facingRef.current = next;
  };

  return (
    <div className="space-y-3">
      <section className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            Agent live — <span className={statut === "actif" ? "text-[var(--g3-success-strong)]" : "text-[var(--g3-muted)]"}>
              {statut === "actif" ? "observation en cours" : statut === "demarrage" ? "démarrage…" : "capture arrêtée"}
            </span>
          </h3>
          {statut === "actif" ? (
            <button
              type="button"
              onClick={() => void arreter(true)}
              className="rounded-full border border-[var(--g3-border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--g3-muted)] hover:bg-[var(--g3-elevated)]"
            >
              Arrêter
            </button>
          ) : (
            <button
              type="button"
              onClick={onFermer}
              className="rounded-full border border-[var(--g3-border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--g3-muted)] hover:bg-[var(--g3-elevated)]"
            >
              Terminer
            </button>
          )}
        </div>
        <div className="mt-2 overflow-hidden rounded-xl border border-[var(--g3-border)] bg-black/90" aria-busy={statut === "demarrage"}>
          <video ref={videoRef} autoPlay muted playsInline className="max-h-56 w-full object-contain" />
          {statut !== "actif" && statut !== "demarrage" ? (
            <p className="px-3 py-2 text-xs text-[var(--g3-faint)]">Aucune capture active — relancez ci-dessous si la session l&apos;accepte encore.</p>
          ) : null}
        </div>
        {erreurExecution ? (
          <p role="alert" className="mt-2 rounded-lg bg-[var(--g3-danger-soft)] px-3 py-2 text-xs text-[var(--g3-danger-strong)]">{erreurExecution}</p>
        ) : null}
        {pendingApproval ? (
          <div role="status" className="mt-2 rounded-xl border border-[var(--g3-warning-soft)] bg-[var(--g3-warning-soft)] p-3">
            <p className="text-xs font-semibold text-[var(--g3-warning-strong)]">Action sensible en attente de votre validation : {describeAction(pendingApproval.action)}</p>
            <button
              type="button"
              onClick={() => void approuverAction()}
              disabled={approbBusy}
              className="g3-btn g3-btn-primary mt-2 text-xs disabled:opacity-50"
            >
              {approbBusy ? "Approbation…" : "Approuver cette action"}
            </button>
          </div>
        ) : null}
        {statut === "arrete" ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-pressed={sourceActuelle === "screen"}
              onClick={() => choisirSource("screen")}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${sourceActuelle === "screen" ? "bg-[var(--g3-deep)] text-white" : "border border-[var(--g3-border-strong)] text-[var(--g3-muted)]"}`}
            >
              Écran (PC)
            </button>
            <button
              type="button"
              aria-pressed={sourceActuelle === "camera"}
              onClick={() => choisirSource("camera")}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${sourceActuelle === "camera" ? "bg-[var(--g3-deep)] text-white" : "border border-[var(--g3-border-strong)] text-[var(--g3-muted)]"}`}
            >
              Caméra (mobile)
            </button>
            {sourceActuelle === "camera" ? (
              <button
                type="button"
                onClick={basculerCamera}
                className="rounded-full border border-[var(--g3-border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--g3-muted)]"
              >
                Caméra {cameraFacing === "environment" ? "arrière" : "avant"} ⇄
              </button>
            ) : null}
            <button type="button" onClick={() => void demarrer()} className="g3-btn g3-btn-primary px-3 py-1.5 text-xs">
              Relancer la capture
            </button>
          </div>
        ) : null}
        <ul className="mt-2 max-h-44 space-y-1 overflow-y-auto text-xs" aria-label="Journal de l'agent live">
          {observations.map((entry) => (
            <li key={entry.id} className={`flex gap-1.5 leading-5 ${KIND_STYLES[entry.kind]}`}>
              <span aria-hidden="true">{KIND_ICONS[entry.kind]}</span>
              <span className="shrink-0 text-[var(--g3-faint)]">{formatTime(entry.at)}</span>
              <span>{entry.text}</span>
            </li>
          ))}
          {observations.length === 0 ? (
            <li className="text-[var(--g3-faint)]">Le journal affichera ici chaque observation et décision du moteur interne.</li>
          ) : null}
        </ul>
        <p className="mt-1.5 text-[11px] leading-4 text-[var(--g3-faint)]">
          Moteur de vision INTERNE gen3 (aucun service externe) · perception structurelle (l&apos;écran est mesuré,
          jamais interprété) · suivi HITL complet sur{" "}
          <Link href="/live" className="underline">l&apos;espace Live</Link>.
        </p>
      </section>
    </div>
  );
}
