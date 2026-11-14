import { describe, expect, it } from "vitest";
import { mixerChanson, planChant, demandeClipMusical, FREQUENCE_CHANSON } from "./chanson";
import type { ParolesChanson } from "./paroles";

/** Musique stéréo constante 0.5 (détection exacte du ducking). */
function musiqueTest(echantillons: number) {
  return { g: new Float32Array(echantillons).fill(0.5), d: new Float32Array(echantillons).fill(0.5) };
}

describe("mixerChanson — voix posée + ducking de la musique", () => {
  it("SANS voix : la musique passe inchangée", () => {
    const m = musiqueTest(4410);
    const mixe = mixerChanson({ musiqueGauche: m.g, musiqueDroite: m.d, segments: [], frequence: FREQUENCE_CHANSON });
    expect(mixe.gauche[0]).toBeCloseTo(0.5, 5);
    expect(mixe.droite[1000]).toBeCloseTo(0.5, 5);
  });

  it("la voix s'ajoute au début demandé et la musique est abaissée sous elle", () => {
    const echantillons = FREQUENCE_CHANSON; // 1 s
    const m = musiqueTest(echantillons);
    const voix = new Float32Array(Math.round(FREQUENCE_CHANSON * 0.5)).fill(0.4); // 0,5 s à 0,5 s
    const mixe = mixerChanson({
      musiqueGauche: m.g,
      musiqueDroite: m.d,
      segments: [{ debutSec: 0.5, pcm: voix }],
      frequence: FREQUENCE_CHANSON,
    });
    // Hors fenêtre (avant la rampe qui commence à 0,2 s) : musique pleine.
    expect(mixe.gauche[Math.round(FREQUENCE_CHANSON * 0.05)]).toBeCloseTo(0.5, 4);
    // Sous la voix (après les ramps) : musique abaissée + voix additionnée.
    const i = Math.round(FREQUENCE_CHANSON * 0.7);
    expect(mixe.gauche[i]).toBeGreaterThan(0.5); // voix ajoutée
    expect(mixe.gauche[i]).toBeLessThan(0.5 + 0.4 + 0.01); // musique abaissée, pas pleine
  });

  it("normalisation de crête : aucun échantillon ne dépasse 0.95", () => {
    const m = musiqueTest(22050);
    const voix = new Float32Array(11025).fill(0.95);
    const mixe = mixerChanson({ musiqueGauche: m.g, musiqueDroite: m.d, segments: [{ debutSec: 0, pcm: voix }], frequence: FREQUENCE_CHANSON });
    let crête = 0;
    for (const v of mixe.gauche) crête = Math.max(crête, Math.abs(v));
    expect(crête).toBeLessThanOrEqual(0.95 + 1e-6);
  });
});

describe("planChant — les paroles suivent la STRUCTURE réelle", () => {
  const paroles: ParolesChanson = {
    titre: "Test",
    intro: ["Salut l'intro"],
    couplets: [["couplet un ligne"], ["couplet deux ligne"], ["couplet trois ligne"]],
    refrain: ["Refrain test", "Refrain test"],
    outro: ["Fin"],
    source: "repli-deterministe",
  };

  it("chaque section reçoit son bloc au début EXACT de la section", () => {
    const blocs = planChant({
      paroles,
      structure: [
        { nom: "intro", debutSec: 0, dureeSec: 8 },
        { nom: "couplet", debutSec: 8, dureeSec: 20 },
        { nom: "refrain", debutSec: 28, dureeSec: 16 },
        { nom: "couplet", debutSec: 44, dureeSec: 20 },
        { nom: "outro", debutSec: 64, dureeSec: 8 },
      ],
    });
    expect(blocs.map((b) => b.nom)).toEqual(["intro", "couplet", "refrain", "couplet", "outro"]);
    expect(blocs[1].debutSec).toBe(8);
    expect(blocs[1].texte).toContain("couplet un");
    expect(blocs[3].texte).toContain("couplet deux"); // cycle des couplets
    expect(blocs[4].debutSec).toBe(64);
  });

  it("structure sans refrain → le refrain est posé en sécurité (jamais perdu)", () => {
    const blocs = planChant({ paroles, structure: [{ nom: "intro", debutSec: 0, dureeSec: 6 }, { nom: "outro", debutSec: 6, dureeSec: 6 }] });
    expect(blocs.some((b) => b.nom === "refrain")).toBe(true);
  });
});

describe("demandeClipMusical — vidéo SEULEMENT si demandée (exigence 2026-11-14)", () => {
  it("les demandes de clip/vidéo musicale sont détectées", () => {
    expect(demandeClipMusical("crée une chanson avec un clip musical")).toBe(true);
    expect(demandeClipMusical("fais une musique en vidéo")).toBe(true);
    expect(demandeClipMusical("une chanson avec une vidéo de la mer")).toBe(true);
    expect(demandeClipMusical("vidéo musicale sur l'été")).toBe(true);
  });

  it("les demandes AUDIO simples restent audio (défaut)", () => {
    expect(demandeClipMusical("crée une chanson sur la mer")).toBe(false);
    expect(demandeClipMusical("une musique calme de 90 secondes au piano")).toBe(false);
    expect(demandeClipMusical("fais une chanson « Étoiles » pop joyeuse")).toBe(false);
  });
});
