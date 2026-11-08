import { describe, expect, it } from "vitest";

import {
  ESPACE_ANALYSE_MULTIMODALE,
  ESPACE_GENERATION_IMAGE,
  ESPACE_VIDEO_REALISTE,
  ESPACE_VOIX_PAROLE,
  OFFSETS_DOMAINES,
  TAILLE_ESPACE_ONDES_MULTIMODAL,
  lotOndesMultimodale,
  uniteOndesMultimodale,
} from "./memoire-ondes-multimodales";

describe("memoire-ondes-multimodales", () => {
  it("dépasse 5 milliards d'échantillons adressables", () => {
    expect(TAILLE_ESPACE_ONDES_MULTIMODAL).toBeGreaterThan(5_000_000_000);
  });

  it("somme les espaces de domaine sans recouvrement", () => {
    expect(
      ESPACE_ANALYSE_MULTIMODALE +
        ESPACE_VOIX_PAROLE +
        ESPACE_VIDEO_REALISTE +
        ESPACE_GENERATION_IMAGE,
    ).toBe(TAILLE_ESPACE_ONDES_MULTIMODAL);
  });

  it("route les premiers indices vers les domaines attendus", () => {
    expect(uniteOndesMultimodale(0).domaine).toBe("analyse_multimodale");
    expect(uniteOndesMultimodale(OFFSETS_DOMAINES.voix_parole).domaine).toBe("voix_parole");
    expect(uniteOndesMultimodale(OFFSETS_DOMAINES.video_realiste).domaine).toBe("video_realiste");
    expect(uniteOndesMultimodale(OFFSETS_DOMAINES.generation_image).domaine).toBe("generation_image");
  });

  it("est déterministe (même index → même échantillon)", () => {
    const a = uniteOndesMultimodale(123_456_789);
    const b = uniteOndesMultimodale(123_456_789);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("ne contient AUCUN doublon sur un échantillon large de l'espace", () => {
    const vus = new Set<string>();
    // 5 000 premiers + 20 000 indices répartis par pas irrégulier sur tout l'espace.
    for (let i = 0; i < 5_000; i++) {
      const u = uniteOndesMultimodale(i);
      vus.add(`${u.domaine}|${u.langue}|${u.texte}`);
    }
    const pas = Math.floor(TAILLE_ESPACE_ONDES_MULTIMODAL / 20_000);
    for (let k = 0; k < 20_000; k++) {
      const u = uniteOndesMultimodale(k * pas);
      vus.add(`${u.domaine}|${u.langue}|${u.texte}`);
    }
    expect(vus.size).toBe(25_000);
  });

  it("produit des lots contigus corrects", () => {
    const lot = lotOndesMultimodale(OFFSETS_DOMAINES.generation_image, 3);
    expect(lot).toHaveLength(3);
    expect(lot.every((u) => u.domaine === "generation_image")).toBe(true);
  });

  it("refuse honnêtement un index hors bornes", () => {
    expect(() => uniteOndesMultimodale(-1)).toThrow();
    expect(() => uniteOndesMultimodale(TAILLE_ESPACE_ONDES_MULTIMODAL)).toThrow();
  });
});
