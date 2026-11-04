import { describe, expect, it } from "vitest";

import {
  BORNES_GENERATION,
  empreinteModulaire,
  genererDepuisIntention,
  tamponVersBase64,
} from "../generateur-multimodal";
import { CALIBRATIONS_ENERGIE, comparerOndesVsDense, estimerEnergie, mesurerLatence } from "../performance";
import { texteVersTenseur } from "../manifold";

/**
 * GÉNÉRATEUR MULTIMODAL + HARNAIS DE PERFORMANCE (Phase 4) — la logique
 * pure derrière /api/ondes/generer : flux d'ondes compact, vérification
 * serveur (miroir CPU honnête), latence mesurée, watts estimés.
 */

describe("tamponVersBase64 (flux d'ondes compact)", () => {
  it("encode les cas connus correctement", () => {
    expect(tamponVersBase64(new Uint8Array([0, 0, 0]))).toBe("AAAA");
    expect(tamponVersBase64(new Uint8Array([255]))).toBe("/w==");
    expect(tamponVersBase64(new Uint8Array([255, 255]))).toBe("//8=");
    expect(tamponVersBase64(new Uint8Array([104, 101, 121]))).toBe("aGV5");
  });

  it("gère les longueurs non multiples de 3 (padding exact)", () => {
    const n = 10;
    const b64 = tamponVersBase64(new Uint8Array(n));
    expect(b64.length).toBe(Math.ceil(n / 3) * 4);
  });
});

describe("empreinteModulaire (cohérence serveur/client)", () => {
  it("est déterministe et sensible au contenu", () => {
    const a = empreinteModulaire([1, 2, 3, 4]);
    expect(empreinteModulaire([1, 2, 3, 4])).toBe(a);
    expect(empreinteModulaire([1, 2, 3, 5])).not.toBe(a);
    expect(a).toBeLessThan(2 ** 32);
  });
});

describe("genererDepuisIntention — image", () => {
  const offre = genererDepuisIntention({
    intention: "une cascade tropicale au ralenti",
    modalite: "image",
    largeur: 64,
    hauteur: 64,
    nbNoeuds: 64,
  });

  it("renvoie le flux d'ondes quantifié (4 octets par état)", () => {
    expect(offre.modalite).toBe("image");
    expect(offre.nbNoeuds).toBe(64);
    expect(offre.tenseur.octets).toBe(64 * 4);
    // 128 octets → base64 de 176 caractères (arrondi multiple de 4).
    expect(offre.tenseur.amplitudesBase64.length).toBe(Math.ceil(128 / 3) * 4);
    expect(offre.tenseur.phasesBase64.length).toBe(offre.tenseur.amplitudesBase64.length);
  });

  it("livre les instructions de rendu local du shader image", () => {
    expect(offre.renduLocal.shader).toBe("SHADER_DECODE_IMAGE_WAVELET");
    expect(offre.renduLocal.entryPoint).toBe("decoderImage");
    expect(offre.renduLocal.workgroupSize).toEqual([8, 8]);
    expect(offre.renduLocal.presentation).toBe("canvas-gpu");
    expect(offre.renduLocal.uniformes.largeur).toBe(64);
    expect(offre.renduLocal.uniformes.fondamentale).toBe(offre.fondamentale);
  });

  it("vérifie par miroir CPU honnête (moteur: cpu) avec empreinte stable", () => {
    expect(offre.verifServeur.moteur).toBe("cpu");
    expect(offre.verifServeur.latenceMs).toBeGreaterThan(0);
    expect(offre.verifServeur.detail.pixels).toBe(64 * 64);
    const bis = genererDepuisIntention({
      intention: "une cascade tropicale au ralenti",
      modalite: "image",
      largeur: 64,
      hauteur: 64,
      nbNoeuds: 64,
    });
    // Déterminisme : même intention → même empreinte de rendu.
    expect(bis.verifServeur.empreinte).toBe(offre.verifServeur.empreinte);
  });

  it("les métriques portent l'honnêteté : sparse, latence mesurée, watts estimés", () => {
    expect(offre.metriques.noeudsActifs).toBeGreaterThan(0);
    expect(offre.metriques.noeudsActifs).toBeLessThanOrEqual(offre.metriques.noeudsTotaux);
    expect(offre.metriques.tauxActivation).toBeGreaterThan(0);
    expect(offre.metriques.latenceMs).toBeGreaterThan(0);
    expect(offre.metriques.wattsEstimes).toBeGreaterThan(0);
    expect(offre.metriques.methodeEnergie).toBe("estimation-calibree");
    expect(offre.metriques.ratioVsDense).toBeGreaterThan(1); // les ondes gagnent
    expect(offre.metriques.budgetVram.tient).toBe(true);
    expect(offre.metriques.octetsEconomisesParImage).toBe(64 * 64 * 4 * 2);
  });
});

describe("genererDepuisIntention — audio", () => {
  it("synthétise et vérifie (RMS, crête bornés) sans transporter l'audio", () => {
    const offre = genererDepuisIntention({
      intention: "une voix grave et posée",
      modalite: "audio",
      nbNoeuds: 64,
      nbEchantillons: 4096,
    });
    expect(offre.modalite).toBe("audio");
    expect(offre.renduLocal.shader).toBe("SHADER_DECODE_AUDIO_PHASE");
    expect(offre.renduLocal.presentation).toBe("audio-worklet");
    expect(offre.verifServeur.detail.echantillons).toBe(4096);
    expect(offre.verifServeur.detail.rms).toBeGreaterThan(0);
    expect(offre.verifServeur.detail.rms).toBeLessThanOrEqual(1);
    expect(offre.verifServeur.detail.crete).toBeLessThanOrEqual(1);
    // La fondamentale module la hauteur : f0 audible à l'index 0 positif.
    expect(offre.verifServeur.detail.frequenceOscillateur0).toBeGreaterThan(0);
    // La réponse ne transporte PAS le PCM (seulement ~4 o/état de tenseur).
    expect(offre.tenseur.octets).toBe(64 * 4);
  });
});

describe("genererDepuisIntention — vidéo", () => {
  it("prépare la dérive de phase (trame T → T+1) avec instructions locales", () => {
    const offre = genererDepuisIntention({
      intention: "des vagues océaniques",
      modalite: "video",
      largeur: 32,
      hauteur: 32,
      nbNoeuds: 64,
    });
    expect(offre.modalite).toBe("video");
    expect(offre.renduLocal.shader).toBe("SHADER_DECODE_VIDEO_DERIVE");
    expect(offre.renduLocal.entryPoint).toBe("deriverTrame");
    expect(offre.renduLocal.uniformes.coteGrille).toBe(8); // √64
    expect(offre.verifServeur.detail.deriveMaximale).toBeGreaterThan(0);
    expect(offre.verifServeur.detail.deriveMoyenne).toBeGreaterThan(0);
  });
});

describe("genererDepuisIntention — validation des entrées", () => {
  it("refuse une intention vide ou trop longue", () => {
    expect(() => genererDepuisIntention({ intention: "   ", modalite: "image" })).toThrow(/vide/);
    expect(() =>
      genererDepuisIntention({
        intention: "x".repeat(BORNES_GENERATION.intentionMax + 1),
        modalite: "image",
      }),
    ).toThrow(/trop longue/);
  });

  it("refuse un nombre de nœuds hors bornes", () => {
    expect(() =>
      genererDepuisIntention({ intention: "test", modalite: "image", nbNoeuds: 8 }),
    ).toThrow(/invalide/);
    expect(() =>
      genererDepuisIntention({ intention: "test", modalite: "image", nbNoeuds: 2048 }),
    ).toThrow(/invalide/);
  });

  it("borne les dimensions à la limite haute", () => {
    const offre = genererDepuisIntention({
      intention: "mur géant",
      modalite: "image",
      largeur: 9999,
      hauteur: 64,
      nbNoeuds: 32,
    });
    expect(offre.renduLocal.uniformes.largeur).toBe(BORNES_GENERATION.dimensionMax);
  });
});

describe("Harnais de performance — latence mesurée", () => {
  it("mesure une latence réelle finie (méthode: mesuree)", () => {
    const m = mesurerLatence(() => {
      let s = 0;
      for (let i = 0; i < 1000; i++) s += Math.sin(i);
      return s;
    }, 3);
    expect(m.methode).toBe("mesuree");
    expect(m.latenceMs).toBeGreaterThan(0);
    expect(m.minMs).toBeLessThanOrEqual(m.latenceMs);
    expect(m.latenceMs).toBeLessThanOrEqual(m.maxMs);
    expect(m.echantillons).toBe(3);
  });

  it("valide ses entrées", () => {
    expect(() => mesurerLatence(() => {}, 0)).toThrow(/invalide/);
  });
});

describe("Modèle énergétique — estimation calibrée, jamais un faux « mesuré »", () => {
  it("les watts sont proportionnels à l'occupation et bornés par la charge", () => {
    const petit = estimerEnergie(1e6, "webgpu", 10);
    const gros = estimerEnergie(1e9, "webgpu", 10);
    expect(petit.wattsMoyens).toBeGreaterThan(0);
    expect(gros.wattsMoyens).toBeGreaterThan(petit.wattsMoyens);
    expect(gros.wattsMoyens).toBeLessThanOrEqual(CALIBRATIONS_ENERGIE.webgpu.wattsCharge);
    expect(gros.joules).toBeCloseTo(gros.wattsMoyens * 0.01, 9);
    expect(gros.methode).toBe("estimation-calibree");
  });

  it("l'occupation ne descend jamais sous 30 % (hypothèse conservatrice)", () => {
    const e = estimerEnergie(1, "cpu", 1000);
    expect(e.wattsMoyens).toBeCloseTo(CALIBRATIONS_ENERGIE.cpu.wattsCharge * 0.3, 9);
  });

  it("refuse des opérations non finies", () => {
    expect(() => estimerEnergie(NaN, "cpu")).toThrow(/invalide/);
  });
});

describe("Comparaison ondes ↔ pipeline dense", () => {
  it("un tenseur textuel creux bat l'ordre de grandeur dense de référence", () => {
    const t = texteVersTenseur("un prompt multimodal typique", 256);
    const c = comparerOndesVsDense(t, 256 * 256, "image");
    expect(c.noeudsActifs).toBeLessThan(t.nbNoeuds);
    expect(c.opsOndes).toBe(c.noeudsActifs * 256 * 256);
    expect(c.opsDenseReference).toBe(1e9);
    expect(c.ratio).toBeGreaterThan(1);
    expect(c.methode).toBe("ordre-de-grandeur-reference");
  });
});
