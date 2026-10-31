/**
 * GARDE 38ᵉ (it.69) — LE SUBSTRAT ÉLARGI EST RÉEL ET L'ARTEFACT NE FAÇONNE
 * RIEN.
 *
 * Demandes propriétaires : « entraîne gen3 dans tous les domaines… continue
 * jusqu'à ce qu'il atteigne le niveau requis » (it.65) + « depuis tes
 * propres serveurs locaux, 1 million de données par domaine » (raffinée).
 *
 * La campagne it.69 MESURE le levier déclaré it.68 §8.1 : le substrat
 * sparse-colonne élargi ×8 (1 048 576 → 8 388 608 colonnes) réduit
 * l'interférence inter-domaines et LÈVE le C3 de 13/19 (baseline 2^20,
 * it.66/68) à 14/19 — preuve par la mesure, sur le serveur local, avec la
 * mécanique EOD it.57/63 INCHANGÉE et l'homéostasie it.67/68 activée.
 *
 * Verrous :
 *  1. SUBSTRAT : colonnes = 8 388 608 (2^23, ×8 le défaut), facteur
 *     d'élargissement déclaré 8, homéostasie activée, graine 20261101
 *     (comparabilité it.66/68) ;
 *  2. MATIÈRE : 1 900 000 échantillons frais (19 × 100 000, bijection
 *     offset 30M — disjointe it.63/65/66/67/68), C1/C2 19/19 ;
 *  3. STABILITÉ : ratio transmissions fin/début mesuré sur les DELTAS par
 *     bloc (< 3 — leçon it.68 : un cumul croissant n'est pas une explosion),
 *     liste d'attente plafonnée, normalisations > 0 (l'homéostasie a tiré),
 *     deltas de transmissions STABLES bloc à bloc (pas de croissance) ;
 *  4. ANTI-MAQUILLAGE : C3 déclaré = comptage RÉEL des gains > 1 dans
 *     parDomaine ; ordre des 19 domaines = charte ; horloges cohérentes
 *     avec les paramètres (3 cycles/échantillon × 1 900 000) ;
 *  5. MÉMOIRE : RSS après substrat > 700 Mo (l'élargissement est RÉEL, un
 *     artefact fabriqué à 2^20 ne pourrait pas l'atteindre) et < plafond
 *     (garde-fou respecté) ; pic cohérent ;
 *  6. HONNÊTETÉ : les 4 limites honnêtes présentes (comparabilité
 *     protocole/matière décalée, portée interne de la trace, runtime
 *     production inchangé 2^20, pont vocation distinct) ; les 5 échecs C3
 *     rapportés tels quels (zéro gonflage).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { IDS_VOCATION } from "./vocation";

const CHEMIN = join(
  process.cwd(),
  "assets/neural-pretrained/substrat-ecole-it69.json",
);

interface ArtefactIt69 {
  session: string;
  parametres: {
    colonnes: number;
    facteurElargissement: number;
    fraisParDomaine: number;
    offsetBijection: number;
    cyclesParEchantillon: number;
    graine: number;
    horlogeSonde: number;
    homoeostasie: boolean;
  };
  memoire: {
    apresAllocation: { rss: number };
    plafondRssMo: number;
    picRssMo: number;
  };
  entrainement: {
    echantillonsTotaux: number;
    horlogeFinale: number;
    metabolisme: { normalisations: number; transmissions: number };
    mesuresStabilite: Array<{
      bloc: number;
      transmissions: number;
      transmissionsCumul: number;
      normalisations: number;
    }>;
  };
  bilan: {
    criteres: {
      c1_donnees_fraises_19_domaines: { valeur: number; sur: number; atteint: boolean };
      c2_renforts_positifs: { valeur: number; sur: number; atteint: boolean };
      c3_gain_trace: { valeur: number; sur: 19; atteint: boolean };
      c4_stabilite: {
        ratioTransmissionsFinDebut: number;
        seuil: number;
        listeAttentePlafonnee: boolean;
        normalisationsTotales: number;
        atteint: boolean;
      };
    };
    limitesHonnetes: string[];
  };
  parDomaine: Array<{
    id: string;
    bande: number;
    echantillonsFrais: number;
    renforts: number;
    gainTrace: number;
  }>;
}

describe("garde 38ᵉ — substrat école it.69", () => {
  const artefact = existsSync(CHEMIN)
    ? (JSON.parse(readFileSync(CHEMIN, "utf8")) as ArtefactIt69)
    : null;

  it("l'artefact existe et déclare la session it.69", () => {
    expect(artefact).not.toBeNull();
    expect(artefact!.session).toBe("campagne-substrat-ecole-it69");
  });

  it("substrat élargi ×8 RÉEL : 2^23 colonnes, homéostasie activée, graine comparable", () => {
    const p = artefact!.parametres;
    expect(p.colonnes).toBe(8_388_608); // 2^23 — ×8 le défaut 1 048 576
    expect(p.facteurElargissement).toBe(8);
    expect(p.homoeostasie).toBe(true); // it.67/68
    expect(p.graine).toBe(20261101); // comparabilité it.66/68
    expect(p.horlogeSonde).toBe(90_000_000_000); // leçon it.65 : horloge lointaine
    // La mémoire mesure la RÉALITÉ de l'élargissement : un substrat 2^20
    // (~125 Mo) ne peut pas produire ces chiffres.
    expect(artefact!.memoire.apresAllocation.rss).toBeGreaterThan(700);
    expect(artefact!.memoire.picRssMo).toBeLessThan(artefact!.memoire.plafondRssMo);
  });

  it("matière fraîche : 1 900 000 échantillons (19 × 100 000), bijection offset 30M disjointe", () => {
    const p = artefact!.parametres;
    expect(p.fraisParDomaine).toBe(100_000);
    expect(p.offsetBijection).toBe(30_000_000); // disjointe it.63/65/66/67/68 (10M+)
    expect(artefact!.entrainement.echantillonsTotaux).toBe(1_900_000);
    const c1 = artefact!.bilan.criteres.c1_donnees_fraises_19_domaines;
    const c2 = artefact!.bilan.criteres.c2_renforts_positifs;
    expect(c1.valeur).toBe(19);
    expect(c1.atteint).toBe(true);
    expect(c2.valeur).toBe(19);
    expect(c2.atteint).toBe(true);
    // Chaque domaine a RÉELLEMENT reçu ses 100 000 échantillons (comptage
    // des rapports d'entraînement, pas une déclaration).
    for (const d of artefact!.parDomaine) {
      expect(d.echantillonsFrais).toBe(100_000);
      expect(d.renforts).toBeGreaterThan(0);
    }
  });

  it("stabilité : ratio C4 sur les DELTAS < 3, deltas stables, liste plafonnée, normalisations > 0", () => {
    const c4 = artefact!.bilan.criteres.c4_stabilite;
    expect(c4.ratioTransmissionsFinDebut).toBeLessThan(3);
    expect(c4.ratioTransmissionsFinDebut).toBeGreaterThan(0);
    expect(c4.listeAttentePlafonnee).toBe(true);
    expect(c4.atteint).toBe(true);
    // Le ratio déclaré est re-dérivable des deltas par bloc (anti-maquillage).
    const blocs = artefact!.entrainement.mesuresStabilite;
    expect(blocs.length).toBeGreaterThanOrEqual(2);
    const derive = blocs[blocs.length - 1]!.transmissions / blocs[0]!.transmissions;
    expect(Math.round(derive * 1000) / 1000).toBeCloseTo(c4.ratioTransmissionsFinDebut, 2);
    // AUCUN delta de bloc n'explose (leçon it.68 : le ratio global seul peut
    // masquer une croissance locale) — chaque delta ≤ 3 × le premier.
    for (const b of blocs) {
      expect(b.transmissions).toBeLessThan(blocs[0]!.transmissions * 3);
    }
    // L'homéostasie a réellement tiré (normalisations cumulées > 0).
    expect(artefact!.entrainement.metabolisme.normalisations).toBeGreaterThan(0);
    expect(c4.normalisationsTotales).toBe(
      artefact!.entrainement.metabolisme.normalisations,
    );
  });

  it("horloges cohérentes : 3 cycles/échantillon × 1 900 000 = horloge finale", () => {
    const p = artefact!.parametres;
    expect(artefact!.entrainement.horlogeFinale).toBe(
      p.cyclesParEchantillon * artefact!.entrainement.echantillonsTotaux,
    );
  });

  it("ANTI-MAQUILLAGE : C3 déclaré = comptage réel des gains > 1 dans parDomaine", () => {
    const c3 = artefact!.bilan.criteres.c3_gain_trace;
    const comptage = artefact!.parDomaine.filter((d) => d.gainTrace > 1).length;
    expect(c3.valeur).toBe(comptage);
    expect(c3.sur).toBe(19);
    // Le niveau requis (19/19) n'est PAS encore atteint : le garde refuse
    // tout artefact qui prétendrait le contraire.
    expect(c3.atteint).toBe(comptage === 19);
    expect(c3.atteint).toBe(false);
  });

  it("l'ordre des 19 domaines = charte du propriétaire (bandes valides)", () => {
    expect(artefact!.parDomaine.map((d) => d.id)).toEqual([...IDS_VOCATION]);
    for (const d of artefact!.parDomaine) {
      expect(d.bande).toBeGreaterThanOrEqual(0);
      expect(d.bande).toBeLessThan(8);
    }
  });

  it("honnêteté : les 4 limites sont présentes et les échecs C3 restent visibles", () => {
    const limites = artefact!.bilan.limitesHonnetes;
    expect(limites.length).toBe(4);
    const texte = limites.join(" ");
    expect(texte).toMatch(/PROTOCOLE identique/); // matière décalée 30M vs 10M
    expect(texte).toMatch(/interne du substrat/); // portée de la trace
    expect(texte).toMatch(/production reste 2\^20/); // runtime inchangé
    expect(texte).toMatch(/PONT VOCATION/); // rôles distincts
    // Les domaines en échec restent listés tels quels (zéro gonflage).
    const echecs = artefact!.parDomaine.filter((d) => d.gainTrace <= 1);
    expect(echecs.length).toBe(19 - artefact!.bilan.criteres.c3_gain_trace.valeur);
    expect(echecs.length).toBeGreaterThan(0);
  });
});
