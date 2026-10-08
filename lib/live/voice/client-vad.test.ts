import { describe, expect, it } from "vitest";

import { adaptFloor, computeRms, createVoiceVad, type VoiceVadOptions } from "@/lib/live/voice/client-vad";

/** Options de test déterministes (plancher initial connu, timings serrés). */
function creerVad(overrides: VoiceVadOptions = {}) {
  return createVoiceVad({
    initialFloor: 0.01,
    minFloor: 0.005,
    maxFloor: 0.2,
    floorAlpha: 0.02,
    speechFactor: 1.8,
    playbackFactor: 2.2,
    speechStartFrames: 2,
    hangoverMs: 700,
    bargeInMs: 250,
    maxUtteranceMs: 25_000,
    ...overrides,
  });
}

describe("computeRms", () => {
  it("retourne 0 pour le silence parfait et une trame vide", () => {
    expect(computeRms(new Int16Array(128))).toBe(0);
    expect(computeRms(new Int16Array(0))).toBe(0);
  });

  it("calcule le RMS normalisé d'une trame connue", () => {
    // ±16384 = ±0.5 → RMS = 0.5
    const trame = Int16Array.of(16384, -16384, 16384, -16384);
    expect(computeRms(trame)).toBeCloseTo(0.5, 6);
  });

  it("retourne l'amplitude pour un signal constant positif", () => {
    const trame = new Int16Array(64).fill(32767);
    expect(computeRms(trame)).toBeCloseTo(32767 / 32768, 6);
  });
});

describe("adaptFloor", () => {
  it("applique l'EMA : floor + α × (rms - floor)", () => {
    expect(adaptFloor(0.01, 0.03, 0.02)).toBeCloseTo(0.0104, 9);
  });

  it("converge exponentiellement vers le niveau de silence", () => {
    let floor = 0.05;
    for (let i = 0; i < 400; i++) {
      floor = adaptFloor(floor, 0.002, 0.02);
    }
    expect(floor).toBeGreaterThan(0.002);
    expect(floor).toBeLessThan(0.0025);
  });

  it("utilise α = 0.02 par défaut (contrat 110-0)", () => {
    expect(adaptFloor(0.01, 0.02)).toBeCloseTo(0.0102, 9);
  });
});

describe("createVoiceVad — machine à états", () => {
  it("exige ≥ 2 trames consécutives au-dessus du seuil (anti-clic)", () => {
    const vad = creerVad();
    // Seuil initial : 0.01 × 1.8 = 0.018.
    expect(vad.feed(0.05, 0).event).toBeNull(); // 1 trame au-dessus
    expect(vad.feed(0.001, 50).event).toBeNull(); // retombe : rien
    expect(vad.feed(0.05, 100).event).toBeNull(); // recompte à 1
    expect(vad.feed(0.05, 150).event).toBe("speech_start"); // 2e trame
  });

  it("passe en HANGOVER sous le seuil puis clôt après 700 ms (speech_end)", () => {
    const vad = creerVad();
    vad.feed(0.05, 0);
    expect(vad.feed(0.05, 50).event).toBe("speech_start");

    expect(vad.feed(0.001, 100).event).toBeNull(); // HANGOVER
    expect(vad.feed(0.001, 500).event).toBeNull(); // 400 ms : hangover actif
    const fin = vad.feed(0.001, 900); // 800 ms sous le seuil → clôture
    expect(fin.event).toBe("speech_end");
    expect(fin.durationMs).toBe(850); // 900 - début d'énoncé (50)
  });

  it("tolère une micro-pause : HANGOVER → SPEECH reprend l'énoncé en cours", () => {
    const vad = creerVad();
    vad.feed(0.05, 0);
    vad.feed(0.05, 50); // speech_start
    vad.feed(0.001, 100); // HANGOVER
    expect(vad.feed(0.06, 400).event).toBeNull(); // reprise → SPEECH (pas d'événement)
    vad.feed(0.001, 450); // HANGOVER
    const fin = vad.feed(0.001, 1200);
    expect(fin.event).toBe("speech_end");
    expect(fin.durationMs).toBe(1150); // l'énoncé n'a pas été coupé par la pause
  });

  it("adapte le plancher pendant le silence (EMA borné par minFloor)", () => {
    const vad = creerVad();
    // Beaucoup de silence à 0.002 : le plancher descend vers ~0.005 (minFloor).
    for (let i = 0; i < 500; i++) {
      expect(vad.feed(0.002, i * 50).event).toBeNull();
    }
    // Un niveau intermédiaire devient détectable après adaptation.
    expect(vad.feed(0.02, 26_000).event).toBeNull();
    expect(vad.feed(0.02, 26_050).event).toBe("speech_start");
  });

  it("le plancher ne dépasse jamais maxFloor (bruit de fond fort non piégeant)", () => {
    // Sans borne, un bruit de fond à 0.035 (juste sous le seuil 0.036) ferait
    // monter le plancher vers 0.035 → seuil 0.063 : l'utilisateur devrait
    // PARLER PLUS FORT à mesure que la pièce s'échauffe. La borne maxFloor
    // l'interdit : le seuil plafonne à maxFloor × 1.8 = 0.036.
    const vad = creerVad({ initialFloor: 0.02, maxFloor: 0.02 });
    for (let i = 0; i < 500; i++) {
      expect(vad.feed(0.035, i * 50).event).toBeNull(); // silence au sens du VAD
    }
    expect(vad.feed(0.05, 26_000).event).toBeNull();
    expect(vad.feed(0.05, 26_050).event).toBe("speech_start");
  });

  it("émet force_flush à 25 s d'énoncé et réinitialise la machine", () => {
    const vad = creerVad({ maxUtteranceMs: 1000 });
    vad.feed(0.05, 0);
    vad.feed(0.05, 50); // speech_start (début 50)
    // Trames au-dessus du seuil jusqu'à dépasser 1000 ms d'énoncé.
    let flush = { event: null as string | null, durationMs: undefined as number | undefined };
    for (let t = 100; t <= 1100; t += 50) {
      const resultat = vad.feed(0.05, t);
      if (resultat.event) {
        flush = { event: resultat.event, durationMs: resultat.durationMs };
      }
    }
    expect(flush.event).toBe("force_flush");
    expect(flush.durationMs).toBeGreaterThanOrEqual(1000);
    // La machine est retournée en SILENCE : une trame sous le seuil n'émet rien.
    expect(vad.feed(0.001, 1150).event).toBeNull();
  });

  it("reset() interrompt un énoncé en cours sans speech_end", () => {
    const vad = creerVad();
    vad.feed(0.05, 0);
    vad.feed(0.05, 50); // speech_start
    vad.reset();
    expect(vad.feed(0.001, 2000).event).toBeNull();
    expect(vad.feed(0.001, 5000).event).toBeNull();
  });
});

describe("createVoiceVad — mode playback (barge-in anti-écho)", () => {
  it("majore le seuil (×2.2) : un niveau détectable en normal ne l'est plus", () => {
    // En mode normal, 0.02 > 0.01 × 1.8 = 0.018 → la parole est détectée.
    const normal = creerVad();
    expect(normal.feed(0.02, 0).event).toBeNull();
    expect(normal.feed(0.02, 50).event).toBe("speech_start");

    // En mode playback, le seuil monte à 0.01 × 2.2 = 0.022 : 0.02 passe
    // inaperçu (garde anti-écho pendant la lecture de la réponse).
    const vad = creerVad();
    vad.setPlaybackMode(true);
    for (let i = 0; i < 10; i++) {
      const resultat = vad.feed(0.02, i * 50);
      expect(resultat.event).not.toBe("speech_start");
      expect(resultat.event).not.toBe("barge_in");
    }
  });

  it("émet un barge-in après ≥ 250 ms de parole confirmée pendant la lecture", () => {
    const vad = creerVad();
    vad.setPlaybackMode(true);
    // Trames au-dessus du seuil playback (0.05 > 0.022) toutes les 50 ms.
    let bargeAt: number | null = null;
    for (let t = 0; t <= 400; t += 50) {
      const resultat = vad.feed(0.05, t);
      if (resultat.event === "barge_in") {
        bargeAt = t;
        break;
      }
    }
    expect(bargeAt).toBe(250);
  });

  it("n'émet le barge-in qu'UNE SEULE fois par épisode de parole", () => {
    const vad = creerVad();
    vad.setPlaybackMode(true);
    let compte = 0;
    for (let t = 0; t <= 1000; t += 50) {
      if (vad.feed(0.05, t).event === "barge_in") compte += 1;
    }
    expect(compte).toBe(1);
  });

  it("un retour sous le seuil réarme le barge-in pour l'épisode suivant", () => {
    const vad = creerVad();
    vad.setPlaybackMode(true);
    for (let t = 0; t <= 300; t += 50) vad.feed(0.05, t); // 1er barge-in à 250
    vad.feed(0.001, 350); // retour sous le seuil → réarmement
    let deuxieme = false;
    for (let t = 400; t <= 700; t += 50) {
      if (vad.feed(0.05, t).event === "barge_in") deuxieme = true;
    }
    expect(deuxieme).toBe(true);
  });

  it("un écho bref (< 250 ms) ne déclenche pas de barge-in", () => {
    const vad = creerVad();
    vad.setPlaybackMode(true);
    // 4 trames au-dessus (200 ms) puis silence : aucun événement.
    for (let t = 0; t < 200; t += 50) {
      expect(vad.feed(0.05, t).event).not.toBe("barge_in");
    }
    for (let t = 200; t <= 1000; t += 50) {
      expect(vad.feed(0.001, t).event).not.toBe("barge_in");
    }
  });

  it("le barge-in n'est jamais actif hors mode playback", () => {
    const vad = creerVad();
    for (let t = 0; t <= 1000; t += 50) {
      expect(vad.feed(0.05, t).event).not.toBe("barge_in");
    }
  });
});
