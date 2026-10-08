/**
 * useLiveVoice (Task 110-b) — hook React de la conversation vocale en direct.
 *
 * Machine d'états : idle → requesting → listening ⇄ (thinking ⇄ speaking)
 * → stopped | exhausted | error.
 *
 * Flux d'un tour (contrat 110-0, serverless — HTTP POST + NDJSON, aucun
 * WebSocket) :
 *  1. session   : POST /api/live/voice/session → jeton HMAC sans état
 *                 {token, conversationId, expiresAt, epoch, maxEpochs} ;
 *  2. micro     : getUserMedia (echoCancellation + noiseSuppression +
 *                 autoGainControl) → AudioContext → AudioWorklet
 *                 « /worklets/live-voice-capture.js » ;
 *  3. VAD       : les messages {type:"rms"} du worklet alimentent
 *                 createVoiceVad (client-vad.ts) — speech_start démarre la
 *                 capture, speech_end/force_flush la vident ;
 *  4. tour      : {type:"utterance"} → encodeWav → POST
 *                 /api/live/voice/turn (FormData : audio, token, meta,
 *                 durationSec) → flux NDJSON (protocole 110-a) ;
 *  5. lecture   : les dataUri « audio » sont joués EN FILE (new Audio,
 *                 événement ended → suivant) ; le VAD passe en mode
 *                 playback pendant la lecture ;
 *  6. barge-in  : parole confirmée ≥ 250 ms pendant la lecture → l'audio
 *                 courant est coupé, la file vidée, retour à l'écoute ;
 *  7. session   : un tick 1 s consulte computeRenewalClock → renew
 *                 automatique à T-30 s (une fois par epoch) ; expiration →
 *                 état `exhausted` ; arrêt utilisateur → POST stop + cleanup.
 *
 * Le hook N'A PAS besoin de "use client" : le composant qui le consomme
 * (app/live/voix/voice-live-dashboard.tsx) porte la directive.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { authFetch, readJsonSafely } from "@/lib/firebase/auth-client";
import { computeRenewalDecision, SESSION_MS_DEFAUT } from "@/lib/live/voice/renewal-clock";
import { createVoiceVad, type VoiceVad } from "@/lib/live/voice/client-vad";
import { encodeWav } from "@/lib/live/voice/wav-encoder";
import { parseNdjsonStream } from "@/lib/live/voice/ndjson-stream";
import type {
  CreateSessionResponse,
  LiveVoiceErrorCode,
  LiveVoiceTurnEvent,
  RenewResponse,
} from "@/lib/live/voice/protocol";

/** États exposés à l'UI. */
export type LiveVoiceStatus =
  | "idle"
  | "requesting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error"
  | "stopped"
  | "exhausted";

/** Une entrée du fil de transcript affiché. */
export interface LiveVoiceTranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

/**
 * Codes d'erreur machine exposés à l'UI. Les codes serveur (contrat 110-a)
 * transitent tels quels ; les motifs locaux sont en SCREAMING_SNAKE dédiés :
 *  - MICRO_REFUSE              : permission microphone refusée ;
 *  - NAVIGATEUR_NON_SUPPORTE   : getUserMedia / AudioWorklet absents ;
 *  - SESSION_KO / RESEAU       : impossible d'ouvrir la session.
 */
export type LiveVoiceClientErrorCode = LiveVoiceErrorCode | string;

/** État complet exposé au composant UI. */
export interface LiveVoiceState {
  status: LiveVoiceStatus;
  transcript: LiveVoiceTranscriptEntry[];
  /** Réponse de l'agent en cours de réception (affichée en italique). */
  partialTranscript: string;
  epoch: number;
  maxEpochs: number;
  /** Temps restant de l'epoch courante (ms, tick 1 s). */
  remainingMs: number;
  /** Coût cumulé de la session (centimes, même unité que le wallet). */
  totalCostMinor: number;
  /** Difficulté du dernier tour (simple | standard | avance). */
  lastDifficulty: string | null;
  lastError: string | null;
  errorCode: LiveVoiceClientErrorCode | null;
  muted: boolean;
  conversationId: string | null;
  start: () => Promise<void>;
  stop: () => void;
  toggleMute: () => void;
}

export interface UseLiveVoiceOptions {
  /** Notification de renouvellement réussi (toast discret côté UI). */
  onRenewed?: (epoch: number, maxEpochs: number) => void;
}

/** Durée d'énoncé minimale pour déclencher un tour (anti-bruit résiduel). */
const MIN_UTTERANCE_MS = 250;

/** Petit utilitaire : démarre un Audio HTML et retourne sa promesse de lecture. */
function jouerAudio(src: string): HTMLAudioElement {
  const audio = new Audio(src);
  audio.preload = "auto";
  return audio;
}

export function useLiveVoice(options: UseLiveVoiceOptions = {}): LiveVoiceState {
  const [status, setStatusState] = useState<LiveVoiceStatus>("idle");
  const [transcript, setTranscript] = useState<LiveVoiceTranscriptEntry[]>([]);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [epoch, setEpoch] = useState(0);
  const [maxEpochs, setMaxEpochs] = useState(0);
  const [remainingMs, setRemainingMs] = useState(0);
  const [totalCostMinor, setTotalCostMinor] = useState(0);
  const [lastDifficulty, setLastDifficulty] = useState<string | null>(null);
  const [lastError, setLastErrorState] = useState<string | null>(null);
  const [errorCode, setErrorCodeState] = useState<LiveVoiceClientErrorCode | null>(null);
  const [muted, setMutedState] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);

  /* --------------------------- Réfs d'exécution --------------------------- */

  const statusRef = useRef<LiveVoiceStatus>("idle");
  const mutedRef = useRef(false);
  const vadRef = useRef<VoiceVad | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tokenRef = useRef<string | null>(null);
  const epochRef = useRef(0);
  const maxEpochsRef = useRef(0);
  const startedAtRef = useRef(0);
  const expiresAtRef = useRef(0);
  const lastRenewAtRef = useRef<number | undefined>(undefined);
  const renewInFlightRef = useRef(false);
  const renewDisabledRef = useRef(false);
  /** Capture d'énoncé en cours (buffer worklet actif) → autorise le flush. */
  const captureActiveRef = useRef(false);
  /** Un tour HTTP est en vol (interdit d'en lancer deux en parallèle). */
  const turnInFlightRef = useRef(false);
  /** Énoncé arrivé pendant un tour en vol → envoyé à la fin du tour. */
  const pendingUtteranceRef = useRef<Int16Array | null>(null);
  /** File des dataUri à jouer + audio courant. */
  const queueRef = useRef<string[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** Callback UI (toast renouvellement) — dernière version à chaque rendu. */
  const onRenewedRef = useRef(options.onRenewed);
  useEffect(() => {
    onRenewedRef.current = options.onRenewed;
  });

  const setStatus = useCallback((next: LiveVoiceStatus) => {
    statusRef.current = next;
    setStatusState(next);
  }, []);

  const setErreur = useCallback((code: LiveVoiceClientErrorCode | null, message: string | null) => {
    setErrorCodeState(code);
    setLastErrorState(message);
  }, []);

  /* --------------------------- Lecture audio ----------------------------- */

  /** Coupe l'audio courant et vide la file (barge-in, stop, erreur). */
  const arreterLecture = useCallback(() => {
    queueRef.current = [];
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
      audioRef.current = null;
    }
  }, []);

  /** File d'audio vidée et tour terminé → retour à l'écoute. */
  const revenirALecoute = useCallback(() => {
    if (audioRef.current || queueRef.current.length > 0) return;
    vadRef.current?.setPlaybackMode(false);
    if (statusRef.current === "speaking" || statusRef.current === "thinking") {
      setStatus("listening");
    }
  }, [setStatus]);

  const jouerSuivant = useCallback(() => {
    const prochain = queueRef.current.shift();
    if (prochain === undefined) {
      audioRef.current = null;
      revenirALecoute();
      return;
    }
    const audio = jouerAudio(prochain);
    audioRef.current = audio;
    audio.onended = () => {
      audio.onended = null;
      jouerSuivant();
    };
    audio.onerror = () => {
      audio.onended = null;
      jouerSuivant();
    };
    audio.play().catch(() => {
      // Lecture refusée (politique autoplay, média illisible) : on enchaîne.
      audio.onended = null;
      jouerSuivant();
    });
  }, [revenirALecoute]);

  const diffuser = useCallback(
    (dataUri: string) => {
      queueRef.current.push(dataUri);
      if (!audioRef.current) jouerSuivant();
    },
    [jouerSuivant],
  );

  /* --------------------------- Erreurs fatales --------------------------- */

  /** Libère micro, graphe audio, timers et lecture — l'état UI reste affiché. */
  const nettoyerRessources = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    arreterLecture();
    const node = nodeRef.current;
    if (node) {
      node.port.onmessage = null;
      try {
        node.disconnect();
      } catch {
        /* déjà déconnecté */
      }
      nodeRef.current = null;
    }
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
    const ctx = ctxRef.current;
    if (ctx) {
      void ctx.close().catch(() => {
        /* déjà fermé */
      });
      ctxRef.current = null;
    }
    vadRef.current = null;
    tokenRef.current = null;
    captureActiveRef.current = false;
    turnInFlightRef.current = false;
    pendingUtteranceRef.current = null;
    renewInFlightRef.current = false;
    renewDisabledRef.current = false;
    startedAtRef.current = 0;
    expiresAtRef.current = 0;
    lastRenewAtRef.current = undefined;
  }, [arreterLecture]);

  /** Clôture serveur best-effort (audit) — jamais bloquante pour l'UI. */
  const cloreCoteServeur = useCallback((token: string) => {
    void authFetch(
      "/api/live/voice/stop",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      },
      { timeoutMs: 10_000 },
    ).catch(() => {
      /* best effort : l'audit serveur est tolérant aux pertes */
    });
  }, []);

  /** Crédits épuisés (402 session/renew ou error LIVE_INSUFFICIENT_FUNDS). */
  const signalerCreditsEpuises = useCallback(() => {
    const token = tokenRef.current;
    if (token) cloreCoteServeur(token);
    nettoyerRessources();
    setErreur(
      "LIVE_INSUFFICIENT_FUNDS",
      "Crédits insuffisants : rechargez votre portefeuille pour poursuivre les conversations vocales.",
    );
    setStatus("error");
  }, [cloreCoteServeur, nettoyerRessources, setErreur, setStatus]);

  /* ----------------------------- Tour de parole --------------------------- */

  const envoyerTour = useCallback(
    async (pcm: Int16Array, sampleRate: number) => {
      const token = tokenRef.current;
      if (!token || pcm.length === 0) return;

      turnInFlightRef.current = true;
      setPartialTranscript("");
      setStatus("thinking");

      try {
        const wav = encodeWav([pcm], sampleRate || 16_000);
        const formulaire = new FormData();
        formulaire.append("audio", wav, "enonce.wav");
        formulaire.append("token", token);
        formulaire.append("durationSec", String(pcm.length / (sampleRate || 16_000)));
        formulaire.append("meta", JSON.stringify({ clientEpoch: epochRef.current }));

        const response = await authFetch("/api/live/voice/turn", {
          method: "POST",
          body: formulaire,
        });

        if (response.status === 402) {
          signalerCreditsEpuises();
          return;
        }
        if (!response.ok || !response.body) {
          // Erreurs JSON hors flux (401/403/413/429…) : message du serveur.
          const details = await readJsonSafely<{ error?: string; code?: LiveVoiceErrorCode }>(response);
          const code = details?.code ?? "LIVE_TURN_FAILED";
          if (code === "LIVE_INSUFFICIENT_FUNDS") {
            signalerCreditsEpuises();
            return;
          }
          if (code === "LIVE_SESSION_EXPIRED" || code === "LIVE_SESSION_INVALID" || code === "LIVE_PC_ONLY") {
            const tokenActuel = tokenRef.current;
            if (tokenActuel) cloreCoteServeur(tokenActuel);
            nettoyerRessources();
            setErreur(
              code,
              details?.error ??
                "Session vocale invalide ou expirée : démarrez une nouvelle conversation.",
            );
            setStatus("error");
            return;
          }
          setErreur(
            code,
            details?.error ?? "Le serveur n'a pas pu traiter ce tour de parole. Réessayez dans un instant.",
          );
          setStatus("listening");
          return;
        }

        // Lecture du flux NDJSON (protocole 110-a).
        let partiel = "";
        let commit = false;
        for await (const event of parseNdjsonStream<LiveVoiceTurnEvent>(response.body.getReader())) {
          switch (event.type) {
            case "transcript": {
              const texte = event.text.trim();
              if (texte) setTranscript((courant) => [...courant, { role: "user", text: texte }]);
              break;
            }
            case "sentence": {
              if (event.text) {
                partiel = partiel ? `${partiel} ${event.text}` : event.text;
                setPartialTranscript(partiel);
              }
              break;
            }
            case "audio": {
              if (event.dataUri) {
                vadRef.current?.setPlaybackMode(true);
                diffuser(event.dataUri);
              }
              break;
            }
            case "usage": {
              setTotalCostMinor((courant) => courant + event.costMinor);
              setLastDifficulty(event.difficulty);
              break;
            }
            case "error": {
              // Événement FINAL du flux (contrat 110-a).
              if (event.code === "LIVE_INSUFFICIENT_FUNDS") {
                signalerCreditsEpuises();
                return;
              }
              if (event.code === "LIVE_SESSION_EXPIRED" || event.code === "LIVE_SESSION_INVALID") {
                const tokenActuel = tokenRef.current;
                if (tokenActuel) cloreCoteServeur(tokenActuel);
                nettoyerRessources();
                setErreur(event.code, event.message);
                setStatus("error");
                return;
              }
              // Erreurs de tour (STT vide, rate limit, panne) : la session
              // reste valide — on affiche et on reprend l'écoute.
              setErreur(event.code, event.message);
              break;
            }
            case "done": {
              const texte = event.replyText.trim() || partiel;
              if (texte) setTranscript((courant) => [...courant, { role: "assistant", text: texte }]);
              commit = true;
              setPartialTranscript("");
              revenirALecoute();
              break;
            }
          }
        }
        // Flux terminé sans `done` explicite : commit le texte partiel.
        if (!commit && partiel) {
          setTranscript((courant) => [...courant, { role: "assistant", text: partiel }]);
          setPartialTranscript("");
        }
        revenirALecoute();
      } catch {
        // Panne réseau en cours de tour : la session reste valide.
        setErreur("RESEAU", "Connexion interrompue pendant le tour. Vérifiez votre réseau puis parlez à nouveau.");
        revenirALecoute();
      } finally {
        turnInFlightRef.current = false;
        // Un énoncé est arrivé pendant le tour → envoie-le maintenant.
        const enAttente = pendingUtteranceRef.current;
        if (enAttente && tokenRef.current) {
          pendingUtteranceRef.current = null;
          void envoyerTourRef.current?.(enAttente, 16_000);
        }
      }
    },
    [
      cloreCoteServeur,
      diffuser,
      nettoyerRessources,
      revenirALecoute,
      setErreur,
      setStatus,
      signalerCreditsEpuises,
    ],
  );

  /** Indirection stable pour la chaîne « énoncé en attente → tour suivant ». */
  const envoyerTourRef = useRef<((pcm: Int16Array, sampleRate: number) => Promise<void>) | null>(null);
  useEffect(() => {
    envoyerTourRef.current = envoyerTour;
  }, [envoyerTour]);

  /* --------------------------- Messages du worklet ------------------------ */

  const traiterRms = useCallback(
    (value: number) => {
      if (mutedRef.current) return; // Muet : le VAD est coupé, aucun tour n'est envoyé.
      const vad = vadRef.current;
      const node = nodeRef.current;
      if (!vad || !node) return;

      const resultat = vad.feed(value, Date.now());
      switch (resultat.event) {
        case "speech_start": {
          // Pendant la lecture, un speech_start isolé est probablement de
          // l'écho : seul le barge-in (parole confirmée) tranche.
          if (statusRef.current === "speaking") break;
          if (captureActiveRef.current) break;
          captureActiveRef.current = true;
          node.port.postMessage({ type: "start" });
          break;
        }
        case "barge_in": {
          arreterLecture();
          vad.setPlaybackMode(false);
          captureActiveRef.current = true;
          node.port.postMessage({ type: "start" });
          setStatus("listening");
          break;
        }
        case "speech_end":
        case "force_flush": {
          if (!captureActiveRef.current) break; // épisode d'écho : rien à envoyer
          captureActiveRef.current = false;
          node.port.postMessage({ type: "flush" });
          setStatus("thinking");
          break;
        }
        default:
          break;
      }
    },
    [arreterLecture, setStatus],
  );

  const traiterUtterance = useCallback(
    (pcm: Int16Array, sampleRate: number) => {
      if (!pcm || pcm.length === 0) return;
      if ((pcm.length / (sampleRate || 16_000)) * 1000 < MIN_UTTERANCE_MS) return;
      if (turnInFlightRef.current) {
        pendingUtteranceRef.current = pcm;
        return;
      }
      void envoyerTour(pcm, sampleRate);
    },
    [envoyerTour],
  );

  const gererMessageWorklet = useCallback(
    (event: MessageEvent) => {
      const message = event.data as
        | { type?: string; value?: number; pcm?: Int16Array; sampleRate?: number }
        | undefined;
      if (!message) return;
      if (message.type === "rms" && typeof message.value === "number") {
        traiterRms(message.value);
      } else if (message.type === "utterance" && message.pcm instanceof Int16Array) {
        traiterUtterance(message.pcm, message.sampleRate ?? 16_000);
      }
    },
    [traiterRms, traiterUtterance],
  );

  /* --------------------------- Session & renew ---------------------------- */

  const renouveler = useCallback(async () => {
    const token = tokenRef.current;
    if (!token || renewInFlightRef.current || renewDisabledRef.current) return;
    renewInFlightRef.current = true;
    try {
      const response = await authFetch(
        "/api/live/voice/renew",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        },
        { timeoutMs: 15_000 },
      );
      if (response.status === 402) {
        signalerCreditsEpuises();
        return;
      }
      if (response.status === 403) {
        // Dernière epoch atteinte ou grâce dépassée : on cesse de demander,
        // l'expiration mènera naturellement à l'état exhausted.
        renewDisabledRef.current = true;
        return;
      }
      if (!response.ok) return; // échec transitoire : nouvelle tentative au tick suivant
      const session = await readJsonSafely<RenewResponse>(response);
      if (!session?.token) return;
      tokenRef.current = session.token;
      epochRef.current = session.epoch;
      maxEpochsRef.current = session.maxEpochs;
      expiresAtRef.current = session.expiresAt;
      // L'expiration serveur fait foi : startedAt = expiresAt - durée défaut
      // (le calcul de remainingMs reste exact quel que soit le ajustement).
      startedAtRef.current = session.expiresAt - SESSION_MS_DEFAUT;
      lastRenewAtRef.current = Date.now();
      setEpoch(session.epoch);
      setMaxEpochs(session.maxEpochs);
      onRenewedRef.current?.(session.epoch, session.maxEpochs);
    } catch {
      /* réseau : nouvelle tentative au prochain tick (garde lastRenewAt non posée) */
    } finally {
      renewInFlightRef.current = false;
    }
  }, [signalerCreditsEpuises]);

  const tick = useCallback(() => {
    const expiresAt = expiresAtRef.current;
    if (!expiresAt) return;
    const maintenant = Date.now();
    setRemainingMs(Math.max(0, expiresAt - maintenant));

    if (maintenant >= expiresAt) {
      // Durée atteinte (toutes epochs confondues) → état exhausted.
      nettoyerRessources();
      setErreur(null, "Durée maximale de la conversation atteinte. Lancez une nouvelle session pour continuer.");
      setStatus("exhausted");
      return;
    }

    const decision = computeRenewalDecision({
      startedAtMs: startedAtRef.current || expiresAt - SESSION_MS_DEFAUT,
      nowMs: maintenant,
      epoch: epochRef.current,
      maxEpochs: maxEpochsRef.current,
      lastRenewAtMs: lastRenewAtRef.current,
    });
    if (decision.action === "renew") void renouveler();
  }, [nettoyerRessources, renouveler, setErreur, setStatus]);

  /* ------------------------------ Actions UI ------------------------------ */

  const demarrer = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (tokenRef.current || streamRef.current) return; // déjà actif
    if (!navigator.mediaDevices?.getUserMedia) {
      setErreur(
        "NAVIGATEUR_NON_SUPPORTE",
        "Votre navigateur ne gère pas la capture audio (getUserMedia). La conversation vocale nécessite un ordinateur avec Chrome ou Edge.",
      );
      setStatus("error");
      return;
    }

    setStatus("requesting");
    setErreur(null, null);
    setTranscript([]);
    setPartialTranscript("");
    setTotalCostMinor(0);
    setLastDifficulty(null);

    // 1) Session serveur (avant l'autorisation micro : les erreurs de
    //    crédits arrivent sans invite de permission inutile).
    try {
      const response = await authFetch(
        "/api/live/voice/session",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
        { timeoutMs: 20_000 },
      );
      if (response.status === 402) {
        signalerCreditsEpuises();
        return;
      }
      if (!response.ok) {
        const details = await readJsonSafely<{ error?: string; code?: string }>(response);
        const code = details?.code ?? "SESSION_KO";
        setErreur(
          code,
          details?.error ??
            "Impossible d'ouvrir la session vocale. Vérifiez votre connexion puis réessayez.",
        );
        setStatus("error");
        return;
      }
      const session = await readJsonSafely<CreateSessionResponse>(response);
      if (!session?.token) {
        setErreur("SESSION_KO", "Réponse de session invalide. Réessayez dans un instant.");
        setStatus("error");
        return;
      }
      tokenRef.current = session.token;
      setConversationId(session.conversationId);
      epochRef.current = session.epoch;
      maxEpochsRef.current = session.maxEpochs;
      expiresAtRef.current = session.expiresAt;
      startedAtRef.current = session.expiresAt - SESSION_MS_DEFAUT;
      lastRenewAtRef.current = undefined;
      renewDisabledRef.current = false;
      setEpoch(session.epoch);
      setMaxEpochs(session.maxEpochs);
      setRemainingMs(Math.max(0, session.expiresAt - Date.now()));
    } catch {
      setErreur("RESEAU", "Connexion au serveur impossible. Vérifiez votre réseau puis réessayez.");
      setStatus("idle");
      return;
    }

    // 2) Micro.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      const token = tokenRef.current;
      if (token) cloreCoteServeur(token);
      tokenRef.current = null;
      setErreur(
        "MICRO_REFUSE",
        "Micro refusé : autorisez le microphone pour ce site (icône cadenassée dans la barre d'adresse → Autorisations → Microphone), puis réessayez.",
      );
      setStatus("idle");
      return;
    }
    streamRef.current = stream;

    // 3) Graphe audio + worklet.
    try {
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      if (!ctx.audioWorklet) throw new Error("AudioWorklet indisponible");
      if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
      await ctx.audioWorklet.addModule("/worklets/live-voice-capture.js");
      const node = new AudioWorkletNode(ctx, "live-voice-capture");
      nodeRef.current = node;
      node.port.onmessage = gererMessageWorklet;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(node);
      // Sortie du worklet muette (le processeur n'écrit rien) : la connexion
      // maintient le graphe actif sans réinjecter de son dans les haut-parleurs.
      node.connect(ctx.destination);
      vadRef.current = createVoiceVad();
    } catch {
      nettoyerRessources();
      setErreur(
        "NAVIGATEUR_NON_SUPPORTE",
        "AudioWorklet non disponible : utilisez Chrome ou Edge sur ordinateur (PC) pour la conversation vocale.",
      );
      setStatus("error");
      return;
    }

    // 4) Tick de session (compteur + renouvellement T-30 s).
    timerRef.current = setInterval(tick, 1_000);
    setStatus("listening");
  }, [
    cloreCoteServeur,
    gererMessageWorklet,
    nettoyerRessources,
    setErreur,
    setStatus,
    signalerCreditsEpuises,
    tick,
  ]);

  const arreter = useCallback(() => {
    const token = tokenRef.current;
    if (!token && !streamRef.current) return; // rien à arrêter
    if (token) cloreCoteServeur(token);
    nettoyerRessources();
    setPartialTranscript("");
    setStatus("stopped");
  }, [cloreCoteServeur, nettoyerRessources, setStatus]);

  /** Arrêt complet si le composant est démonté (onglet fermé, navigation). */
  useEffect(() => {
    return () => {
      const token = tokenRef.current;
      if (token) cloreCoteServeur(token);
      nettoyerRessources();
    };
  }, [cloreCoteServeur, nettoyerRessources]);

  const basculerMuet = useCallback(() => {
    const prochain = !mutedRef.current;
    mutedRef.current = prochain;
    setMutedState(prochain);
    if (prochain) {
      // Coupe le VAD (les rms sont ignorés) et abandonne tout énoncé en cours.
      captureActiveRef.current = false;
      nodeRef.current?.port.postMessage({ type: "stop" });
    }
  }, []);

  return {
    status,
    transcript,
    partialTranscript,
    epoch,
    maxEpochs,
    remainingMs,
    totalCostMinor,
    lastDifficulty,
    lastError,
    errorCode,
    muted,
    conversationId,
    start: demarrer,
    stop: arreter,
    toggleMute: basculerMuet,
  };
}
