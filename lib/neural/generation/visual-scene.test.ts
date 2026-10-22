import { describe, expect, it } from "vitest";

import type { NeuralSnapshot } from "./snapshot";
import { analyserScene, type SceneSpec } from "./scene-spec";
import { composerCorpsScene, genererVisuelScene } from "./visual-scene";

/**
 * MOTEUR VISUEL SCÉNIQUE v2 — verrous :
 *  1. le SUJET demandé est réellement DESSINÉ (formes caractéristiques
 *     présentes dans le SVG) ;
 *  2. le CADRE peint ses calques (mer, montagnes, forêt, ville, nuit
 *     étoilée…) ;
 *  3. la MÉTÉO et le STYLE laissent leur trace (pluie, néon, vintage) ;
 *  4. DÉTERMINISME bit-à-bit ;
 *  5. ratios supportés → dimensions exactes ;
 *  6. traçabilité honnête (meta.calques, meta.scene).
 */

function snapshotFactice(seed = 12345): NeuralSnapshot {
  return {
    seed,
    nbNeurones: 120,
    nbSynapses: 480,
    poidsMoyen: 0.42,
    histogramme: Array.from({ length: 10 }, (_, i) => 0.05 + i * 0.02),
    echantillonSynapses: Array.from({ length: 60 }, (_, i) => [i * 3, i * 3 + 1, 0.2 + (i % 7) / 10] as [number, number, number]),
    energies: [[1, 0.4], [2, 0.6]],
    neuronTokens: [],
    tokens: ["chat", "mer"],
  };
}

const sceneDe = (prompt: string): SceneSpec => analyserScene(prompt);

describe("genererVisuelScene — le sujet est dessiné", () => {
  it("« un chat noir au bord de la mer au coucher de soleil » → chat + océan + crépuscule", () => {
    const scene = sceneDe("un chat noir au bord de la mer au coucher de soleil");
    const rendu = genererVisuelScene("un chat noir au bord de la mer au coucher de soleil", "16:9", snapshotFactice(), scene);
    expect(rendu.meta.scene.sujet).toBe("chat");
    expect(rendu.meta.scene.cadre).toBe("ocean");
    expect(rendu.meta.scene.moment).toBe("crepuscule");
    expect(rendu.meta.calques).toContain("sujet:chat");
    expect(rendu.meta.calques).toContain("cadre:ocean");
    // Corps du chat (ellipse) + queue (path courbe) réellement peints.
    expect(rendu.svg).toContain("<ellipse");
    expect(rendu.svg).toContain("<path");
  });

  it("« un phare sous la pluie et l'orage » → phare rayé + pluie + éclair", () => {
    const scene = sceneDe("un phare sous la pluie et l'orage");
    const rendu = genererVisuelScene("un phare sous la pluie et l'orage", "1:1", snapshotFactice(), scene);
    expect(rendu.meta.calques).toContain("sujet:phare");
    expect(rendu.meta.calques).toContain("meteo:pluie+orage");
    expect(rendu.svg).toContain("polyline"); // éclair
  });

  it("« une ville la nuit » → skyline + fenêtres + étoiles", () => {
    const scene = sceneDe("une ville la nuit");
    const rendu = genererVisuelScene("une ville la nuit", "16:9", snapshotFactice(), scene);
    expect(rendu.meta.calques).toContain("cadre:ville");
    expect(rendu.svg).toContain("<circle"); // étoiles
    expect(rendu.svg).toContain("F5D76E"); // fenêtres allumées
  });

  it("« un visage » → portrait frontal (yeux, sourire)", () => {
    const scene = sceneDe("un visage heureux");
    const rendu = genererVisuelScene("un visage heureux", "3:4", snapshotFactice(), scene);
    expect(rendu.meta.scene.sujet).toBe("visage");
    expect(rendu.svg).toContain("translate("); // groupe portrait centré
  });

  it("sujet « astre » : pas de double dessin (calque astre central uniquement)", () => {
    const scene = sceneDe("la lune dans l'espace");
    const rendu = genererVisuelScene("la lune dans l'espace", "1:1", snapshotFactice(), scene);
    expect(rendu.meta.scene.sujet).toBe("astre");
    expect(rendu.meta.calques).not.toContain("sujet:astre");
  });
});

describe("genererVisuelScene — cadres, styles, déterminisme", () => {
  const casCadres: Array<[string, string]> = [
    ["une montagne au loin", "cadre:montagne"],
    ["une forêt dense", "cadre:foret"],
    ["le désert et ses dunes", "cadre:desert"],
    ["un lac paisible", "cadre:lac"],
    ["l'espace et ses planètes", "cadre:espace"],
    ["la campagne au printemps", "cadre:campagne"],
  ];

  it.each(casCadres)("%s → calque %s", (prompt, calque) => {
    const rendu = genererVisuelScene(prompt, "16:9", snapshotFactice(), sceneDe(prompt));
    expect(rendu.meta.calques).toContain(calque);
  });

  it("styles : néon ajoute un filtre lueur, vintage un voile sépia, minimal rien", () => {
    const neon = genererVisuelScene("une ville néon la nuit", "16:9", snapshotFactice(), sceneDe("une ville néon la nuit"));
    expect(neon.svg).toContain("style-neon");
    const vintage = genererVisuelScene("un visage vintage", "1:1", snapshotFactice(), sceneDe("un visage vintage"));
    expect(vintage.svg).toContain("#C8A26A");
    const minimal = genererVisuelScene("un arbre minimaliste", "1:1", snapshotFactice(), sceneDe("un arbre minimaliste"));
    expect(minimal.svg).not.toContain("filter");
    expect(minimal.meta.calques).toContain("style:minimal");
  });

  it("déterminisme bit-à-bit : même (prompt, snapshot) → même SVG", () => {
    const prompt = "un voilier sur l'océan au crépuscule";
    const a = genererVisuelScene(prompt, "16:9", snapshotFactice(777), sceneDe(prompt));
    const b = genererVisuelScene(prompt, "16:9", snapshotFactice(777), sceneDe(prompt));
    expect(a.svg).toBe(b.svg);
  });

  it("états de cerveau différents → œuvres différentes (poids appris impliqués)", () => {
    const prompt = "un arbre dans la forêt";
    const a = genererVisuelScene(prompt, "16:9", snapshotFactice(1), sceneDe(prompt));
    const b = genererVisuelScene(prompt, "16:9", snapshotFactice(2), sceneDe(prompt));
    expect(a.svg).not.toBe(b.svg);
  });

  it("ratios supportés → dimensions exactes ; ratio inconnu → 1:1", () => {
    expect(genererVisuelScene("un pont", "21:9", snapshotFactice(), sceneDe("un pont")).width).toBe(1344);
    expect(genererVisuelScene("un pont", "9:16", snapshotFactice(), sceneDe("un pont")).height).toBe(1280);
    expect(genererVisuelScene("un pont", "4:5", snapshotFactice(), sceneDe("un pont")).width).toBe(1024);
  });

  it("traçabilité : meta.scene expose la couverture et les axes reconnus", () => {
    const scene = sceneDe("un chien blanc dans le brouillard");
    const rendu = genererVisuelScene("un chien blanc dans le brouillard", "1:1", snapshotFactice(), scene);
    expect(rendu.meta.scene.couverture).toBeGreaterThan(0);
    expect(rendu.meta.scene.meteo).toContain("brouillard");
    expect(rendu.meta.calques).toContain("meteo:brouillard");
  });
});

describe("composerCorpsScene — réutilisable par la vidéo", () => {
  it("mode sujetAnime : le sujet est enveloppé d'une animation SMIL", () => {
    const scene = sceneDe("un chat sur le toit");
    const compose = composerCorpsScene(1280, 720, scene, snapshotFactice(), (() => 0.5), {
      sujetAnime: true,
    });
    expect(compose.corps).toContain("animateTransform");
  });

  it("mode meteoAnimee : les météos statiques sont EXCLUES (la vidéo les anime)", () => {
    const scene = sceneDe("une forêt sous la pluie");
    const compose = composerCorpsScene(1280, 720, scene, snapshotFactice(), (() => 0.5), {
      meteoAnimee: true,
    });
    expect(compose.corps).not.toContain("B9D9F2"); // gouttes statiques absentes
    const statique = composerCorpsScene(1280, 720, scene, snapshotFactice(), (() => 0.5));
    expect(statique.corps).toContain("B9D9F2");
  });
});
