/*
 * AudioWorklet de capture « Live Voix » — GEN3IA (Task 110-b).
 *
 * Portée GLOBALE du worklet : PAS de TypeScript, PAS d'import. Ce fichier
 * est chargé tel quel par `audioWorklet.addModule("/worklets/live-voice-capture.js")`.
 *
 * Rôle (contrat 110-0) :
 *  - mesure du RMS de l'entrée micro, postée au thread principal toutes
 *    ~50 ms : { type: "rms", value } — alimente le VAD (client-vad.ts) ;
 *  - rééchantillonnage continu de la fréquence native vers 16 000 Hz
 *    (interpolation linéaire) en Int16 ;
 *  - buffer d'énoncé : démarré sur { type: "start" } (avec un pré-roll de
 *    320 ms pour rattraper la latence du VAD), vidé sur { type: "flush" } →
 *    { type: "utterance", pcm: Int16Array (transféré), sampleRate: 16000 } ;
 *  - limite de 25 s par énoncé → flush automatique ;
 *  - { type: "stop" } réinitialise la capture.
 */

/* global AudioWorkletProcessor, registerProcessor, sampleRate */

const TARGET_SAMPLE_RATE = 16000;
const RMS_INTERVAL_MS = 50;
const MAX_UTTERANCE_MS = 25000;
const MAX_UTTERANCE_SAMPLES = Math.floor((MAX_UTTERANCE_MS * TARGET_SAMPLE_RATE) / 1000);
/** Pré-roll conservé en permanence : rattrape la latence de confirmation du VAD. */
const PRE_ROLL_MS = 320;
const PRE_ROLL_SAMPLES = Math.floor((PRE_ROLL_MS * TARGET_SAMPLE_RATE) / 1000);

class LiveVoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Accumulateurs RMS (sur l'audio NATIF, avant rééchantillonnage).
    this._rmsSumSquares = 0;
    this._rmsSamples = 0;
    // Rééchantillonneur : position fractionnaire du prochain échantillon de
    // sortie dans le chunk courant (report négatif possible → interpolation
    // avec le dernier échantillon du chunk précédent).
    this._resamplePos = 0;
    this._lastSample = 0;
    // Pré-roll permanent (Int16Array immuables, ~PRE_ROLL_SAMPLES).
    this._preRoll = [];
    this._preRollLength = 0;
    // Buffer d'énoncé en cours.
    this._recording = false;
    this._utterance = [];
    this._utteranceLength = 0;

    this.port.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === "start") {
        // Démarre la capture en reprenant le pré-roll (audio déjà passé).
        this._recording = true;
        this._utterance = this._preRoll.slice();
        this._utteranceLength = this._preRollLength;
      } else if (msg.type === "flush") {
        this._flush();
      } else if (msg.type === "stop") {
        this._recording = false;
        this._utterance = [];
        this._utteranceLength = 0;
      }
    };
  }

  /** Clôt l'énoncé : poste le PCM 16 kHz (buffer TRANSFÉRÉ) et réinitialise. */
  _flush() {
    this._recording = false;
    if (this._utteranceLength === 0) {
      this._utterance = [];
      return;
    }
    const pcm = new Int16Array(this._utteranceLength);
    let offset = 0;
    for (const chunk of this._utterance) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }
    this._utterance = [];
    this._utteranceLength = 0;
    // Transfert du buffer : zéro copie vers le thread principal.
    this.port.postMessage({ type: "utterance", pcm, sampleRate: TARGET_SAMPLE_RATE }, [pcm.buffer]);
  }

  /**
   * Rééchantillonne un chunk Float32 natif vers 16 kHz (interpolation
   * linéaire, continuité entre chunks via position fractionnaire reportée)
   * et le convertit en Int16 saturé [-1, 1].
   */
  _resample(chunk) {
    const ratio = sampleRate / TARGET_SAMPLE_RATE;
    const out = [];
    let pos = this._resamplePos;

    // Report négatif : interpole entre le dernier échantillon du chunk
    // précédent (_lastSample) et le premier du chunk courant.
    if (pos < 0) {
      const frac = 1 + pos; // pos ∈ (-1, 0)
      out.push(this._lastSample * (1 - frac) + chunk[0] * frac);
      pos += ratio;
    }

    while (pos < chunk.length - 1) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      out.push(chunk[i0] * (1 - frac) + chunk[i0 + 1] * frac);
      pos += ratio;
    }
    // pos ∈ [chunk.length - 1, …) : le dernier point attend le chunk suivant.

    this._resamplePos = pos - chunk.length;
    this._lastSample = chunk[chunk.length - 1];

    const pcm = new Int16Array(out.length);
    for (let i = 0; i < out.length; i++) {
      const v = Math.max(-1, Math.min(1, out[i]));
      pcm[i] = v < 0 ? v * 32768 : v * 32767;
    }
    return pcm.length > 0 ? pcm : null;
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (!channel || channel.length === 0) return true;

    // 1) RMS natif, posté toutes ~RMS_INTERVAL_MS au thread principal (VAD).
    for (let i = 0; i < channel.length; i++) {
      const v = channel[i];
      this._rmsSumSquares += v * v;
    }
    this._rmsSamples += channel.length;
    if (this._rmsSamples >= (sampleRate * RMS_INTERVAL_MS) / 1000) {
      const rms = Math.sqrt(this._rmsSumSquares / this._rmsSamples);
      this._rmsSumSquares = 0;
      this._rmsSamples = 0;
      this.port.postMessage({ type: "rms", value: rms });
    }

    // 2) Rééchantillonnage continu → 16 kHz Int16.
    const pcm = this._resample(channel);
    if (!pcm) return true;

    // Pré-roll permanent (ring buffer par chunks immuables).
    this._preRoll.push(pcm);
    this._preRollLength += pcm.length;
    while (this._preRollLength > PRE_ROLL_SAMPLES && this._preRoll.length > 1) {
      const head = this._preRoll.shift();
      if (head) this._preRollLength -= head.length;
    }

    // 3) Buffer d'énoncé : accumulation + flush automatique à 25 s.
    if (this._recording) {
      this._utterance.push(pcm);
      this._utteranceLength += pcm.length;
      if (this._utteranceLength >= MAX_UTTERANCE_SAMPLES) this._flush();
    }

    return true;
  }
}

registerProcessor("live-voice-capture", LiveVoiceCaptureProcessor);
