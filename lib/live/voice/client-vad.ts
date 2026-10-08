/**
 * VAD client « Live Voix » (Task 110-b) — détection de parole 100 % navigateur.
 *
 * Module PUR : aucune API navigateur, aucune horloge (tout l'état temporel
 * passe par les horodatages fournis à `feed`) — testable sans DOM ni jsdom.
 *
 * Principe (contrat 110-0) :
 *  - plancher de bruit ADAPTATIF : EMA (α ≈ 0.02) sur le RMS des trames de
 *    silence — le plancher suit la pièce (ventilateur, route…) sans jamais
 *    descendre sous `minFloor` ni dépasser `maxFloor` ;
 *  - machine à états { SILENCE, SPEECH, HANGOVER } :
 *      · SILENCE → SPEECH  : rms > plancher × marge (1.8×, ou 2.2× en mode
 *        « playback ») pendant ≥ 2 trames consécutives (anti-clic) ;
 *      · SPEECH → HANGOVER : trame sous le seuil (fin probable) ;
 *      · HANGOVER → SILENCE : 700 ms sous le seuil → fin d'énoncé
 *        (`speech_end`) ; une trame au-dessus repart en SPEECH (le hangover
 *        tolère les micro-pauses de respiration) ;
 *  - mode « playback » : pendant la lecture de la réponse de l'agent, le
 *    seuil est majoré (×2.2) et une parole CONFIRMÉE ≥ 250 ms émet un
 *    `barge_in` (garde anti-écho : l'écho des haut-parleurs, atténué par
 *    l'echoCancellation, ne franchit pas ce seuil aussi longtemps) ;
 *  - flush forcé : un énoncé de 25 s est clôturé (`force_flush`).
 *
 * Les événements retournés par `feed` pilotent le hook `use-live-voice` :
 * speech_start → début de capture, speech_end/force_flush → envoi du tour,
 * barge_in → coupure de la lecture en cours.
 */

/** Types d'événements émis par la machine à états. */
export type VadEventType = "speech_start" | "speech_end" | "barge_in" | "force_flush";

/** Résultat d'une trame : au plus UN événement (le plus prioritaire). */
export interface VadResult {
  event: VadEventType | null;
  /** Durée de l'énoncé clôturé (ms) — présent sur speech_end/force_flush. */
  durationMs?: number;
}

export interface VoiceVadOptions {
  /** Coefficient d'adaptation EMA du plancher (défaut 0.02). */
  floorAlpha?: number;
  /** Marge multiplicative au-dessus du plancher (défaut 1.8). */
  speechFactor?: number;
  /** Majoration du seuil pendant la lecture (défaut 2.2). */
  playbackFactor?: number;
  /** Plancher initial (défaut 0.006). */
  initialFloor?: number;
  /** Plancher absolu minimal — un silence très pur ne l'abaisse pas (défaut 0.004). */
  minFloor?: number;
  /** Plancher absolu maximal — un bruit de fond fort ne l'élève pas (défaut 0.12). */
  maxFloor?: number;
  /** Trames consécutives au-dessus du seuil pour démarrer (défaut 2 ≈ 100 ms). */
  speechStartFrames?: number;
  /** Durée du hangover avant clôture de l'énoncé (défaut 700 ms). */
  hangoverMs?: number;
  /** Parole confirmée pendant la lecture avant barge-in (défaut 250 ms). */
  bargeInMs?: number;
  /** Durée maximale d'un énoncé avant flush forcé (défaut 25 000 ms). */
  maxUtteranceMs?: number;
}

/** Valeurs par défaut du contrat 110-0. */
export const VOICE_VAD_DEFAULTS: Required<VoiceVadOptions> = {
  floorAlpha: 0.02,
  speechFactor: 1.8,
  playbackFactor: 2.2,
  initialFloor: 0.006,
  minFloor: 0.004,
  maxFloor: 0.12,
  speechStartFrames: 2,
  hangoverMs: 700,
  bargeInMs: 250,
  maxUtteranceMs: 25_000,
};

/** États de la machine à états. */
type VadState = "SILENCE" | "SPEECH" | "HANGOVER";

/**
 * RMS d'une trame d'échantillons PCM 16 bits, normalisé [0, 1].
 * (les valeurs Int16 sont ramenées en flottant par /32768 avant calcul).
 */
export function computeRms(samples: Int16Array): number {
  const length = samples.length;
  if (length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < length; i++) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / length);
}

/**
 * Un pas d'EMA du plancher de bruit vers le RMS observé : l'« événement »
 * de référence n'existe pas, on suit exponentiellement le niveau de silence.
 * Pur : ne mute rien — c'est l'appelant qui conserve le plancher.
 */
export function adaptFloor(currentFloor: number, silenceRms: number, alpha = VOICE_VAD_DEFAULTS.floorAlpha): number {
  return currentFloor + alpha * (silenceRms - currentFloor);
}

/** Borne un plancher adaptatif entre un minimum et un maximum absolus. */
function clampFloor(floor: number, minFloor: number, maxFloor: number): number {
  if (floor < minFloor) return minFloor;
  if (floor > maxFloor) return maxFloor;
  return floor;
}

/**
 * Crée une instance de VAD. Toutes les méthodes sont sans effet de bord
 * global : l'horloge est fournie par l'appelant (ms epoch quelconques).
 */
export function createVoiceVad(options: VoiceVadOptions = {}): {
  feed(frameRms: number, nowMs: number): VadResult;
  setPlaybackMode(active: boolean): void;
  reset(): void;
} {
  const opts = { ...VOICE_VAD_DEFAULTS, ...options };

  let state: VadState = "SILENCE";
  let floor = opts.initialFloor;
  let playbackMode = false;

  /** Trames consécutives au-dessus du seuil pendant SILENCE. */
  let aboveCount = 0;
  /** Dernière trame au-dessus du seuil (départ du hangover). */
  let lastAboveMs = 0;
  /** Début de l'énoncé en cours (moment du speech_start). */
  let utteranceStartMs = 0;
  /** Début de l'épisode de parole continue en mode playback (barge-in). */
  let bargeStartMs: number | null = null;
  /** Barge-in déjà émis pour l'épisode courant (un seul par épisode). */
  let bargeEmitted = false;

  /** Seuil effectif courant (dépend du mode playback). */
  function threshold(): number {
    return floor * (playbackMode ? opts.playbackFactor : opts.speechFactor);
  }

  function feed(frameRms: number, nowMs: number): VadResult {
    // 1) Flush forcé : un énoncé ne peut pas dépasser maxUtteranceMs.
    if (state !== "SILENCE" && nowMs - utteranceStartMs >= opts.maxUtteranceMs) {
      const durationMs = nowMs - utteranceStartMs;
      state = "SILENCE";
      aboveCount = 0;
      bargeStartMs = null;
      bargeEmitted = false;
      return { event: "force_flush", durationMs };
    }

    const above = frameRms > threshold();

    // 2) Transitions de la machine à états.
    if (state === "SILENCE") {
      if (above) {
        aboveCount += 1;
        if (aboveCount >= opts.speechStartFrames) {
          state = "SPEECH";
          utteranceStartMs = nowMs;
          return { event: "speech_start" };
        }
      } else {
        // Silence confirmé : le plancher suit le bruit de fond (EMA),
        // borné par des planchers absolus pour ne pas se piéger.
        floor = clampFloor(adaptFloor(floor, frameRms, opts.floorAlpha), opts.minFloor, opts.maxFloor);
        aboveCount = 0;
      }
    } else if (state === "SPEECH") {
      if (!above) {
        // Fin probable : on entre en hangover (micro-pause tolérée).
        state = "HANGOVER";
      }
    } else {
      // HANGOVER
      if (above) {
        state = "SPEECH";
      } else if (nowMs - lastAboveMs >= opts.hangoverMs) {
        const durationMs = nowMs - utteranceStartMs;
        state = "SILENCE";
        aboveCount = 0;
        bargeStartMs = null;
        bargeEmitted = false;
        return { event: "speech_end", durationMs };
      }
    }

    if (above) lastAboveMs = nowMs;

    // 3) Barge-in : en mode playback, une parole CONFIRMÉE (≥ bargeInMs de
    // trames consécutives au-dessus du seuil majoré) coupe la lecture.
    if (playbackMode) {
      if (above) {
        if (bargeStartMs === null) {
          bargeStartMs = nowMs;
        } else if (!bargeEmitted && nowMs - bargeStartMs >= opts.bargeInMs) {
          bargeEmitted = true;
          return { event: "barge_in" };
        }
      } else {
        bargeStartMs = null;
        bargeEmitted = false;
      }
    } else {
      bargeStartMs = null;
      bargeEmitted = false;
    }

    return { event: null };
  }

  return {
    feed,
    /**
     * Active/désactive le mode « playback » (lecture de la réponse) : le
     * seuil est majoré (garde anti-écho) et le barge-in devient actif.
     * Réinitialise le suivi d'épisode de barge-in.
     */
    setPlaybackMode(active: boolean) {
      playbackMode = active;
      bargeStartMs = null;
      bargeEmitted = false;
    },
    /** Retour à l'état initial (plancher conservé : la pièce n'a pas changé). */
    reset() {
      state = "SILENCE";
      aboveCount = 0;
      utteranceStartMs = 0;
      lastAboveMs = 0;
      bargeStartMs = null;
      bargeEmitted = false;
    },
  };
}

/** Type public de l'instance créée (pratique pour le typage du hook). */
export type VoiceVad = ReturnType<typeof createVoiceVad>;
