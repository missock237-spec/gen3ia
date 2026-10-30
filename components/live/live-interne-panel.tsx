"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";
import type { LiveAction } from "@/lib/live/types";

/**
 * AGENT LIVE — MOTEUR INTERNE GEN3 (it.52, demande propriétaire : « le
 * live doit être activé depuis le Chat IA et fonctionner en interne »).
 *
 * Ce panneau remplace l'ancien canal externe « Gemini Live » (clé
 * opérateur + WebSocket vers un service tiers) dans le chat ET s'appuie
 * UNIQUEMENT sur le pipeline interne gen3, le même que l'espace /live :
 *  - POST /api/live/sessions — création RÉELLE de la session (mode
 *    navigateur, permissions, audit serveur, rate-limit 20/5 min) ;
 *  - POST /api/live/sessions/[id]/start — armement (deviceId, pairing) ;
 *  - POST /api/live/sessions/[id]/frames — images capturées (écran PC
 *    via getDisplayMedia, caméra mobile via getUserMedia — 3 s, JPEG
 *    ≤1280 px), décisions rendues par le moteur de vision INTERNE
 *    (lib/live/vision-decider) : observation, objectif atteint, action,
 *    approbation HITL, pause, dédup d'écran inchangé ;
 *  - POST /api/live/sessions/[id]/actions/[actionId]/approve —
 *    approbation HITL depuis le chat (action sensible en attente) ;
 *  - POST /api/live/sessions/[id] { action: "stop" } — arrêt réel.
 *
 * Honnêteté : en navigateur, l'agent OBSERVE et DÉCRIT — les actions
 * souris/clavier/fichiers sont notifiées à la porte comme non
 * exécutables (le moteur adapte ses décisions suivantes) ; aucune voix
 * n'est annoncée (le guidage est textuel, dans le journal du panneau) ;
 * 401 → connexion, 429/403 → message de la porte, échec réseau →
 * journal (échecs consécutifs signalés, jamais silencieux).
 *
 * Aucune clé API, aucun service tiers : tout le traitement passe par
 * les portes maison (authFetch same-origin, cookie gen3ia_session).
 */

type Permission =
  | "screen.read"
  | "input.mouse"
  | "input.keyboard"
  | "files.read"
  | "files.write"
  | "browser.control";

const PERMISSION_LABELS: Record<Permission, string> = {
  "screen.read": "Observer l'écran",
  "input.mouse": "Contrôler la souris",
  "input.keyboard": "Contrôler le clavier",
  "files.read": "Lire les fichiers",
  "files.write": "Écrire des fichiers",
  "browser.control": "Contrôler le navigateur",
};

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

type SourceCapture = "screen" | "camera";
type CameraFacing = "environment" | "user";

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

export function LiveInternePanel() {
  const sessionDisponible = useSessionAvailable();

  // Formulaire d'activation (carte « Activer »).
  const [nom, setNom] = useState("Live — chat IA");
  const [objectif, setObjectif] = useState("");
  const [permissions, setPermissions] = useState<Permission[]>(["screen.read"]);
  const [consentement, setConsentement] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);

  // Runtime de la session live (boucle interne gen3).
  const [liveStatus, setLiveStatus] = useState<"idle" | "starting" | "running" | "stopped">("idle");
  const [source, setSource] = useState<SourceCapture>("screen");
  const [cameraFacing, setCameraFacing] = useState<CameraFacing>("environment");
  const [observations, setObservations] = useState<ObservationEntry[]>([]);
  const [pendingApproval, setPendingApproval] = useState<{ actionId: string; action: LiveAction } | null>(null);
  const [approbBusy, setApprobBusy] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sendingRef = useRef(false);
  const frameFailuresRef = useRef(0);
  const runtimeRef = useRef<{ sessionId: string; deviceId: string } | null>(null);
  const loggedPauseRef = useRef<string | null>(null);
  const observationIdRef = useRef(0);

  const log = useCallback((kind: ObservationKind, text: string) => {
    observationIdRef.current += 1;
    const entry: ObservationEntry = { id: observationIdRef.current, at: Date.now(), kind, text };
    setObservations((current) => [...current.slice(-120), entry]);
  }, []);

  const togglePermission = (permission: Permission) => {
    setPermissions((current) =>
      current.includes(permission)
        ? current.filter((item) => item !== permission)
        : [...current, permission],
    );
  };

  const sendActionResult = useCallback(async (actionId: string, ok: boolean, errorMessage?: string) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    try {
      await authFetch(`/api/live/sessions/${runtime.sessionId}/frames`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: runtime.deviceId, actionId, ok, ...(errorMessage ? { error: errorMessage } : {}) }),
      });
    } catch {
      // Le résultat sera considéré perdu côté serveur (reprise explicite).
    }
  }, []);

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

  const captureAndSendFrame = useCallback(async () => {
    if (sendingRef.current) return;
    const runtime = runtimeRef.current;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!runtime || !video || !stream || stream.getVideoTracks().every((track) => track.readyState !== "live")) return;
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

      const response = await authFetch(`/api/live/sessions/${runtime.sessionId}/frames`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: runtime.deviceId,
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
        }
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
        setLiveStatus("stopped");
        log("info", "Objectif atteint — l'agent se met en pause. La capture est arrêtée.");
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
  }, [executeBrowserAction, log, stopCaptureLoop]);

  const stopLive = useCallback(
    async (stopSession: boolean) => {
      stopCaptureLoop();
      teardownStream();
      const runtime = runtimeRef.current;
      runtimeRef.current = null;
      setPendingApproval(null);
      setLiveStatus("stopped");
      if (runtime && stopSession) {
        try {
          await authFetch(`/api/live/sessions/${runtime.sessionId}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "stop" }),
          });
        } catch {}
        log("info", "Session Live arrêtée.");
      }
    },
    [log, stopCaptureLoop, teardownStream],
  );

  const demarrerCapture = useCallback(
    async (sessionId: string) => {
      const deviceId = makeDeviceId();
      const startResponse = await authFetch(`/api/live/sessions/${sessionId}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId }),
      });
      if (!startResponse.ok) {
        const data = (await startResponse.json().catch(() => ({}))) as FrameResponse;
        throw new Error(data.error || "Démarrage impossible");
      }

      // Source de capture : écran natif sur PC (getDisplayMedia), caméra
      // sur mobile ou à la demande (getUserMedia) — le partage d'écran
      // n'existe pas sur les navigateurs mobiles, la caméra est la source
      // visuelle honnête équivalente.
      let stream: MediaStream;
      if (source === "screen") {
        if (!navigator.mediaDevices?.getDisplayMedia) {
          throw new Error("Partage d'écran indisponible dans ce navigateur : basculez sur la caméra (mobile) ou utilisez Chrome/Edge/Firefox sur ordinateur.");
        }
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false });
      } else {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Caméra indisponible dans ce navigateur.");
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: cameraFacing, width: { ideal: 1280 } },
          audio: false,
        });
      }

      streamRef.current = stream;
      runtimeRef.current = { sessionId, deviceId };
      loggedPauseRef.current = null;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      stream.getVideoTracks().forEach((track) =>
        track.addEventListener("ended", () => {
          log("info", source === "screen" ? "Partage d'écran interrompu depuis le navigateur." : "Caméra interrompue depuis le navigateur.");
          void stopLive(false);
        }),
      );

      setLiveStatus("running");
      log("info", source === "screen"
        ? "Écran partagé — le moteur interne gen3 observe et vous guide."
        : "Caméra active — le moteur interne gen3 observe et vous guide.");

      stopCaptureLoop();
      loopRef.current = setInterval(() => {
        void captureAndSendFrame();
      }, FRAME_INTERVAL_MS);
    },
    [cameraFacing, captureAndSendFrame, log, source, stopCaptureLoop, stopLive],
  );

  const activerLive = useCallback(async () => {
    if (sessionDisponible === false) {
      setActivationError("Session expirée. Reconnectez-vous.");
      return;
    }
    if (!nom.trim() || objectif.trim().length < 10 || permissions.length === 0 || !consentement || busy) return;
    setBusy(true);
    setActivationError(null);
    try {
      const response = await authFetch("/api/live/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: nom.trim(), objective: objectif.trim(), permissions, mode: "browser" }),
      });
      const data = (await response.json().catch(() => ({}))) as { session?: { id: string }; error?: string };
      if (response.status === 401) {
        throw new Error("Connectez-vous pour activer l'agent live.");
      }
      if (response.status === 429) {
        throw new Error(data.error ?? "Trop de sessions créées rapprochées. Réessayez dans quelques minutes.");
      }
      if (!response.ok || !data.session) {
        throw new Error(data.error ?? "Création de la session live impossible.");
      }
      setLiveStatus("starting");
      setObservations([]);
      observationIdRef.current = 0;
      log("info", `Session « ${nom.trim()} » créée — démarrage du moteur interne gen3…`);
      try {
        await demarrerCapture(data.session.id);
      } catch (error) {
        setLiveStatus("idle");
        const message = error instanceof Error ? error.message : "Démarrage impossible";
        setActivationError(
          /permission|denied|dismissed/i.test(message)
            ? "Capture refusée : sélectionnez l'écran (ou autorisez la caméra) pour démarrer l'agent."
            : message,
        );
      }
    } catch (error) {
      setActivationError(error instanceof Error ? error.message : "Activation impossible (réseau).");
      setLiveStatus("idle");
    } finally {
      setBusy(false);
    }
  }, [busy, consentement, demarrerCapture, log, nom, objectif, permissions, sessionDisponible]);

  const approuverAction = useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!runtime || !pendingApproval || approbBusy) return;
    setApprobBusy(true);
    try {
      const response = await authFetch(`/api/live/sessions/${runtime.sessionId}/actions/${pendingApproval.actionId}/approve`, { method: "POST" });
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
  }, [approbBusy, log, pendingApproval]);

  // Nettoyage si le panneau (ou le chat) est démonté pendant une session.
  useEffect(
    () => () => {
      if (loopRef.current) clearInterval(loopRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  if (sessionDisponible === false) {
    return (
      <div className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5 text-center">
        <p className="text-sm text-[var(--g3-muted)]">Connectez-vous pour activer l&apos;agent live ici, dans le chat.</p>
        <Link href="/login?next=/chat" className="g3-btn g3-btn-primary mt-3 inline-flex text-xs">Se connecter</Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {liveStatus === "idle" || liveStatus === "stopped" ? (
        /* Carte d'activation — le moteur interne, aucune clé externe. */
        <section className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-4">
          <h3 className="text-sm font-semibold">Activer l&apos;agent live (moteur interne gen3)</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--g3-muted)]">
            L&apos;agent observe votre écran (PC) ou votre caméra (mobile) depuis le navigateur et vous guide
            étape par étape — décision par le moteur IA INTERNE de gen3, aucune clé API, aucun service externe.
          </p>
          <label className="mt-3 block text-[11px] font-semibold uppercase tracking-wide text-[var(--g3-faint)]">Nom de la session</label>
          <input
            value={nom}
            onChange={(event) => setNom(event.target.value)}
            maxLength={120}
            className="g3-input mt-1 text-sm"
            aria-label="Nom de la session live"
          />
          <label className="mt-3 block text-[11px] font-semibold uppercase tracking-wide text-[var(--g3-faint)]">Objectif de la mission</label>
          <textarea
            value={objectif}
            onChange={(event) => setObjectif(event.target.value)}
            placeholder="Ex. Vérifie l&apos;avancement de ma présentation ouverte à l&apos;écran et dis-moi ce qu&apos;il reste à faire…"
            maxLength={20000}
            className="g3-textarea mt-1 min-h-20 text-sm"
            aria-label="Objectif de la mission live"
          />
          <div className="mt-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--g3-faint)]">Source de capture</div>
            <div className="mt-1.5 flex flex-wrap gap-2">
              <button
                type="button"
                aria-pressed={source === "screen"}
                onClick={() => setSource("screen")}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${source === "screen" ? "bg-[var(--g3-deep)] text-white" : "border border-[var(--g3-border-strong)] text-[var(--g3-muted)]"}`}
              >
                Écran (PC)
              </button>
              <button
                type="button"
                aria-pressed={source === "camera"}
                onClick={() => setSource("camera")}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${source === "camera" ? "bg-[var(--g3-deep)] text-white" : "border border-[var(--g3-border-strong)] text-[var(--g3-muted)]"}`}
              >
                Caméra (mobile)
              </button>
              {source === "camera" ? (
                <button
                  type="button"
                  onClick={() => setCameraFacing((facing) => (facing === "environment" ? "user" : "environment"))}
                  className="rounded-full border border-[var(--g3-border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--g3-muted)]"
                >
                  Caméra {cameraFacing === "environment" ? "arrière" : "avant"} ⇄
                </button>
              ) : null}
            </div>
          </div>
          <div className="mt-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--g3-faint)]">Permissions accordées</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {(Object.keys(PERMISSION_LABELS) as Permission[]).map((permission) => (
                <button
                  key={permission}
                  type="button"
                  aria-pressed={permissions.includes(permission)}
                  onClick={() => togglePermission(permission)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${permissions.includes(permission) ? "border-[var(--g3-secondary-soft)] bg-[var(--g3-secondary-soft)] text-[var(--g3-info)]" : "border-[var(--g3-border)] text-[var(--g3-muted)]"}`}
                >
                  {PERMISSION_LABELS[permission]}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-4 text-[var(--g3-faint)]">
              En navigateur, l&apos;agent observe et décrit ; le contrôle souris/clavier reste réservé à un client PC.
            </p>
          </div>
          <label className="mt-3 flex items-start gap-2 text-xs leading-5 text-[var(--g3-muted)]">
            <input
              type="checkbox"
              checked={consentement}
              onChange={(event) => setConsentement(event.target.checked)}
              className="mt-0.5"
            />
            <span>J&apos;ai compris : les images capturées alimentent le moteur de vision interne de ma session, et je peux arrêter à tout moment.</span>
          </label>
          {activationError ? (
            <p role="alert" className="mt-2 rounded-lg bg-[var(--g3-danger-soft)] px-3 py-2 text-xs text-[var(--g3-danger-strong)]">{activationError}</p>
          ) : null}
          <button
            type="button"
            onClick={() => void activerLive()}
            disabled={busy || !nom.trim() || objectif.trim().length < 10 || permissions.length === 0 || !consentement}
            className="g3-btn g3-btn-primary mt-3 w-full text-sm disabled:opacity-50"
          >
            {busy ? "Activation…" : "Activer l'agent live"}
          </button>
        </section>
      ) : (
        /* Session active : aperçu + HITL + journal + arrêt. */
        <section className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              Agent live — <span className="text-[var(--g3-success-strong)]">{liveStatus === "running" ? "observation en cours" : "démarrage…"}</span>
            </h3>
            <button
              type="button"
              onClick={() => void stopLive(true)}
              className="rounded-full border border-[var(--g3-border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--g3-muted)] hover:bg-[var(--g3-elevated)]"
            >
              Arrêter
            </button>
          </div>
          <div className="mt-2 overflow-hidden rounded-xl border border-[var(--g3-border)] bg-black/90" aria-busy={liveStatus === "starting"}>
            <video ref={videoRef} autoPlay muted playsInline className="max-h-56 w-full object-contain" />
          </div>
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
            Moteur de vision INTERNE gen3 (aucun service externe) · suivi HITL complet sur{" "}
            <Link href="/live" className="underline" onClick={() => void stopLive(false)}>l&apos;espace Live</Link>.
          </p>
        </section>
      )}
    </div>
  );
}
