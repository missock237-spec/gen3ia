"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { type User } from "firebase/auth";

import { watchAuth } from "@/lib/firebase/client";
import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";
import type { LiveAction } from "@/lib/live/types";

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

interface LivePendingActionInfo {
  actionId: string;
  action?: { type?: string; description?: string } | string;
  createdAt?: number;
}

interface LiveInFlightInfo {
  actionId: string;
  action?: { type?: string; description?: string } | string;
}

interface LiveSessionPublic {
  id: string;
  name: string;
  objective: string;
  status: string;
  permissions: Permission[];
  createdAt: number;
  expiresAt?: number;
  deviceId?: string;
  mode?: "browser" | "desktop";
  pendingAction?: LivePendingActionInfo | null;
  inFlightAction?: LiveInFlightInfo | null;
}

interface CreatedSession {
  session: LiveSessionPublic;
  pairingToken: string;
  viewerToken: string;
}

interface FrameActionRef {
  actionId: string;
  action: LiveAction;
}

interface FrameResponse {
  decision: { done: boolean; message: string } | null;
  action?: FrameActionRef;
  pendingApproval?: FrameActionRef;
  pendingAction?: { actionId: string; approvedAt?: number | null } | null;
  paused?: boolean;
  pauseReason?: string;
  error?: string;
  code?: string;
}

type ObservationKind = "observation" | "action" | "result" | "pause" | "info" | "error";

interface ObservationEntry {
  id: number;
  at: number;
  kind: ObservationKind;
  text: string;
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700 border-amber-200",
  connected: "bg-sky-100 text-sky-700 border-sky-200",
  running: "bg-emerald-100 text-emerald-600 border-emerald-200",
  paused: "bg-[var(--g3-elevated)] text-[var(--g3-muted)] border-[var(--g3-border)]",
  disconnected: "bg-[var(--g3-elevated)] text-[var(--g3-muted)] border-[var(--g3-border)]",
  stopped: "bg-[var(--g3-elevated)] text-[var(--g3-muted)] border-[var(--g3-border)]",
  failed: "bg-red-50 text-red-600 border-red-200",
};

const KIND_STYLES: Record<ObservationKind, string> = {
  observation: "text-[var(--g3-text-secondary)]",
  action: "text-sky-700 font-medium",
  result: "text-[var(--g3-muted)]",
  pause: "text-amber-700",
  info: "text-emerald-700",
  error: "text-red-600",
};

const FRAME_INTERVAL_MS = 3_000;
const MAX_CAPTURE_WIDTH = 1280;
const BROWSER_UNSUPPORTED_ERROR =
  "Action réservée à un client PC : en mode navigateur, l'agent observe et décrit, mais ne peut pas agir sur l'ordinateur.";

function formatDate(ts: number) {
  return new Date(ts).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString("fr-FR", { timeStyle: "medium" });
}

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

function actionLabel(action: LivePendingActionInfo["action"] | LiveInFlightInfo["action"]): string {
  if (!action) return "action inconnue";
  if (typeof action === "string") return action;
  const parts = [action.type, action.description].filter(Boolean);
  return parts.length > 0 ? parts.join(" — ") : "action inconnue";
}

function makeDeviceId(): string {
  const raw = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `web-${raw.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 16)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function LiveDashboard() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [sessions, setSessions] = useState<LiveSessionPublic[]>([]);
  const [created, setCreated] = useState<CreatedSession | null>(null);
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [liveConsent, setLiveConsent] = useState(false);
  const [permissions, setPermissions] = useState<Permission[]>([
    "screen.read",
    "input.mouse",
    "input.keyboard",
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [browserError, setBrowserError] = useState("");

  // État du client Live navigateur (aucun téléchargement requis).
  const [liveSessionId, setLiveSessionId] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<"idle" | "starting" | "running" | "stopped">("idle");
  const [observations, setObservations] = useState<ObservationEntry[]>([]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sendingRef = useRef(false);
  const runtimeRef = useRef<{ sessionId: string; deviceId: string } | null>(null);
  const loggedPauseRef = useRef<string | null>(null);
  const observationIdRef = useRef(0);

  const sessionDisponible = useSessionAvailable();

  const log = useCallback((kind: ObservationKind, text: string) => {
    observationIdRef.current += 1;
    const entry: ObservationEntry = { id: observationIdRef.current, at: Date.now(), kind, text };
    setObservations((current) => [...current.slice(-120), entry]);
  }, []);

  const loadSessions = useCallback(async () => {
    // authFetch : ID token Firebase si disponible, sinon cookie de session.
    // Une panne réseau est isolée : elle ne provoque ni rejet non géré dans
    // le callback watchAuth, ni écran vide silencieux.
    try {
      const response = await authFetch("/api/live/sessions", { cache: "no-store" });
      if (response.ok) setSessions((await response.json()).sessions ?? []);
      else if (response.status >= 500) setError("Impossible de charger vos sessions Live (serveur momentanément indisponible).");
    } catch {
      setError("Connexion au serveur impossible pour charger vos sessions Live.");
    }
  }, []);

  useEffect(
    () =>
      watchAuth(async (current) => {
        setUser(current);
        setAuthReady(true);
        await loadSessions();
      }),
    [loadSessions],
  );

  const togglePermission = (permission: Permission) => {
    setPermissions((current) =>
      current.includes(permission)
        ? current.filter((item) => item !== permission)
        : [...current, permission],
    );
  };

  /* ------------------------------------------------------------------ */
  /* Client Live navigateur : capture d'écran native + boucle de vision  */
  /* ------------------------------------------------------------------ */

  const sendActionResult = useCallback(
    async (actionId: string, ok: boolean, errorMessage?: string) => {
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
    },
    [],
  );

  const executeBrowserAction = useCallback(
    async (action: FrameActionRef) => {
      log("action", `Action de l'agent : ${describeAction(action.action)}`);
      if (action.action.type === "wait") {
        await sleep(action.action.ms);
        await sendActionResult(action.actionId, true);
        log("result", "Attente terminée — l'agent poursuit son observation.");
        return;
      }
      // Le navigateur ne contrôle ni la souris, ni le clavier, ni les
      // fichiers : le résultat honnête est un échec explicite, que le
      // moteur de vision intègre pour adapter ses décisions suivantes.
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
      if (data.decision?.message) {
        log(data.decision.done ? "info" : "observation", data.decision.message);
      }
      if (data.decision?.done) {
        stopCaptureLoop();
        setLiveStatus("idle");
        log("info", "Objectif atteint — l'agent se met en pause. Vous pouvez arrêter la session.");
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
      // Frame perdue (réseau, onglet) : la boucle suivante réessaie.
    } finally {
      sendingRef.current = false;
    }
  }, [executeBrowserAction, log, stopCaptureLoop]);

  const stopBrowserLive = useCallback(
    async (stopSession: boolean) => {
      stopCaptureLoop();
      teardownStream();
      const runtime = runtimeRef.current;
      runtimeRef.current = null;
      setLiveStatus("stopped");
      setLiveSessionId(null);
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
      await loadSessions();
    },
    [loadSessions, log, stopCaptureLoop, teardownStream],
  );

  const startBrowserLive = useCallback(
    async (target: { id: string }) => {
      if (sessionDisponible === false) {
        setBrowserError("Session expirée. Reconnectez-vous.");
        return;
      }
      if (!navigator.mediaDevices?.getDisplayMedia) {
        setBrowserError("Votre navigateur ne prend pas en charge le partage d'écran natif (utilisez Chrome, Edge ou Firefox sur ordinateur).");
        return;
      }
      setBrowserError("");
      setLiveStatus("starting");
      try {
        const deviceId = makeDeviceId();
        const startResponse = await authFetch(`/api/live/sessions/${target.id}/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceId }),
        });
        if (!startResponse.ok) {
          const data = (await startResponse.json().catch(() => ({}))) as FrameResponse;
          throw new Error(data.error || "Démarrage impossible");
        }

        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 2 },
          audio: false,
        });
        streamRef.current = stream;
        runtimeRef.current = { sessionId: target.id, deviceId };
        loggedPauseRef.current = null;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        stream.getVideoTracks().forEach((track) =>
          track.addEventListener("ended", () => {
            log("info", "Partage d'écran interrompu depuis le navigateur.");
            void stopBrowserLive(false);
          }),
        );

        setLiveSessionId(target.id);
        setLiveStatus("running");
        log("info", "Partage d'écran actif — l'agent observe votre ordinateur.");
        await loadSessions();

        stopCaptureLoop();
        loopRef.current = setInterval(() => {
          void captureAndSendFrame();
        }, FRAME_INTERVAL_MS);
      } catch (e) {
        teardownStream();
        runtimeRef.current = null;
        setLiveStatus("idle");
        const message = e instanceof Error ? e.message : "Démarrage impossible";
        setBrowserError(
          /permission|denied|dismissed/i.test(message)
            ? "Partage d'écran refusé : sélectionnez l'écran à partager pour démarrer l'agent."
            : message,
        );
      }
    },
    [loadSessions, log, sessionDisponible, stopBrowserLive, stopCaptureLoop, teardownStream, captureAndSendFrame],
  );

  // Nettoyage si l'onglet se ferme pendant une session active.
  useEffect(
    () => () => {
      if (loopRef.current) clearInterval(loopRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  /* ------------------------------------------------------------------ */
  /* Sessions : création, arrêt, approbations                            */
  /* ------------------------------------------------------------------ */

  const createSession = async () => {
    if (sessionDisponible === false) { setError("Session expirée. Reconnectez-vous."); return; }
    if (name.trim().length === 0 || objective.trim().length < 10 || permissions.length === 0 || !liveConsent) return;
    setBusy(true);
    setError("");
    setCreated(null);
    try {
      const response = await authFetch("/api/live/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), objective: objective.trim(), permissions, mode: "browser" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Création impossible");
      setCreated(data);
      await loadSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Création impossible");
    } finally {
      setBusy(false);
    }
  };

  const stopSession = async (id: string) => {
    if (sessionDisponible === false) return;
    if (liveSessionId === id) await stopBrowserLive(false);
    await authFetch(`/api/live/sessions/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    await loadSessions();
  };

  const approveAction = async (sessionId: string, actionId: string) => {
    if (sessionDisponible === false) { setError("Session expirée. Reconnectez-vous."); return; }
    setError("");
    try {
      const response = await authFetch(`/api/live/sessions/${sessionId}/actions/${actionId}/approve`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Approbation impossible");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approbation impossible");
    } finally {
      await loadSessions();
    }
  };

  const retryAction = async (sessionId: string, actionId: string) => {
    if (sessionDisponible === false) { setError("Session expirée. Reconnectez-vous."); return; }
    if (!window.confirm("Le résultat de l'action précédente est inconnu : réessayer peut l'exécuter deux fois. Continuer ?")) return;
    setError("");
    try {
      const response = await authFetch(`/api/live/sessions/${sessionId}/actions/${actionId}/retry`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Réessai impossible");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Réessai impossible");
    } finally {
      await loadSessions();
    }
  };

  // Rafraîchit les sessions pour afficher les actions en attente de validation.
  useEffect(() => {
    if (!authReady) return;
    const interval = setInterval(() => { void loadSessions(); }, 6_000);
    return () => clearInterval(interval);
  }, [authReady, loadSessions]);

  if (!authReady || sessionDisponible === null) {
    return <div className="p-10 text-center text-[var(--g3-muted)]">Chargement…</div>;
  }

  if (sessionDisponible === false) {
    return (
      <div className="mx-auto max-w-md rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-8 text-center shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
        <h2 className="font-serif text-xl font-semibold">Connexion requise</h2>
        <p className="mt-2 text-sm text-[var(--g3-muted)]">
          Connectez-vous pour créer et piloter des sessions d’agent Live.
        </p>
        <Link href="/login" className="g3-btn g3-btn-primary mt-6">
          Se connecter
        </Link>
      </div>
    );
  }

  const sessionActive = liveSessionId ?? created?.session.id ?? null;

  return (
    <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
      <section className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
        <h2 className="font-serif text-xl font-semibold">Créer une session d’agent Live</h2>
        <p className="mt-2 text-sm text-[var(--g3-muted)]">
          Décrivez la mission : l’agent observe votre écran depuis le navigateur,
          analyse chaque étape et vous guide. Aucun téléchargement requis.
        </p>
        <label className="mt-5 block text-xs uppercase tracking-widest text-[var(--g3-muted)]">Nom de la session</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex. Préparer la présentation client"
          maxLength={120}
          className="g3-input mt-2"
        />
        <label className="mt-4 block text-xs uppercase tracking-widest text-[var(--g3-muted)]">Objectif</label>
        <textarea
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="Ex. Vérifie l’avancement de ma présentation ouverte à l’écran et dis-moi ce qu’il reste à faire…"
          className="g3-textarea mt-2 min-h-32"
        />
        <div className="mt-4">
          <div className="text-xs uppercase tracking-widest text-[var(--g3-muted)]">Permissions accordées</div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {(Object.keys(PERMISSION_LABELS) as Permission[]).map((permission) => (
              <button
                key={permission}
                onClick={() => togglePermission(permission)}
                className={`rounded-xl border px-4 py-2.5 text-left text-sm transition ${
                  permissions.includes(permission)
                    ? "border-sky-200 bg-sky-100 text-sky-700"
                    : "border-[rgba(23,23,20,0.09)] bg-[var(--g3-elevated)] text-[var(--g3-muted)] hover:bg-[var(--g3-elevated)]"
                }`}
              >
                {PERMISSION_LABELS[permission]}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs leading-5 text-[var(--g3-faint)]">
            En mode navigateur, l’agent observe l’écran et décrit les étapes ; le
            contrôle clavier/souris reste réservé à un client PC.
          </p>
        </div>
        <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] px-4 py-3 text-sm leading-6 text-[var(--g3-text-secondary)]">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-neutral-900"
            checked={liveConsent}
            onChange={(e) => setLiveConsent(e.target.checked)}
          />
          <span>
            J’ai compris que cet agent va <strong>observer l’écran de cet ordinateur</strong> selon les permissions
            sélectionnées. Je donne mon consentement explicite avant chaque session.
          </span>
        </label>
        <button
          disabled={busy || name.trim().length === 0 || objective.trim().length < 10 || permissions.length === 0 || !liveConsent}
          onClick={createSession}
          className="g3-btn g3-btn-primary mt-4"
        >
          {busy ? "Création…" : "Créer la session Live"}
        </button>
        {error && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">{error}</div>
        )}

        {created && (
          <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
            <div className="text-sm font-semibold text-emerald-600">Session créée — {created.session.name}</div>
            <div className="mt-1 text-xs text-[var(--g3-muted)]">ID : {created.session.id}</div>
            <button
              onClick={() => {
                setObservations([]);
                void startBrowserLive(created.session);
              }}
              disabled={liveStatus === "starting" || liveStatus === "running"}
              className="g3-btn g3-btn-primary mt-4"
            >
              {liveStatus === "starting" ? "Démarrage…" : liveStatus === "running" ? "Agent actif" : "Tester dans ce navigateur"}
            </button>
            <p className="mt-3 text-xs leading-5 text-[var(--g3-muted)]">
              Votre navigateur vous demandera quel écran partager. La session
              expire au bout de 24 h si elle reste inactive.
            </p>
          </div>
        )}
      </section>

      <div className="space-y-5">
        <section className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-serif text-lg font-semibold">Agent Live — dans le navigateur</h2>
              <p className="mt-1 text-xs text-[var(--g3-muted)]">
                Aucun téléchargement : partage d’écran natif, analyse par l’IA en temps réel.
              </p>
            </div>
            <span className="rounded-full border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] px-2.5 py-1 text-[11px] text-[var(--g3-muted)]">
              {liveStatus === "running" ? "LIVE" : liveStatus === "starting" ? "démarrage" : liveStatus === "stopped" ? "arrêté" : "hors ligne"}
            </span>
          </div>

          <div className="relative mt-4 overflow-hidden rounded-2xl border border-[rgba(23,23,20,0.09)] bg-black aspect-video flex items-center justify-center">
            <video ref={videoRef} muted playsInline autoPlay className="h-full w-full object-contain" />
            {liveStatus !== "running" && liveStatus !== "starting" && (
              <span className="absolute text-sm text-[var(--g3-faint)]">Aucun partage d’écran actif</span>
            )}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {sessionActive && liveStatus !== "running" && (
              <button
                onClick={() => {
                  const target = created?.session.id === sessionActive
                    ? created.session
                    : sessions.find((item) => item.id === sessionActive);
                  if (target) {
                    setObservations([]);
                    void startBrowserLive(target);
                  }
                }}
                disabled={liveStatus === "starting"}
                className="g3-btn g3-btn-primary"
              >
                {liveStatus === "starting" ? "Démarrage…" : "Partager l’écran et démarrer"}
              </button>
            )}
            {liveStatus === "running" && liveSessionId && (
              <button onClick={() => void stopBrowserLive(true)} className="g3-btn g3-btn-ghost">
                Arrêter la session
              </button>
            )}
            {liveStatus === "stopped" && (
              <button onClick={() => setLiveStatus("idle")} className="rounded-xl border border-[rgba(23,23,20,0.09)] px-4 py-2 text-xs font-semibold text-[var(--g3-muted)] hover:bg-[var(--g3-elevated)]">
                Réinitialiser
              </button>
            )}
          </div>
          {browserError && (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">{browserError}</div>
          )}

          <div className="mt-4">
            <div className="text-xs uppercase tracking-widest text-[var(--g3-muted)]">Journal de l’agent</div>
            <div className="mt-2 max-h-64 space-y-1.5 overflow-y-auto rounded-2xl border border-[rgba(23,23,20,0.08)] bg-[var(--g3-elevated)] p-3">
              {observations.length === 0 ? (
                <p className="text-xs text-[var(--g3-faint)]">
                  Les observations de l’agent apparaîtront ici dès qu’une session est active.
                </p>
              ) : (
                observations.map((entry) => (
                  <p key={entry.id} className={`text-xs leading-5 ${KIND_STYLES[entry.kind]}`}>
                    <span className="mr-2 font-mono text-[10px] text-[var(--g3-faint)]">{formatTime(entry.at)}</span>
                    {entry.text}
                  </p>
                ))
              )}
            </div>
          </div>

          <p className="mt-4 rounded-xl border border-amber-200 bg-amber-100 p-3 text-xs leading-5 text-amber-700">
            En mode navigateur, l’agent observe, analyse et vous guide action par
            action — il ne contrôle pas votre clavier ni votre souris. Chaque
            action sensible exige de toute façon votre validation.
          </p>
        </section>

        <section className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
          <h2 className="font-serif text-lg font-semibold">Sessions récentes</h2>
          {sessions.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--g3-muted)]">Aucune session pour le moment.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {sessions.map((session) => (
                <li key={session.id} className="rounded-xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-elevated)] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="truncate text-sm font-semibold">{session.name}</div>
                    <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] ${STATUS_STYLES[session.status] ?? STATUS_STYLES.paused}`}>
                      {session.status}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-[var(--g3-faint)]">{formatDate(session.createdAt)}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {session.permissions.map((permission) => (
                      <span key={permission} className="rounded-md border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] px-2 py-0.5 text-[10px] text-[var(--g3-muted)]">
                        {permission}
                      </span>
                    ))}
                  </div>
                  {session.pendingAction?.actionId && (
                    <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
                      <div className="text-xs font-semibold text-amber-700">Action sensible en attente de votre validation</div>
                      <div className="mt-1 truncate font-mono text-[10px] text-amber-600">{actionLabel(session.pendingAction.action)}</div>
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() => approveAction(session.id, session.pendingAction!.actionId)}
                          className="rounded-lg border border-emerald-300 bg-emerald-100 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-200"
                        >
                          Approuver
                        </button>
                        <button
                          onClick={() => stopSession(session.id)}
                          className="rounded-lg border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--g3-muted)] hover:bg-[var(--g3-elevated)]"
                        >
                          Refuser et arrêter
                        </button>
                      </div>
                    </div>
                  )}
                  {session.inFlightAction?.actionId && (
                    <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3">
                      <div className="text-xs font-semibold text-sky-700">Action en cours dont le résultat est inconnu</div>
                      <div className="mt-1 truncate font-mono text-[10px] text-sky-600">{actionLabel(session.inFlightAction.action)}</div>
                      <button
                        onClick={() => retryAction(session.id, session.inFlightAction!.actionId)}
                        className="mt-2 rounded-lg border border-sky-300 bg-[var(--g3-surface)] px-3 py-1.5 text-xs font-semibold text-sky-700 hover:bg-sky-100"
                      >
                        Réessayer
                      </button>
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {["pending", "connected", "running", "paused"].includes(session.status) && (
                      <>
                        {liveSessionId !== session.id && (
                          <button
                            onClick={() => {
                              setObservations([]);
                              void startBrowserLive(session);
                            }}
                            className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 hover:bg-sky-100"
                          >
                            Tester dans le navigateur
                          </button>
                        )}
                        <button
                          onClick={() => stopSession(session.id)}
                          className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100"
                        >
                          Stop
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
