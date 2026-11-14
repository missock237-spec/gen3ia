import { describe, expect, it } from "vitest";
import { voixChanson, decoderVoixPcm, mixerChanson, FREQUENCE_CHANSON } from "./chanson";
import { synthetiserMusique } from "./synthese";

/**
 * INTÉGRATION RÉELLE (chaîne audio complète de la chanson) : TTS humain
 * (cascade professeur → espace public Edge-TTS) → décodage FFmpeg → mixage
 * avec ducking → encodage MP3. SAUTÉE proprement si le réseau/TTS est
 * indisponible (sandbox isolé) — en production elle prouve le chemin réel.
 */
const RESEAU_DISPONIBLE = process.env.CHANSON_IT_REEL === "1";

describe.runIf(RESEAU_DISPONIBLE)("chanson — chaîne audio réelle (TTS → FFmpeg → mix → MP3)", () => {
  it("une voix réelle est produite, décodée, mixée et encodée", async () => {
    const voix = await voixChanson("La mer chante ce soir, doucement.");
    expect(voix.buffer.length).toBeGreaterThan(2000);
    expect(voix.moteur.length).toBeGreaterThan(0);

    const pcm = await decoderVoixPcm(voix.buffer, voix.mime);
    expect(pcm.length).toBeGreaterThan(FREQUENCE_CHANSON / 2); // ≥ 0,5 s réel

    const echantillons = FREQUENCE_CHANSON * 5;
    const musique = { g: new Float32Array(echantillons).fill(0.4), d: new Float32Array(echantillons).fill(0.4) };
    const mixe = mixerChanson({ musiqueGauche: musique.g, musiqueDroite: musique.d, segments: [{ debutSec: 1, pcm }], frequence: FREQUENCE_CHANSON });

    const entrelace = new Float32Array(echantillons * 2);
    for (let i = 0; i < echantillons; i += 1) {
      entrelace[2 * i] = mixe.gauche[i];
      entrelace[2 * i + 1] = mixe.droite[i];
    }
    const pcm16 = Buffer.alloc(entrelace.length * 2);
    for (let i = 0; i < entrelace.length; i += 1) {
      pcm16.writeInt16LE(Math.round(Math.max(-1, Math.min(1, entrelace[i])) * 32767), i * 2);
    }
    const rendu = await synthetiserMusique({ pcm: pcm16, frequence: FREQUENCE_CHANSON, canaux: 2, titre: "Test intégration" });
    expect(rendu.buffer.length).toBeGreaterThan(50_000);
    expect(["audio/mpeg", "audio/wav"]).toContain(rendu.mime);
  }, 120_000);
});
