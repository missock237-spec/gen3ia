"use client";

/**
 * PANNEAU « GEMINI LIVE (SOURCE + VOIX) » — PC (écran) ET ANDROID (caméra).
 *
 * Intégration du fichier autonome « Gemini Live Screen & Voice App.html »
 * (fourni par le propriétaire : genIA Desktop — Live & Partage d'Écran),
 * adaptée aux DEUX familles d'appareils :
 *
 *  - PC (Windows/Linux/macOS) : partage d'écran natif getDisplayMedia,
 *    1 fps → canvas → JPEG 0,6 — identique au fichier d'origine ;
 *  - ANDROID / iOS / tablette : le partage d'écran N'EXISTE PAS sur ces
 *    navigateurs (getDisplayMedia indisponible) — la CAMÉRA
 *    (getUserMedia, bascule avant/arrière) est la source visuelle
 *    équivalente, honnêtement étiquetée. Aucune simulation d'écran.
 *
 * CAPACITÉS RÉELLES (inchangées, mécanique du fichier d'origine) :
 *  - Vision + voix en direct via l'API Gemini Live (WebSocket
 *    BidiGenerateContent v1alpha, modèle gemini-2.0-flash-exp, voix Puck),
 *    appelée DEPUIS LE NAVIGATEUR — aucun relais local (le
 *    ws://localhost:8080 du fichier d'origine n'est pas nécessaire : le
 *    client parle DIRECTEMENT au WebSocket officiel de Google, la CSP du
 *    projet autorise wss://*.googleapis.com) ;
 *  - Voix : micro PCM16 16 kHz en continu (realtimeInput audio/pcm) via
 *    ScriptProcessorNode 4096 ; réponses audio PCM 24 kHz mises en file de
 *    lecture via AudioContext ; barge-in VAD (RMS > 0,06) pendant la lecture,
 *    barge-in serveur (serverContent.interrupted) et bouton manuel.
 *
 * LIMITES / MODÈLE DE SÉCURITÉ (HONNÊTETÉ) :
 *  - La clé API Gemini est saisie par l'opérateur, stockée dans
 *    sessionStorage de CE navigateur et n'est JAMAIS envoyée au backend
 *    gen3ia : elle transite directement vers le WebSocket officiel de Google.
 *  - Modèle expérimental Google : disponibilité, format et quotas côté Google
 *    peuvent évoluer sans préavis ; images et voix partent chez Google
 *    pendant la session.
 *  - Le décideur interne du système live (lib/live/vision-decider.ts,
 *    perception structurelle, moteur Gen3) reste INCHANGÉ pour le canal
 *    gen3ia ; ce panneau ne crée pas de session gen3ia.
 *  - Capture micro : ScriptProcessorNode 4096 (le worklet 110-0 livre des
 *    énoncés VAD-gated incompatibles avec un flux continu).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  GeminiLiveSession,
  GEMINI_INPUT_SAMPLE_RATE,
  computeRms,
  float32ToPcm16Base64,
  type GeminiLiveState,
} from "@/lib/live/gemini-live-client";

const GEMINI_KEY_STORAGE = "gen3ia-gemini-key";
const GEMINI_FRAME_INTERVAL_MS = 1_000;
const GEMINI_MAX_CAPTURE_WIDTH = 1280;
const GEMINI_JPEG_QUALITY = 0.6;
const GEMINI_MIC_BUFFER_SIZE = 4096;

type GeminiJournalKind = "system" | "ai" | "error";

/** Source visuelle du Live : écran (PC) ou caméra (Android/iOS/tablette). */
type SourceVisuelle = "ecran" | "camera";

const SOURCE_LABELS: Record<SourceVisuelle, string> = {
  ecran: "Écran (PC)",
  camera: "Caméra (Android)",
};

interface GeminiJournalEntry {
  id: number;
  at: number;
  kind: GeminiJournalKind;
  text: string;
}

const JOURNAL_STYLES: Record<GeminiJournalKind, string> = {
  system: "text-[var(--g3-text-secondary)]",
  ai: "text-[var(--g3-info)] font-medium",
  error: "text-[var(--g3-danger-strong)] font-semibold",
};

const STATE_LABELS: Record<GeminiLiveState, string> = {
  idle: "hors ligne",
  connecting: "connexion…",
  live: "LIVE",
  closed: "arrêté",
};

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString("fr-FR", { timeStyle: "medium" });
}

export function LiveGeminiPanel() {
  const [apiKey, setApiKey] = useState("");
  const [state, setState] = useState<GeminiLiveState>("idle");
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [journal, setJournal] = useState<GeminiJournalEntry[]>([]);
  // Source visuelle : « ecran » sur PC, « camera » sur Android/iOS —
  // détectée une fois au montage (getDisplayMedia indisponible sur mobile).
  const [sourceMode, setSourceMode] = useState<SourceVisuelle>("ecran");
  const [ecranDisponible, setEcranDisponible] = useState(true);
  const [facing, setFacing] = useState<"environment" | "user">("environment");

  const sessionRef = useRef<GeminiLiveSession | null>(null);
  const runningRef = useRef(false);
  const startingRef = useRef(false);
  const videoStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const captureVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const journalIdRef = useRef(0);
  const sourceModeRef = useRef<SourceVisuelle>("ecran");
  const facingRef = useRef<"environment" | "user">("environment");

  useEffect(() => {
    sourceModeRef.current = sourceMode;
  }, [sourceMode]);
  useEffect(() => {
    facingRef.current = facing;
  }, [facing]);

  // Détection honnête des capacités (une fois) : sans getDisplayMedia
  // (Android/iOS), la source écran est indisponible → caméra imposée.
  useEffect(() => {
    const supporte = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia);
    setEcranDisponible(supporte);
    setSourceMode(supporte ? "ecran" : "camera");
  }, []);

  const addJournal = useCallback((kind: GeminiJournalKind, text: string) => {
    journalIdRef.current += 1;
    const entry: GeminiJournalEntry = { id: journalIdRef.current, at: Date.now(), kind, text };
    setJournal((current) => [...current.slice(-150), entry]);
  }, []);

  /**
   * Arrêt propre et idempotent : interval d'images, nœuds audio, pistes
   * écran/micro, WebSocket et AudioContext de lecture — équivalent strict de
   * stopSession() du fichier HTML d'origine.
   */
  const stopLive = useCallback(
    (reason: string) => {
      const wasActive = runningRef.current || sessionRef.current !== null;
      runningRef.current = false;
      if (frameIntervalRef.current) {
        clearInterval(frameIntervalRef.current);
        frameIntervalRef.current = null;
      }
      processorRef.current?.disconnect();
      processorRef.current = null;
      micSourceRef.current?.disconnect();
      micSourceRef.current = null;
      silentGainRef.current?.disconnect();
      silentGainRef.current = null;
      if (audioContextRef.current) {
        void audioContextRef.current.close().catch(() => undefined);
        audioContextRef.current = null;
      }
      videoStreamRef.current?.getTracks().forEach((track) => track.stop());
      videoStreamRef.current = null;
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
      if (captureVideoRef.current) captureVideoRef.current.srcObject = null;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) session.close();
      else setState((current) => (current === "closed" ? current : "closed"));
      setPlaying(false);
      setBusy(false);
      if (wasActive) addJournal("system", reason);
    },
    [addJournal],
  );

  const stopLiveRef = useRef(stopLive);
  useEffect(() => {
    stopLiveRef.current = stopLive;
  }, [stopLive]);

  // La clé reste dans CE navigateur (sessionStorage) — jamais au backend.
  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem(GEMINI_KEY_STORAGE);
      if (saved) setApiKey(saved);
    } catch {
      // sessionStorage indisponible (navigation privée stricte) : la clé
      // restera simplement en mémoire React pour la session d'onglet.
    }
  }, []);

  const handleApiKeyChange = (value: string) => {
    setApiKey(value);
    try {
      if (value) window.sessionStorage.setItem(GEMINI_KEY_STORAGE, value);
      else window.sessionStorage.removeItem(GEMINI_KEY_STORAGE);
    } catch {
      // Écriture impossible : la clé reste en mémoire React uniquement.
    }
  };

  const startLive = useCallback(async () => {
    if (runningRef.current || startingRef.current) return;
    const key = apiKey.trim();
    if (!key) {
      addJournal("error", "Saisissez votre clé API Gemini pour démarrer le mode Live.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      addJournal("error", "Ce navigateur ne prend pas en charge la capture micro/caméra.");
      return;
    }
    const mode = sourceModeRef.current;
    if (mode === "ecran" && !navigator.mediaDevices?.getDisplayMedia) {
      addJournal("error", "Ce navigateur ne prend pas en charge le partage d'écran — utilisez le mode Caméra.");
      return;
    }
    startingRef.current = true;
    setBusy(true);
    addJournal("system", `Connexion au WebSocket Gemini Live (gemini-2.0-flash-exp, voix Puck) — source : ${SOURCE_LABELS[mode]}…`);

    const session = new GeminiLiveSession({
      onStateChange: (next) => {
        setState(next);
        if (next === "closed" && runningRef.current) {
          stopLiveRef.current("Connexion Gemini fermée — session arrêtée.");
        }
      },
      onSetupComplete: () => addJournal("system", "Session Gemini prête (setupComplete)."),
      onText: (text) => addJournal("ai", text),
      onAudioPlaying: (isPlaying) => setPlaying(isPlaying),
      onInterrupt: (source) => {
        const label =
          source === "vad"
            ? "[Barge-in] Voix de l'IA coupée : vous avez parlé."
            : source === "server"
              ? "[Barge-in] Voix coupée par le serveur Gemini."
              : "[Barge-in] Interruption manuelle déclenchée.";
        addJournal("system", label);
      },
      onTurnComplete: () => addJournal("system", "L'IA a terminé son tour."),
      onError: (message) => addJournal("error", message),
    });
    sessionRef.current = session;

    try {
      await session.connect(key);
      runningRef.current = true;

      // 1) SOURCE VISUELLE — écran (PC) ou caméra (Android/iOS) :
      //    1 fps → canvas → JPEG 0,6 dans les deux cas (mécanique du
      //    fichier d'origine, source adaptée à l'appareil).
      const videoStream =
        mode === "ecran"
          ? await navigator.mediaDevices.getDisplayMedia({
              video: { frameRate: 1 },
              audio: false,
            })
          : await navigator.mediaDevices.getUserMedia({
              video: { facingMode: facingRef.current, width: { ideal: 1280 }, height: { ideal: 720 } },
              audio: false,
            });
      videoStreamRef.current = videoStream;
      videoStream.getVideoTracks().forEach((track) =>
        track.addEventListener("ended", () => {
          stopLiveRef.current("Session arrêtée : source visuelle terminée.");
        }),
      );
      if (captureVideoRef.current) {
        captureVideoRef.current.srcObject = videoStream;
        await captureVideoRef.current.play().catch(() => undefined);
      }

      // 2) Micro : PCM16 16 kHz continu via ScriptProcessorNode 4096 (voir
      //    l'en-tête : le worklet 110-0 est incompatible avec un flux continu).
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: GEMINI_INPUT_SAMPLE_RATE, echoCancellation: true, noiseSuppression: true },
      });
      micStreamRef.current = micStream;
      const audioContext = new AudioContext({ sampleRate: GEMINI_INPUT_SAMPLE_RATE });
      audioContextRef.current = audioContext;
      const micSource = audioContext.createMediaStreamSource(micStream);
      micSourceRef.current = micSource;
      const processor = audioContext.createScriptProcessor(GEMINI_MIC_BUFFER_SIZE, 1, 1);
      processorRef.current = processor;
      // Gain 0 : le ScriptProcessor doit être connecté à la destination pour
      // tourner, mais le micro ne doit PAS revenir dans les haut-parleurs.
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      silentGainRef.current = silentGain;

      processor.onaudioprocess = (event) => {
        const active = sessionRef.current;
        if (!active || !runningRef.current) return;
        const input = event.inputBuffer.getChannelData(0);
        // VAD barge-in (RMS > 0,06 pendant la lecture — fichier HTML) puis
        // envoi du chunk PCM16 16 kHz en base64 ; la session protège les
        // envois si le socket n'est plus OPEN.
        active.notifyMicRms(computeRms(input));
        active.sendAudioChunk(float32ToPcm16Base64(input));
      };

      micSource.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);

      // 3) Frames : canvas → JPEG 0,6 → 1 image/seconde (écran OU caméra).
      const canvas = canvasRef.current ?? document.createElement("canvas");
      canvasRef.current = canvas;
      frameIntervalRef.current = setInterval(() => {
        const active = sessionRef.current;
        const video = captureVideoRef.current;
        if (!active || !runningRef.current || !video || video.videoWidth === 0) return;
        const scale = Math.min(1, GEMINI_MAX_CAPTURE_WIDTH / video.videoWidth);
        const width = Math.max(1, Math.round(video.videoWidth * scale));
        const height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.width = width;
        canvas.height = height;
        const context2d = canvas.getContext("2d");
        if (!context2d) return;
        context2d.drawImage(video, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", GEMINI_JPEG_QUALITY);
        const jpegBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        if (jpegBase64.length > 64) active.sendImageFrame(jpegBase64);
      }, GEMINI_FRAME_INTERVAL_MS);

      addJournal(
        "system",
        mode === "ecran"
          ? "Live démarré : écran (1 image/s, JPEG) + micro (PCM 16 kHz continu)."
          : `Live démarré : caméra ${facingRef.current === "environment" ? "arrière" : "avant"} (1 image/s, JPEG) + micro (PCM 16 kHz continu).`,
      );
    } catch (error) {
      const raw = error instanceof Error ? error.message : "Démarrage impossible";
      const message = /permission|denied|dismissed/i.test(raw)
        ? "Accès refusé : autorisez la source visuelle et le micro pour démarrer le Live."
        : raw;
      addJournal("error", `Démarrage impossible : ${message}`);
      if (runningRef.current) {
        stopLiveRef.current("Session arrêtée après une erreur de démarrage.");
      } else {
        sessionRef.current = null;
        session.close();
        setState("closed");
      }
    } finally {
      startingRef.current = false;
      setBusy(false);
    }
  }, [apiKey, addJournal]);

  /** Bascule caméra avant/arrière À CHAUD (mode caméra uniquement). */
  const switchCamera = useCallback(async () => {
    if (sourceModeRef.current !== "camera" || !runningRef.current) return;
    const suivant = facingRef.current === "environment" ? "user" : "environment";
    try {
      const nouveau = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: suivant, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      videoStreamRef.current?.getTracks().forEach((track) => track.stop());
      videoStreamRef.current = nouveau;
      if (captureVideoRef.current) {
        captureVideoRef.current.srcObject = nouveau;
        await captureVideoRef.current.play().catch(() => undefined);
      }
      facingRef.current = suivant;
      setFacing(suivant);
      addJournal("system", `Caméra basculée : ${suivant === "environment" ? "arrière" : "avant"}.`);
    } catch (error) {
      addJournal("error", `Bascule caméra impossible : ${error instanceof Error ? error.message : "erreur"}`);
    }
  }, [addJournal]);

  const interruptManual = useCallback(() => {
    const session = sessionRef.current;
    if (!session || !runningRef.current) return;
    session.interrupt("manual");
  }, []);

  // Nettoyage complet si l'onglet se ferme pendant une session active.
  useEffect(
    () => () => {
      stopLiveRef.current("Nettoyage de la page.");
    },
    [],
  );

  const isLive = state === "live";
  const statusLabel = isLive && playing ? "LIVE — voix en lecture" : STATE_LABELS[state];

  return (
    <section className="relative rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
      {/* Source visuelle : cachée en mode écran (frames vers Gemini) ;
          aperçu visible en mode caméra (l'utilisateur vise avec son
          appareil Android). */}
      <video
        ref={captureVideoRef}
        muted
        playsInline
        autoPlay
        aria-hidden={sourceMode !== "camera"}
        tabIndex={-1}
        className={
          sourceMode === "camera"
            ? "mb-4 aspect-video w-full rounded-2xl border border-[var(--g3-border)] bg-black object-cover"
            : "pointer-events-none absolute left-0 top-0 h-px w-px opacity-0"
        }
      />

      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-lg font-semibold">Gemini Live — écran ou caméra + voix (temps réel)</h2>
          <p className="mt-1 text-xs text-[var(--g3-muted)]">
            Le canal Gemini officiel : l&apos;IA voit ce que votre appareil capte —
            votre écran (PC, 1 image/s) ou votre caméra (Android/iOS) — et vous parle
            en voix de synthèse, avec barge-in quand vous coupez la parole.
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] ${
            isLive
              ? "border-[var(--g3-success-soft)] bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]"
              : state === "connecting"
                ? "border-[var(--g3-warning-soft)] bg-[var(--g3-warning-soft)] text-[var(--g3-warning-strong)]"
                : "border-[var(--g3-border)] bg-[var(--g3-surface)] text-[var(--g3-muted)]"
          }`}
        >
          {statusLabel}
        </span>
      </div>

      <div className="mt-4">
        <label className="block text-xs uppercase tracking-widest text-[var(--g3-muted)]" htmlFor="gemini-api-key">
          Clé d&apos;API Gemini (requise pour le WebSocket Live)
        </label>
        <input
          id="gemini-api-key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => handleApiKeyChange(event.target.value)}
          placeholder="Entrez votre clé AI Studio API (AIzaSy…)"
          className="g3-input mt-2"
        />
        <p className="mt-2 text-xs leading-5 text-[var(--g3-muted)]">
          Honnêteté : cette clé reste dans <strong>votre navigateur</strong> (sessionStorage,
          effacée à la fermeture de l&apos;onglet) et n&apos;est <strong>jamais envoyée aux
          serveurs gen3ia</strong>. Elle transite directement vers le WebSocket officiel de
          Google depuis votre machine, exactement comme dans l&apos;application d&apos;origine.
        </p>
      </div>

      {/* Source visuelle : écran sur PC, caméra sur Android/iOS —
          imposée quand le navigateur ne sait pas partager l'écran. */}
      <div className="mt-4 grid grid-cols-2 gap-2" role="tablist" aria-label="Source visuelle du Live">
        {(Object.keys(SOURCE_LABELS) as SourceVisuelle[]).map((mode) => {
          const indisponible = mode === "ecran" && !ecranDisponible;
          return (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={sourceMode === mode}
              disabled={isLive || busy || indisponible}
              onClick={() => setSourceMode(mode)}
              title={indisponible ? "Partage d'écran indisponible sur cet appareil — caméra uniquement." : undefined}
              className={`rounded-xl px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                sourceMode === mode
                  ? "bg-[var(--g3-primary-soft,var(--g3-elevated))] text-[var(--g3-text)] ring-1 ring-[var(--g3-primary-border,var(--g3-border))]"
                  : "text-[var(--g3-muted)] hover:bg-[var(--g3-hover,var(--g3-elevated))]"
              }`}
            >
              {SOURCE_LABELS[mode]}
              {indisponible ? " — indisponible" : ""}
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {!isLive ? (
          <button onClick={() => void startLive()} disabled={busy || state === "connecting"} className="g3-btn g3-btn-primary">
            {busy ? "Démarrage…" : sourceMode === "ecran" ? "Démarrer Live (écran + voix)" : "Démarrer Live (caméra + voix)"}
          </button>
        ) : (
          <button onClick={() => stopLiveRef.current("Session Live arrêtée par l'opérateur.")} className="g3-btn g3-btn-ghost">
            Arrêter
          </button>
        )}
        <button
          onClick={interruptManual}
          disabled={!isLive}
          className="rounded-xl border border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] px-4 py-2 text-sm font-semibold text-[var(--g3-danger-strong)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Interrompre la voix (Barge-in)
        </button>
        {sourceMode === "camera" ? (
          <button
            onClick={() => void switchCamera()}
            disabled={!isLive}
            className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-4 py-2 text-sm font-semibold text-[var(--g3-text)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {facing === "environment" ? "Caméra : arrière → passer à l'avant" : "Caméra : avant → passer à l'arrière"}
          </button>
        ) : null}
      </div>

      <div className="mt-4">
        <div className="text-xs uppercase tracking-widest text-[var(--g3-muted)]">Journal du canal Gemini</div>
        <div className="mt-2 max-h-64 space-y-1.5 overflow-y-auto rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-3">
          {journal.length === 0 ? (
            <p className="text-xs text-[var(--g3-faint)]">
              Saisissez votre clé API puis démarrez : les transcriptions de l&apos;IA, le
              barge-in et les erreurs apparaîtront ici.
            </p>
          ) : (
            journal.map((entry) => (
              <p key={entry.id} className={`text-xs leading-5 ${JOURNAL_STYLES[entry.kind]}`}>
                <span className="mr-2 font-mono text-[10px] text-[var(--g3-faint)]">{formatTime(entry.at)}</span>
                {entry.text}
              </p>
            ))
          )}
        </div>
      </div>

      <p className="mt-4 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-3 text-xs leading-5 text-[var(--g3-muted)]">
        Canal complémentaire : le décideur interne du système Live
        (perception structurelle, moteur Gen3, sessions et approbations HITL)
        reste inchangé. Modèle <strong>expérimental</strong> Google
        (gemini-2.0-flash-exp) : disponibilité, quotas et format de réponse
        côté Google peuvent varier. Pendant la session, vos images (écran ou
        caméra) et votre voix sont envoyées aux serveurs Google. Sur
        Android/iOS, le partage d&apos;écran n&apos;existe pas dans les navigateurs :
        la caméra est la source réelle équivalente — aucun simulacre d&apos;écran.
      </p>
    </section>
  );
}
