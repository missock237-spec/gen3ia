/**
 * GARDE 45ᵉ (it.77, Job 478451) — LA RÉFUTATION MESURÉE EST PUBLIÉE TELLE
 * QUELLE ET AUCUNE RÉGRESSION N'ATTEINT LES UTILISATEURS.
 *
 * Contexte (candidat №1 déclaré it.76 §8) : « élargir la matière
 * d'alignement (indices 5000+, textes inédits) — levier suivant du plancher
 * après le plateau époques 3-4 ». La campagne it.77 (100 % locale, seed 42,
 * sondes IDENTIQUES it.76 pour une comparabilité exacte) a testé DEUX
 * configurations de la matière élargie, publiées dans l'artefact committé :
 *   · 500 inédits/domaine (5000..5499) : plancher 1,259709 → 1,256239,
 *     variance 0,090871 → 0,091345 ;
 *   · 1000 inédits/domaine (5000..5999, configuration committée) :
 *     plancher 1,259709 → 1,251454, variance 0,090871 → 0,091758.
 * CONCLUSION MESURÉE (réfutation, jamais maquillée) : plus de matière
 * DÉGRADE le plancher de façon monotone et N'AMÉLIORE PAS la variance —
 * la saturation des caps est MATIÈRE-INDÉPENDANTE à 4 époques (progression
 * ép.3→4 = +0 dans les deux configurations). RÈGLE DE LIVRAISON encodée
 * dans le script de campagne : le snapshot it.77 n'est PAS livré — le
 * snapshot it.76 RESTE en production (anti-retour : le plancher publié
 * reste au-dessus du socle it.73 1,242484, le gain it.76 est conservé).
 *
 * Cette garde verrouille :
 *  1. la réfutation est PUBLIÉE telle quelle (anti-maquillage) ;
 *  2. la comparabilité (sondes 4901/4902 identiques it.76) ;
 *  3. la règle de livraison appliquée : AUCUN it77.bin dans public/, le
 *     composant /mobile sert TOUJOURS le it.76, la règle est encodée dans
 *     le script (jamais contée à la main).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const CHEMIN_ARTEFACT_77 = join(
  process.cwd(),
  "assets/neural-pretrained/cortex-telephone-it77.json",
);
const CHEMIN_ARTEFACT_76 = join(
  process.cwd(),
  "assets/neural-pretrained/cortex-telephone-it76.json",
);
const CHEMIN_PUBLIC_NEURAL = join(process.cwd(), "public/neural");

// Valeurs MESURÉES gelées (artefacts committés) — anti-maquillage.
const PLANCHER_IT73 = 1.242484; // socle (artefact it.73)
const PLANCHER_IT76 = 1.259709;
const VARIANCE_IT76 = 0.090871;

interface ArtefactIt77 {
  iteration: number;
  elargissement: {
    candidat: string;
    changementDeclare: string;
    comparaison: {
      artefactPrecedent: string;
      plancherIt76: number;
      plancherIt77: number;
      plancherAmeliore: boolean;
      plafondIt77: number;
      varianceIt76: number;
      varianceIt77: number;
      varianceReduite: boolean;
      domainesRatioEnHausse: number;
      domainesRatioEnBaisse: number;
    };
    plateau: {
      croissanceEpoque3vers4: number;
      capsParEpoque: number[];
    };
  };
  supervision: {
    alignement: {
      epoques: number;
      gabaritsParDomaine: number;
      gabaritsIneditsParDomaine: number;
      debutInedits: number;
    };
    poidsCapParEpoque: number[][];
  };
  sonde: {
    indicesSondes: number[];
    noteComparabilite: string;
    totalSondes: number;
    accordArgmaxF32U8: number;
    plancherRatio: number;
  };
  parDomaine: Array<{
    domaineId: string;
    ratioAppris: number | null;
    ratioApprisIt76: number | null;
    deltaRatioVsIt76: number | null;
  }>;
  livraison: {
    snapshotTelephone: string;
    regleDeclaree: string;
    livreSnapshot: boolean;
  };
  limitesHonnetes: string[];
}

describe("GARDE 45ᵉ — la réfutation it.77 est publiée telle quelle (anti-maquillage)", () => {
  const artefact = JSON.parse(readFileSync(CHEMIN_ARTEFACT_77, "utf8")) as ArtefactIt77;
  const precedent = JSON.parse(readFileSync(CHEMIN_ARTEFACT_76, "utf8")) as {
    prolongement: { comparaison: { plancherIt76: number; varianceIt76: number } };
  };

  it("l'artefact it.77 existe, porte le candidat déclaré et la matière élargie", () => {
    expect(artefact.iteration).toBe(77);
    expect(artefact.elargissement.candidat).toContain("№1 déclaré it.76");
    // Le changement déclaré porte bien la MATIÈRE inédite (levier it.77),
    // pas un retour des époques (inchangées).
    expect(artefact.elargissement.changementDeclare).toContain("5000");
    expect(artefact.elargissement.changementDeclare).toContain("INÉDITS");
    expect(artefact.elargissement.changementDeclare).toContain("INCHANGÉES");
    expect(artefact.supervision.alignement.epoques).toBe(4);
    expect(artefact.supervision.alignement.gabaritsParDomaine).toBe(900);
    expect(artefact.supervision.alignement.gabaritsIneditsParDomaine).toBe(1000);
    expect(artefact.limitesHonnetes.length).toBeGreaterThanOrEqual(7);
  });

  it("la réfutation est RÉELLE, cohérente avec les chiffres publiés, et le socle it.73 tient", () => {
    const c = artefact.elargissement.comparaison;
    // Valeurs gelées de la comparaison (re-derivable des artefacts committés).
    expect(c.artefactPrecedent).toContain("cortex-telephone-it76.json");
    expect(c.plancherIt76).toBe(PLANCHER_IT76);
    expect(c.plancherIt76).toBe(precedent.prolongement.comparaison.plancherIt76);
    expect(c.varianceIt76).toBe(VARIANCE_IT76);
    expect(c.varianceIt76).toBe(precedent.prolongement.comparaison.varianceIt76);
    // LE VERDICT MESURÉ : ni le plancher ni la variance ne s'améliorent —
    // verrouillé comme PUBLIÉ (un artefact qui prétendrait le contraire
    // sans mesure serait incohérent avec ses propres chiffres ci-dessous).
    expect(c.plancherAmeliore).toBe(c.plancherIt77 > c.plancherIt76);
    expect(c.varianceReduite).toBe(c.varianceIt77 < c.varianceIt76);
    // Anti-retour accumulé : le plancher ne repasse JAMAIS sous le socle
    // it.73 (le gain it.76 est conservé).
    expect(c.plancherIt77).toBeGreaterThan(PLANCHER_IT73);
    // Le plancher publié == min des ratios publiés (anti-maquillage).
    const minRatio = Math.min(...artefact.parDomaine.map((d) => d.ratioAppris ?? 0));
    expect(artefact.sonde.plancherRatio).toBe(Math.round(minRatio * 1e6) / 1e6);
    // Deltas HONNÊTES : chaque domaine porte son delta mesuré (hausse ET
    // baisse présentes), re-dérivable de ratioAppris − ratioApprisIt76.
    for (const d of artefact.parDomaine) {
      expect(d.ratioApprisIt76).not.toBeNull();
      expect(d.deltaRatioVsIt76).toBeCloseTo((d.ratioAppris ?? 0) - (d.ratioApprisIt76 ?? 0), 5);
    }
    const hausses = artefact.parDomaine.filter((d) => (d.deltaRatioVsIt76 ?? 0) > 0).length;
    const baisses = artefact.parDomaine.filter((d) => (d.deltaRatioVsIt76 ?? 0) < 0).length;
    expect(c.domainesRatioEnHausse).toBe(hausses);
    expect(c.domainesRatioEnBaisse).toBe(baisses);
    expect(hausses).toBeGreaterThan(0);
    expect(baisses).toBeGreaterThan(0);
    // La variance publiée est RE-DÉRIVABLE des ratios publiés.
    const ratios = artefact.parDomaine.map((d) => d.ratioAppris ?? 0);
    const moyenne = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const variance = ratios.reduce((a, b) => a + (b - moyenne) ** 2, 0) / ratios.length;
    expect(Math.round(variance * 1e6) / 1e6).toBe(c.varianceIt77);
  });

  it("la comparabilité est verrouillée : sondes identiques it.76, plateau publié tel quel", () => {
    expect(artefact.sonde.indicesSondes).toEqual([4901, 4902]);
    expect(artefact.sonde.noteComparabilite).toContain("IDENTIQUES it.76");
    // Le plateau matière-indépendant est publié (progression des caps par
    // époque — ép.3→4 mesurée à +0 : la saturation n'est pas une borne de
    // la matière, elle est structurelle).
    expect(artefact.supervision.poidsCapParEpoque).toHaveLength(5);
    expect(artefact.elargissement.plateau.capsParEpoque).toHaveLength(5);
    expect(artefact.elargissement.plateau.croissanceEpoque3vers4).toBe(0);
  });
});

describe("GARDE 45ᵉ — règle de livraison : aucune régression n'atteint les utilisateurs", () => {
  const artefact = JSON.parse(readFileSync(CHEMIN_ARTEFACT_77, "utf8")) as ArtefactIt77;

  it("la livraison déclarée est cohérente avec la mesure (réfutation ⇒ NON livré)", () => {
    const c = artefact.elargissement.comparaison;
    // Règle encodée dans le script : variance non dégradée ET plancher
    // au-dessus du socle it.73.
    const attendu = c.varianceIt77 <= c.varianceIt76 && c.plancherIt77 > PLANCHER_IT73;
    expect(artefact.livraison.livreSnapshot).toBe(attendu);
    expect(artefact.livraison.regleDeclaree).toContain("4901/4902");
    if (!attendu) {
      // La réfutation mesurée implique : snapshot NON livré, it.76 en prod.
      expect(artefact.livraison.snapshotTelephone).toContain("NON committé");
      expect(artefact.livraison.snapshotTelephone).toContain("it.76 RESTE en production");
    }
  });

  it("aucun snapshot it.77 ne traîne dans public/ (la règle est appliquée au dépôt)", () => {
    const fichiers = readdirSync(CHEMIN_PUBLIC_NEURAL);
    expect(fichiers).not.toContain("cortex-telephone-it77.bin");
    // Le snapshot de production reste bien committé.
    expect(fichiers).toContain("cortex-telephone-it76.bin");
  });

  it("le composant /mobile sert TOUJOURS le snapshot it.76 (zéro bascule)", () => {
    const source = readFileSync(
      join(process.cwd(), "components/neural/cortex-telephone-embarque.tsx"),
      "utf8",
    );
    expect(source).toContain('"/neural/cortex-telephone-it76.bin"');
    expect(source).not.toContain("it77");
  });

  it("la règle de livraison est ENCODÉE dans le script de campagne (jamais contée à la main)", () => {
    const script = readFileSync(join(process.cwd(), "scripts/campagne-telephone-it77.ts"), "utf8");
    expect(script).toContain("variance <= varianceIt76 && plancher > PLANCHER_SOCLE_IT73");
    expect(script).toContain("PLANCHER_SOCLE_IT73 = 1.242484");
    // La suppression du bin non livré est également encodée (pas manuelle).
    expect(script).toContain("unlinkSync(join(dirPublic");
  });
});
