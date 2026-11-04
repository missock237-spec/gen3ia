import { describe, expect, it } from "vitest";

import {
  AMPLITUDE_CRANS,
  DEUX_PI,
  ERREUR_AMPLITUDE_MAX,
  ERREUR_PHASE_MAX,
  PHASE_CRANS,
  clonerTenseur,
  creerTenseur,
  dequantifierAmplitude,
  dequantifierPhase,
  echantillonsVersTenseur,
  energieTenseur,
  fondamentaleDepuisTexte,
  fusionnerTenseurs,
  imageVersTenseur,
  jetonVersHarmoniques,
  octetsEquivalentFlottant,
  octetsTenseur,
  ordreKuramoto,
  quantifierAmplitude,
  quantifierPhase,
  superposer,
  texteVersTenseur,
  tenseurVersEchantillons,
} from "../manifold";

/**
 * MANIFOLD COMMUN D'ONDES (Phase 1) — tenseur quantifié [amplitude,
 * phase] partagé par toutes les modalités. Spécification exécutable.
 */

describe("Quantification Uint16", () => {
  it("fait l'aller-retour amplitude dans l'erreur maximale du format", () => {
    for (const a of [0, 0.1, 0.5, 0.999, 1]) {
      const cran = quantifierAmplitude(a);
      expect(cran).toBeGreaterThanOrEqual(0);
      expect(cran).toBeLessThanOrEqual(AMPLITUDE_CRANS - 1);
      expect(Math.abs(dequantifierAmplitude(cran) - a)).toBeLessThanOrEqual(
        ERREUR_AMPLITUDE_MAX,
      );
    }
  });

  it("fait l'aller-retour phase dans l'erreur maximale (≈ 9,6·10⁻⁵ rad)", () => {
    for (const th of [0, 1, 2.5, DEUX_PI - 0.001, DEUX_PI + 3, -1]) {
      const cran = quantifierPhase(th);
      expect(cran).toBeGreaterThanOrEqual(0);
      expect(cran).toBeLessThan(PHASE_CRANS);
      const retour = dequantifierPhase(cran);
      // Comparaison modulo 2π (la phase est un cercle).
      const delta = Math.abs(((retour - th + DEUX_PI) % DEUX_PI) - (th < 0 ? DEUX_PI : 0));
      expect(Math.min(delta, DEUX_PI - delta)).toBeLessThanOrEqual(ERREUR_PHASE_MAX + 1e-9);
    }
  });

  it("borne les valeurs non finies et hors domaine (pas de NaN en VRAM)", () => {
    expect(quantifierAmplitude(NaN)).toBe(0);
    expect(quantifierAmplitude(-5)).toBe(0);
    expect(quantifierAmplitude(42)).toBe(AMPLITUDE_CRANS - 1);
    expect(quantifierPhase(NaN)).toBe(0);
    expect(quantifierPhase(1e9)).toBeLessThan(PHASE_CRANS);
  });

  it("économise la moitié de la mémoire contre le couple FP32 dense", () => {
    expect(octetsTenseur(4096)).toBe(4096 * 4);
    expect(octetsEquivalentFlottant(4096)).toBe(4096 * 8);
    expect(octetsTenseur(4096)).toBe(octetsEquivalentFlottant(4096) / 2);
  });
});

describe("Superposition complexe (interférence physique)", () => {
  it("deux phases alignées → résonance constructive (amplitudes sommées)", () => {
    const r = superposer({ amplitude: 0.5, phase: 0 }, { amplitude: 0.5, phase: 0 });
    expect(r.amplitude).toBeCloseTo(1, 12);
    expect(r.phase).toBeCloseTo(0, 12);
  });

  it("deux phases opposées → interférence destructive (annulation)", () => {
    const r = superposer({ amplitude: 0.5, phase: 0 }, { amplitude: 0.5, phase: Math.PI });
    expect(r.amplitude).toBeCloseTo(0, 12);
  });

  it("fusionne deux tenseurs par physique (superposition état par état)", () => {
    const t1 = creerTenseur([1, 0.5], [0, Math.PI / 2], 0.08);
    const t2 = creerTenseur([1, 0.5], [0, Math.PI / 2], 0.12);
    const f = fusionnerTenseurs(t1, t2);
    expect(f.nbNoeuds).toBe(2);
    // États identiques en phase → amplitudes doublées (bornées à 1 après quantification).
    expect(f.amplitudes[0]).toBe(65535);
    // Fondamentale résultante = moyenne géométrique des deux tons.
    expect(f.fondamentale).toBeCloseTo(Math.sqrt(0.08 * 0.12), 12);
  });

  it("refuse la fusion de tenseurs de tailles différentes", () => {
    const a = creerTenseur([1, 0.5], [0, 1], 0.08);
    const b = creerTenseur([1], [0], 0.08);
    expect(() => fusionnerTenseurs(a, b)).toThrow(/mêmes dimensions/);
  });
});

describe("Ordre de Kuramoto et énergie", () => {
  it("champ cohérent (phases alignées) → r proche de 1", () => {
    const n = 64;
    const t = creerTenseur(
      Array.from({ length: n }, () => 1),
      Array.from({ length: n }, () => 0.1),
      0.08,
    );
    expect(ordreKuramoto(t)).toBeGreaterThan(0.999);
  });

  it("champ à phases uniformément dispersées → r faible", () => {
    const n = 64;
    const t = creerTenseur(
      Array.from({ length: n }, () => 1),
      Array.from({ length: n }, (_, i) => (i / n) * DEUX_PI),
      0.08,
    );
    expect(ordreKuramoto(t)).toBeLessThan(0.2);
  });

  it("tenseur muet → ordre nul, énergie nulle", () => {
    const t = creerTenseur([0, 0, 0, 0], [0, 0, 0, 0], 0.08);
    expect(ordreKuramoto(t)).toBe(0);
    expect(energieTenseur(t)).toBe(0);
  });
});

describe("Encodeur multi-fréquence (jetons → harmoniques)", () => {
  it("est déterministe : même jeton → mêmes harmoniques", () => {
    const a = jetonVersHarmoniques("cascade");
    const b = jetonVersHarmoniques("cascade");
    expect(a).toEqual(b);
  });

  it("les amplitudes harmoniques décroissent (série de Fourier 1/k)", () => {
    const h = jetonVersHarmoniques("orage");
    expect(h.length).toBe(4);
    for (let k = 1; k < h.length; k++) {
      expect(h[k].amplitude).toBeLessThan(h[k - 1].amplitude);
    }
    expect(h[0].rang).toBe(1);
  });

  it("la fondamentale d'un texte est la moyenne des fondamentales de ses jetons", () => {
    const { fondamentale, jetons } = fondamentaleDepuisTexte("La vague déferle");
    expect(jetons).toEqual(["la", "vague", "déferle"]);
    expect(fondamentale).toBeGreaterThan(0);
    expect(fondamentale).toBeLessThanOrEqual(0.08 * 4); // 3 octaves max
  });

  it("refuse un texte sans jeton exploitable", () => {
    expect(() => fondamentaleDepuisTexte("   !!!  ")).toThrow(/vide/);
  });
});

describe("texteVersTenseur", () => {
  it("est déterministe bit à bit", () => {
    const a = texteVersTenseur("une cascade tropicale au ralenti", 128);
    const b = texteVersTenseur("une cascade tropicale au ralenti", 128);
    expect(Array.from(a.amplitudes)).toEqual(Array.from(b.amplitudes));
    expect(Array.from(a.phases)).toEqual(Array.from(b.phases));
    expect(a.fondamentale).toBe(b.fondamentale);
  });

  it("deux textes différents produisent deux tenseurs différents", () => {
    const a = texteVersTenseur("un désert martien rouge", 128);
    const b = texteVersTenseur("une ville futuriste néon", 128);
    expect(Array.from(a.amplitudes)).not.toEqual(Array.from(b.amplitudes));
  });

  it("porte des harmoniques actives et une fondamentale dans la bande utile", () => {
    const t = texteVersTenseur("la voix gravée du vent", 256);
    let actifs = 0;
    for (let i = 0; i < t.nbNoeuds; i++) if (t.amplitudes[i] > 0) actifs++;
    expect(actifs).toBeGreaterThan(0);
    expect(t.fondamentale).toBeGreaterThan(0);
    expect(t.fondamentale).toBeLessThanOrEqual(0.08 * 4);
  });

  it("valide ses bornes (nœuds entiers 16..65536)", () => {
    expect(() => texteVersTenseur("test", 8)).toThrow(/invalide/);
    expect(() => texteVersTenseur("test", 100000)).toThrow(/invalide/);
  });

  it("clonerTenseur produit une copie défensive indépendante", () => {
    const t = texteVersTenseur("écho", 32);
    const c = clonerTenseur(t);
    expect(Array.from(c.amplitudes)).toEqual(Array.from(t.amplitudes));
    expect(c.fondamentale).toBe(t.fondamentale);
  });
});

describe("Conversions audio ↔ tenseur", () => {
  it("démodulation cohérente : cosinus pur en phase → phase ≈ 0", () => {
    // Fenêtre de 128 échantillons = 8 périodes EXACTES de la porteuse
    // (f0 = 8/128 = 0.0625) : chaque nœud voit le même battement →
    // phase locale cohérente ≈ 0 pour un cosinus en phase.
    const f0 = 8 / 128;
    const n = 8192;
    const pcm = new Float32Array(n);
    const w = DEUX_PI * f0;
    for (let s = 0; s < n; s++) pcm[s] = Math.cos(w * s);
    const t = echantillonsVersTenseur(pcm, 64, f0);
    for (let i = 0; i < t.nbNoeuds; i++) {
      const th = dequantifierPhase(t.phases[i]);
      const delta = Math.abs(th) < Math.PI ? Math.abs(th) : DEUX_PI - Math.abs(th);
      expect(delta).toBeLessThan(0.01);
    }
    // Et le RMS du cosinus (√½ ≈ 0.707) normalisé → amplitude ≈ 1 partout.
    for (let i = 0; i < t.nbNoeuds; i++) {
      expect(dequantifierAmplitude(t.amplitudes[i])).toBeGreaterThan(0.99);
    }
  });

  it("amplitudes normalisées ∈ [0, 1] avec au moins un nœud saturé", () => {
    const pcm = new Float32Array(8192);
    for (let s = 0; s < pcm.length; s++) {
      pcm[s] = Math.sin(DEUX_PI * 0.05 * s) * (0.3 + 0.7 * (s / pcm.length));
    }
    const t = echantillonsVersTenseur(pcm, 32, 0.08);
    let max = 0;
    for (let i = 0; i < t.nbNoeuds; i++) {
      const a = dequantifierAmplitude(t.amplitudes[i]);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
      max = Math.max(max, a);
    }
    expect(max).toBeCloseTo(1, 1);
  });

  it("refuse un signal trop court pour le nombre de nœuds", () => {
    expect(() => echantillonsVersTenseur(new Float32Array(10), 64)).toThrow(/trop court/);
  });

  it("tenseurVersEchantillons : synthèse bornée, non nulle, déterministe", () => {
    const t = texteVersTenseur("la mer", 64);
    const a = tenseurVersEchantillons(t, 4096);
    const b = tenseurVersEchantillons(t, 4096);
    expect(Array.from(a)).toEqual(Array.from(b));
    let max = 0;
    let nonNul = 0;
    for (let s = 0; s < a.length; s++) {
      expect(Math.abs(a[s])).toBeLessThanOrEqual(1);
      max = Math.max(max, Math.abs(a[s]));
      if (a[s] !== 0) nonNul++;
    }
    expect(max).toBeGreaterThan(0);
    expect(nonNul).toBeGreaterThan(a.length / 2);
  });
});

describe("Conversions image ↔ tenseur", () => {
  it("un bloc contrasté résonne, un bloc plat reste muet", () => {
    const W = 32;
    const H = 32;
    // Moitié gauche plate, moitié droite en damier contrasté.
    const px = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const v = x >= W / 2 && (x + y) % 2 === 0 ? 255 : x >= W / 2 ? 0 : 128;
        px[o] = v;
        px[o + 1] = v;
        px[o + 2] = v;
        px[o + 3] = 255;
      }
    }
    const t = imageVersTenseur(px, W, H, 64);
    const cote = Math.round(Math.sqrt(t.nbNoeuds));
    // Blocs de la colonne droite (damier) : contraste maximal.
    const droite = [];
    for (let by = 0; by < cote; by++) {
      for (let bx = Math.floor(cote / 2); bx < cote; bx++) {
        droite.push(t.amplitudes[by * cote + bx]);
      }
    }
    const moyenneDroite = droite.reduce((s, v) => s + v, 0) / droite.length;
    expect(moyenneDroite).toBeGreaterThan(0.5); // damier = contraste fort
    // Blocs de la colonne gauche (plat) : contraste quasi nul.
    const gauche = [];
    for (let by = 0; by < cote; by++) {
      for (let bx = 0; bx < Math.floor(cote / 2); bx++) {
        gauche.push(t.amplitudes[by * cote + bx]);
      }
    }
    const moyenneGauche = gauche.reduce((s, v) => s + v, 0) / gauche.length;
    expect(moyenneGauche).toBeLessThan(0.1);
  });

  it("l'orientation du gradient devient une phase (arête horizontale → phase verticale)", () => {
    const W = 16;
    const H = 16;
    const px = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        // Arête horizontale AU MILIEU du bloc by=1 (y = 6 ∈ [4, 8)) :
        // les ondelettes de Haar ne chevauchent pas les blocs — une arête
        // tombant EXACTEMENT sur une frontière inter-blocs reste muette
        // (physique attendue, documentée).
        const v = y < 6 ? 0 : 255;
        px[o] = v;
        px[o + 1] = v;
        px[o + 2] = v;
        px[o + 3] = 255;
      }
    }
    const t = imageVersTenseur(px, W, H, 16);
    // Blocs de la rangée by=1 (contenant l'arête) : gradient vertical →
    // |phase| proche de π/2.
    const cote = 4;
    let verifie = 0;
    for (let bx = 0; bx < cote; bx++) {
      const th = dequantifierPhase(t.phases[cote + bx]);
      const abs = Math.abs(Math.abs(th) - Math.PI / 2);
      if (abs < 0.3) verifie++;
    }
    expect(verifie).toBe(4);
    // Et la rangée by=2 (entièrement blanche, plate) reste muette ou sans
    // orientation verticale nette : le contraste y est nul.
    for (let bx = 0; bx < cote; bx++) {
      expect(dequantifierAmplitude(t.amplitudes[2 * cote + bx])).toBeLessThan(0.01);
    }
  });

  it("refuse un tampon incohérent", () => {
    expect(() => imageVersTenseur(new Uint8ClampedArray(10), 4, 4, 16)).toThrow(/incohérent/);
  });
});
