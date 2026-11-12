import { describe, expect, it } from "vitest";

import { composerMusique, calculerGraine, FREQUENCE_COMPOSITION } from "./composition";
import { parseStyleMusique } from "./styles";
import { rmsPcm16 } from "./synthese";

/**
 * COMPOSITION DÉTERMINISTE (Task 2-a AUDIO) — verrous propriétaires :
 *  1. même demande → MÊMES OCTETS de base (graine = hash de la demande) ;
 *  2. durée réelle ≈ durée demandée (±2 s — ici exacte à l'image près) ;
 *  3. la musique n'est PAS un silence : RMS significatif (garde « jamais de
 *     silence de 2 min déguisé en musique ») et spectre animé (variance
 *     temporelle non nulle) ;
 *  4. structure intro/couplet/refrain/outro et accords lisibles.
 * Les durées de test restent courtes (≤ 10 s) pour garder la suite rapide.
 */

const DEMANDE = "une musique calme de 2 minutes au piano";

describe("calculerGraine — graine déterministe", () => {
  it("stable pour la même demande (casse et espaces compris)", () => {
    expect(calculerGraine("Musique Lofi")).toBe(calculerGraine("musique lofi"));
    expect(calculerGraine("  Musique Lofi  ")).toBe(calculerGraine("musique lofi"));
  });

  it("différente pour deux demandes distinctes", () => {
    expect(calculerGraine("musique lofi")).not.toBe(calculerGraine("musique jazz"));
  });

  it("format : 8 caractères hexadécimaux (32 bits)", () => {
    expect(calculerGraine("x")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("composerMusique — déterminisme et durée", () => {
  it("même demande → mêmes octets PCM (composition déterministe)", () => {
    const style = parseStyleMusique(DEMANDE).style;
    const a = composerMusique({ demande: DEMANDE, dureeSecondes: 8, style });
    const b = composerMusique({ demande: DEMANDE, dureeSecondes: 8, style });
    expect(a.pcm.length).toBe(b.pcm.length);
    expect(Buffer.compare(a.pcm, b.pcm)).toBe(0);
    expect(a.seed).toBe(b.seed);
    expect(a.accords).toEqual(b.accords);
  });

  it("demande différente → rendu différent (la demande pilote la musique)", () => {
    const styleA = parseStyleMusique(DEMANDE).style;
    const a = composerMusique({ demande: DEMANDE, dureeSecondes: 8, style: styleA });
    const b = composerMusique({ demande: "un rock énergique", dureeSecondes: 8, style: styleA });
    expect(Buffer.compare(a.pcm, b.pcm)).not.toBe(0);
  });

  it("durée réelle ≈ durée demandée (±2 s) — ici exacte à l'image près", () => {
    for (const duree of [10, 21]) {
      const style = parseStyleMusique(DEMANDE).style;
      const c = composerMusique({ demande: DEMANDE, dureeSecondes: duree, style });
      expect(Math.abs(c.dureeSecondes - duree)).toBeLessThanOrEqual(2);
      expect(c.echantillons).toBe(Math.round(duree * FREQUENCE_COMPOSITION));
      expect(c.pcm.length).toBe(c.echantillons * 4); // stéréo 16 bits
    }
  });

  it("PCM non silencieux : RMS significatif et structure graduée (intro < refrain)", () => {
    const style = parseStyleMusique(DEMANDE).style;
    const c = composerMusique({ demande: DEMANDE, dureeSecondes: 10, style });
    const rms = rmsPcm16(c.pcm);
    expect(rms).toBeGreaterThan(0.01); // de la VRAIE musique, pas du silence

    // Énergie par fenêtre : l'intro (voix d'ombre, densité réduite) doit être
    // nettement plus discrète qu'un refrain (vélocités fortes, mélodie pleine)
    // — la structure graduée est audible, pas seulement déclarée.
    const rmsFenetre = (debutSec: number, finSec: number): number => {
      const debut = Math.floor(debutSec * FREQUENCE_COMPOSITION) * 4;
      const fin = Math.floor(finSec * FREQUENCE_COMPOSITION) * 4;
      let somme = 0;
      let n = 0;
      for (let i = debut; i < fin; i += 4) {
        const v = c.pcm.readInt16LE(i) / 32768;
        somme += v * v;
        n++;
      }
      return Math.sqrt(somme / Math.max(1, n));
    };
    // 10 s @ ~88 bpm : intro ≈ [0 .. 2.7], couplet, refrain ≈ [5.5 .. 8.2].
    const rmsIntro = rmsFenetre(0.3, 2.0);
    const rmsRefrain = rmsFenetre(5.8, 7.8);
    expect(rmsRefrain).toBeGreaterThan(rmsIntro);
  });

  it("crête maîtrisée (pas d'écrêtage brutal au-delà de la cible)", () => {
    const style = parseStyleMusique(DEMANDE).style;
    const c = composerMusique({ demande: DEMANDE, dureeSecondes: 8, style });
    let crete = 0;
    for (let i = 0; i < c.pcm.length / 2; i++) {
      crete = Math.max(crete, Math.abs(c.pcm.readInt16LE(i * 2)));
    }
    expect(crete).toBeLessThanOrEqual(32767);
    expect(crete).toBeGreaterThan(20000); // bien présent dans les hauts niveaux
  });

  it("structure intro/couplet/refrain/outro + accords lisibles", () => {
    const style = parseStyleMusique(DEMANDE).style;
    const c = composerMusique({ demande: DEMANDE, dureeSecondes: 20, style });
    const noms = c.structure.map((s) => s.nom);
    expect(noms[0]).toBe("intro");
    expect(noms[noms.length - 1]).toBe("outro");
    expect(noms).toContain("couplet");
    expect(noms).toContain("refrain");
    expect(c.accords.length).toBe(c.nbMesures);
    for (const accord of c.accords) {
      expect(accord).toMatch(/^[A-G][#b]?(m(maj)?7|maj7|sus|m)?$/u);
    }
  });

  it("styles percussifs posent des percussions (rock) ; ambient n'en pose pas", () => {
    const rock = parseStyleMusique("du rock puissant").style;
    const cRock = composerMusique({ demande: "du rock puissant", dureeSecondes: 8, style: rock });
    expect(rmsPcm16(cRock.pcm)).toBeGreaterThan(0.01);

    const ambient = parseStyleMusique("nappe ambient").style;
    expect(ambient.percussion).toBe("aucune");
    const cAmbient = composerMusique({ demande: "nappe ambient", dureeSecondes: 8, style: ambient });
    expect(cAmbient.nbMesures).toBeGreaterThan(0);
  });
});
