/**
 * Tests — VAGUE POST-AUDIT v2.1 : signature sémantique + canaux de domaine.
 *
 * Ce que l'audit a dénoncé et ce qui est vérifié ici :
 *  - des mots de même famille morphologique ont des POSITIONS plus proches
 *    avec la signature sémantique qu'avec la signature de hachage (gain
 *    mesuré, pas supposé) ;
 *  - l'identité du mot est préservée (fréquence/phase inchangées, signature
 *    déterministe) ;
 *  - les 18 domaines Gen3 réels reçoivent des canaux (bande, sous-canal)
 *    TOUS DISTINCTS — zéro collision, y compris en présence de collisions
 *    de hachage brut.
 */

import { describe, expect, it } from "vitest";

import { DOMAINES_GEN3 } from "@/lib/neural/training/domaines";
import {
  NB_BANDES,
  SOUS_CANAUX_PAR_BANDE,
  attribuerCanauxSansCollision,
  canalDomaine,
  signatureMot,
  signatureSemantique,
} from "../encodeur";

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe("signatureSemantique — proximité morphologique mesurée", () => {
  const DIM = 64;

  it("des variantes morphologiques se rapprochent davantage qu'avec le hachage pur", () => {
    const familles = [
      ["voiture", "voitures"],
      ["montagne", "montagnes"],
      ["rapide", "rapidement"],
      ["fenetre", "fenetres"],
    ];
    let sommeHash = 0;
    let sommeSem = 0;
    for (const [mot, variante] of familles) {
      const dHash = distance(signatureMot(mot, DIM), signatureMot(variante, DIM));
      const dSem = distance(signatureSemantique(mot, DIM), signatureSemantique(variante, DIM));
      sommeHash += dHash;
      sommeSem += dSem;
      // Certaines paires sont proches « par chance » du hachage brut —
      // l'assertion individuelle s'applique aux familles sans ce hasard ;
      // le gain AGGRÉGÉ est vérifié en fin de test.
      if (dHash > DIM / 4) {
        expect(
          dSem,
          `proximité attendue pour ${mot}/${variante} (sem ${dSem.toFixed(1)} < hash ${dHash.toFixed(1)})`,
        ).toBeLessThan(dHash);
      }
    }
    expect(sommeSem, `gain agrégé attendu (${sommeSem.toFixed(1)} < ${sommeHash.toFixed(1)})`).toBeLessThan(sommeHash);
  });

  it("des mots sans rapport ne se rapprochent PAS artificiellement (garde)", () => {
    // Le centroïde de trigrammes de mots sans trigrammes communs ne doit pas
    // créer de gravité artificielle : la distance ne peut pas s'effondrer à 0.
    const a = signatureSemantique("banane", DIM);
    const b = signatureSemantique("avion", DIM);
    expect(distance(a, b)).toBeGreaterThan(0);
  });

  it("préserve l'identité : fréquence et phase identiques à la signature de hachage", () => {
    const hash = signatureMot("château", DIM);
    const sem = signatureSemantique("château", DIM);
    expect(sem.frequence).toBe(hash.frequence);
    expect(sem.phase).toBe(hash.phase);
  });

  it("est déterministe (mêmes entrées → même position)", () => {
    expect(signatureSemantique("voiture", DIM)).toEqual(signatureSemantique("voiture", DIM));
    expect(signatureSemantique("voiture", DIM).x).toBeLessThanOrEqual(DIM - 1);
    expect(signatureSemantique("voiture", DIM).y).toBeLessThanOrEqual(DIM - 1);
  });
});

describe("canaux de domaine — anti-collision", () => {
  it("les 18 domaines Gen3 réels reçoivent des canaux tous distincts", () => {
    const domaines = DOMAINES_GEN3.map((d) => d.id);
    expect(domaines.length).toBe(18);
    const attribution = attribuerCanauxSansCollision(domaines);
    const cles = Object.values(attribution).map((c) => `${c.bande}:${c.sousCanal}`);
    expect(new Set(cles).size).toBe(18);
    for (const canal of Object.values(attribution)) {
      expect(canal.bande).toBeGreaterThanOrEqual(0);
      expect(canal.bande).toBeLessThan(NB_BANDES);
      expect(canal.sousCanal).toBeGreaterThanOrEqual(0);
      expect(canal.sousCanal).toBeLessThan(SOUS_CANAUX_PAR_BANDE);
    }
  });

  it("est déterministe et stable à l'ordre près", () => {
    const domaines = ["vente", "sante_medical", "test", "video"];
    const premier = attribuerCanauxSansCollision(domaines);
    const inverse = attribuerCanauxSansCollision([...domaines].reverse());
    expect(premier).toEqual(inverse);
    // 32 domaines exactement : le dernier trouve encore un canal libre.
    const plein = attribuerCanauxSansCollision(
      Array.from({ length: 32 }, (_, i) => `domaine-${i}`),
    );
    const cles = Object.values(plein).map((c) => `${c.bande}:${c.sousCanal}`);
    expect(new Set(cles).size).toBe(32);
  });

  it("canalDomaine brut reste déterministe (base de l'attribution)", () => {
    expect(canalDomaine("vente")).toEqual(canalDomaine("vente"));
  });
});
