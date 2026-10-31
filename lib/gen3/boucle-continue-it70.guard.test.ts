/**
 * GARDE 39ᵉ (it.70) — LA BOUCLE CONTINUE EST MESURÉE SUR LE SUBSTRAT
 * ÉLARGI ET L'ARTEFACT NE FAÇONNE RIEN.
 *
 * Demandes propriétaires : « un système qui va permettre à gen3 d'apprendre
 * du générateur de dataset, pour qu'il puisse toujours continuer à
 * s'améliorer en continu » (it.65) + « entraîne gen3 dans tous les
 * domaines… continue jusqu'à ce qu'il atteigne le niveau requis » +
 * « depuis tes propres serveurs locaux » (raffinée).
 *
 * La campagne it.70 exécute les DEUX candidats déclarés it.69 §9 :
 *  - §9.1 « boucle continue sur substrat élargi » : DEUX vagues successives
 *    de 1 900 000 échantillons QA frais (100 000/domaine × 19) sur le MÊME
 *    cortex 2^23 — vague 1 = rejeu EXACT it.69 (offset 30M, ancrage de
 *    reproductibilité inter-processus : le C3a doit retomber sur la valeur
 *    mesurée it.69), vague 2 = matière JAMAIS VUE (offset 50M) sur le
 *    substrat DÉJÀ ENTRAÎNÉ — le C3b mesure le gain marginal d'une vague
 *    neuve (la leçon it.68 « la matière fraîche est le levier » mise à
 *    l'épreuve de la CONTINUITÉ) et la SURVIE mesure si la mémoire de la
 *    vague 1 résiste à la vague 2 ;
 *  - §9.2 « comprendre les échecs résiduels » : cartographie réelle du
 *    partage de colonnes (autoPorteur, top-3 interférents par domaine,
 *    charge par bande vocabulaire) + traces PAR POINT de sonde.
 *
 * Verrous :
 *  1. SUBSTRAT : 2^23 colonnes réel (mémoire > 700 Mo), homéostasie ON,
 *     graine 20261101, horloge sonde lointaine 90e9 ;
 *  2. DEUX VAGUES : offsets 30M/50M DISJOINTS déclarés, 1 900 000
 *     échantillons chacune (19 × 100 000 comptés par domaine et par vague),
 *     renforts > 0 partout, horloges cohérentes (v1 = 5,7 M, v2 = 11,4 M) ;
 *  3. REPRODUCTIBILITÉ : C3a (sémantique it.66/69, baseline substrat neuf)
 *     déclaré = comptage réel des c3a > 1 et = 14/19 (valeur mesurée
 *     it.69) — le rejeu est réellement bit-exat ou le garde tombe ;
 *  4. BOUCLE CONTINUE : C3b déclaré = comptage réel des c3b > 1 (baseline
 *     après vague 1, sémantique documentée) ; SURVIE déclarée = comptage
 *     réel des survie > 1 — les trois re-dérivables des traces stockées
 *     (anti-maquillage) ;
 *  5. STABILITÉ : ratios C4 des DEUX vagues < 3 (deltas par bloc, leçon
 *     it.68/69), re-dérivables des blocs, aucun delta n'explose,
 *     normalisations > 0 (l'homéostasie a tiré) ;
 *  6. DIAGNOSTIC : 19 domaines cartographiés (autoPorteur ∈ [0,1], 3
 *     interférents chacun, les 5 échecs it.69 présents), charge par bande
 *     = 8 bandes, effectif total 19, traces PAR POINT présentes (38+38) ;
 *  7. HONNÊTETÉ : les 5 limites honnêtes présentes, ordre charte, échecs
 *     visibles (zéro gonflage).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { IDS_VOCATION } from "./vocation";

const CHEMIN = join(
  process.cwd(),
  "assets/neural-pretrained/boucle-continue-it70.json",
);

/** Les 5 échecs C3 mesurés it.69 (la carte du diagnostic doit les porter). */
const ECHECS_IT69 = [
  "recherche-web",
  "ingenierie-industrie",
  "agriculture-environnement",
  "transport-immobilier",
  "ia-specialisee-emergente",
] as const;

interface ArtefactIt70 {
  session: string;
  parametres: {
    colonnes: number;
    vagues: Array<{ vague: number; offsetBijection: number; fraisParDomaine: number; horloges: string }>;
    cyclesParEchantillon: number;
    graine: number;
    horloges: { sondesPhase1: number; vague2Depart: number; sondesPhase2: number };
    homoeostasie: boolean;
  };
  memoire: {
    apresAllocation: { rss: number };
    plafondRssMo: number;
    picRssMo: number;
  };
  entrainement: {
    vague1: { echantillons: number; horlogeFinale: number; dureeMs: number };
    vague2: { echantillons: number; horlogeFinale: number; dureeMs: number };
    metabolisme: { normalisations: number };
    mesuresStabilite: Array<{
      vague: number;
      bloc: number;
      transmissions: number;
      transmissionsCumul: number;
    }>;
  };
  bilan: {
    criteres: {
      c1_donnees_fraises: { vague1: { valeur: number; atteint: boolean }; vague2: { valeur: number; atteint: boolean }; atteint: boolean };
      c2_renforts_positifs: { vague1: { valeur: number; atteint: boolean }; vague2: { valeur: number; atteint: boolean }; atteint: boolean };
      c3a_reproduction_it69: { valeur: number; sur: number; attendu: number; reproduit: boolean; atteint: boolean };
      c3b_boucle_continue: { valeur: number; sur: number; atteint: boolean };
      survie_memoire: { valeur: number; sur: number; atteint: boolean };
      c4_stabilite: { ratioTransmissionsVague1: number; ratioTransmissionsVague2: number; seuil: number; normalisationsTotales: number; atteint: boolean };
    };
    limitesHonnetes: string[];
  };
  parDomaine: Array<{
    id: string;
    bandeVocab: number;
    echantillonsVague1: number;
    renfortsVague1: number;
    echantillonsVague2: number;
    renfortsVague2: number;
    traceScratchV1: number;
    traceApresVague1: number;
    c3a: number;
    c3aAtteint: boolean;
    traceAvantVague2: number;
    traceApresVague2: number;
    c3b: number;
    c3bAtteint: boolean;
    traceApresVague2SurVague1: number;
    survie: number;
    survieAtteint: boolean;
  }>;
  pointsDeSonde: {
    vague1: Array<{ domaine: string; indice: string; ratioScratch: number; ratioApresVague1: number; ratioApresVague2: number }>;
    vague2: Array<{ domaine: string; indice: string; ratioAvantVague2: number; ratioApresVague2: number }>;
  };
  diagnostic: {
    methode: string;
    parDomaine: Array<{ id: string; bandeVocab: number; autoPorteur: number; topInterferents: Array<{ id: string; part: number }> }>;
    chargeParBande: Array<{ bande: number; domaines: string[]; effectif: number }>;
  };
}

describe("garde 39ᵉ — boucle continue it.70", () => {
  const artefact = existsSync(CHEMIN)
    ? (JSON.parse(readFileSync(CHEMIN, "utf8")) as ArtefactIt70)
    : null;

  it("l'artefact existe et déclare la session it.70", () => {
    expect(artefact).not.toBeNull();
    expect(artefact!.session).toBe("campagne-boucle-continue-it70");
  });

  it("substrat 2^23 RÉEL (mémoire), homéostasie ON, graine comparable, HORLOGES MONOTONES", () => {
    const p = artefact!.parametres;
    expect(p.colonnes).toBe(8_388_608); // 2^23 — le substrat élargi it.69
    expect(p.homoeostasie).toBe(true); // it.67/68
    expect(p.graine).toBe(20261101); // comparabilité it.69
    // LEÇON it.70 (mesurée) : l'horloge doit rester MONOTONE à travers les
    // vagues ET les sondes — un pas à horloge antérieure aux sondes produit
    // des Δt négatifs (énergies infinies → avalanche non bornée).
    expect(p.horloges.sondesPhase1).toBe(90_000_000_000); // it.69 exact
    expect(p.horloges.vague2Depart).toBe(90_010_000_000); // APRÈS les sondes 1
    expect(p.horloges.sondesPhase2).toBe(90_030_000_000); // APRÈS la vague 2
    expect(p.horloges.vague2Depart).toBeGreaterThan(p.horloges.sondesPhase1);
    expect(p.horloges.sondesPhase2).toBeGreaterThan(p.horloges.vague2Depart);
    // La mémoire mesure la RÉALITÉ du substrat élargi (un artefact fabriqué
    // à 2^20 ne peut pas l'atteindre).
    expect(artefact!.memoire.apresAllocation.rss).toBeGreaterThan(700);
    expect(artefact!.memoire.picRssMo).toBeLessThan(artefact!.memoire.plafondRssMo);
  });

  it("deux vagues DISJOINTES : offsets 30M/50M, 1 900 000 échantillons chacune, horloges cohérentes", () => {
    const p = artefact!.parametres;
    expect(p.vagues).toHaveLength(2);
    const [v1, v2] = p.vagues;
    expect(v1!.offsetBijection).toBe(30_000_000); // rejeu exact it.69
    expect(v2!.offsetBijection).toBe(50_000_000); // jamais vue (10M+30M+40M < 50M)
    expect(v1!.fraisParDomaine).toBe(100_000);
    expect(v2!.fraisParDomaine).toBe(100_000);
    expect(artefact!.entrainement.vague1.echantillons).toBe(1_900_000);
    expect(artefact!.entrainement.vague2.echantillons).toBe(1_900_000);
    // Horloges : vague 1 = rejeu it.69 exact (3 × 1 900 000) ; la vague 2
    // part APRÈS les sondes de phase 1 (horloge MONOTONE, leçon it.70) et
    // ajoute 3 × 1 900 000.
    expect(artefact!.entrainement.vague1.horlogeFinale).toBe(5_700_000);
    expect(artefact!.entrainement.vague2.horlogeFinale).toBe(90_015_700_000);
    expect(artefact!.entrainement.vague2.horlogeFinale).toBeGreaterThan(
      artefact!.parametres.horloges.sondesPhase1,
    );
    expect(artefact!.entrainement.vague2.horlogeFinale).toBeLessThan(
      artefact!.parametres.horloges.sondesPhase2,
    );
    // Chaque domaine a RÉELLEMENT reçu ses 100 000 échantillons PAR VAGUE.
    const c1 = artefact!.bilan.criteres.c1_donnees_fraises;
    const c2 = artefact!.bilan.criteres.c2_renforts_positifs;
    expect(c1.vague1.valeur).toBe(19);
    expect(c1.vague2.valeur).toBe(19);
    expect(c1.atteint).toBe(true);
    expect(c2.vague1.valeur).toBe(19);
    expect(c2.vague2.valeur).toBe(19);
    expect(c2.atteint).toBe(true);
    for (const d of artefact!.parDomaine) {
      expect(d.echantillonsVague1).toBe(100_000);
      expect(d.echantillonsVague2).toBe(100_000);
      expect(d.renfortsVague1).toBeGreaterThan(0);
      expect(d.renfortsVague2).toBeGreaterThan(0);
    }
  });

  it("REPRODUCTIBILITÉ : C3a = comptage réel = 14/19 (rejeu bit-exact it.69)", () => {
    const c3a = artefact!.bilan.criteres.c3a_reproduction_it69;
    // Le déclaré = comptage RÉEL des c3a > 1 dans parDomaine (anti-maquillage).
    const comptage = artefact!.parDomaine.filter((d) => d.c3aAtteint).length;
    expect(c3a.valeur).toBe(comptage);
    // Re-dérivable des traces stockées : c3a = après vague 1 / scratch.
    for (const d of artefact!.parDomaine) {
      const derive = d.traceApresVague1 / Math.max(1e-12, d.traceScratchV1);
      expect(d.c3a).toBeCloseTo(derive, 1);
      expect(d.c3aAtteint).toBe(d.c3a > 1);
    }
    // L'ancrage : le rejeu doit retomber sur la valeur MESURÉE it.69 —
    // sinon la mécanique n'est pas déterministe et le garde tombe.
    expect(c3a.attendu).toBe(14);
    expect(c3a.reproduit).toBe(true);
    expect(c3a.valeur).toBe(14);
    // Le niveau requis n'est PAS prétendu atteint tant que la mesure dit
    // autre chose.
    expect(c3a.atteint).toBe(c3a.valeur === 19);
    expect(c3a.atteint).toBe(false);
  });

  it("BOUCLE CONTINUE : C3b et SURVIE = comptages réels, re-dérivables des traces", () => {
    const c3b = artefact!.bilan.criteres.c3b_boucle_continue;
    const survie = artefact!.bilan.criteres.survie_memoire;
    expect(c3b.valeur).toBe(artefact!.parDomaine.filter((d) => d.c3bAtteint).length);
    expect(survie.valeur).toBe(artefact!.parDomaine.filter((d) => d.survieAtteint).length);
    for (const d of artefact!.parDomaine) {
      // c3b = après vague 2 / avant vague 2 (baseline après vague 1).
      const deriveB = d.traceApresVague2 / Math.max(1e-12, d.traceAvantVague2);
      expect(d.c3b).toBeCloseTo(deriveB, 1);
      expect(d.c3bAtteint).toBe(d.c3b > 1);
      // survie = trace vague 1 après vague 2 / après vague 1.
      const deriveS = d.traceApresVague2SurVague1 / Math.max(1e-12, d.traceApresVague1);
      expect(d.survie).toBeCloseTo(deriveS, 1);
      expect(d.survieAtteint).toBe(d.survie > 1);
    }
    expect(c3b.sur).toBe(19);
    expect(c3b.atteint).toBe(c3b.valeur === 19);
    expect(survie.atteint).toBe(survie.valeur === 19);
  });

  it("stabilité : ratios C4 des DEUX vagues < 3, re-dérivables des blocs, aucun delta n'explose", () => {
    const c4 = artefact!.bilan.criteres.c4_stabilite;
    expect(c4.ratioTransmissionsVague1).toBeLessThan(3);
    expect(c4.ratioTransmissionsVague2).toBeLessThan(3);
    expect(c4.ratioTransmissionsVague1).toBeGreaterThan(0);
    expect(c4.ratioTransmissionsVague2).toBeGreaterThan(0);
    expect(c4.atteint).toBe(true);
    const blocs = artefact!.entrainement.mesuresStabilite;
    const blocsV1 = blocs.filter((b) => b.vague === 1);
    const blocsV2 = blocs.filter((b) => b.vague === 2);
    expect(blocsV1.length).toBeGreaterThanOrEqual(2);
    expect(blocsV2.length).toBeGreaterThanOrEqual(2);
    // Re-dérivation par vague (deltas par bloc, leçon it.68/69).
    const deriveV1 = blocsV1[blocsV1.length - 1]!.transmissions / blocsV1[0]!.transmissions;
    const deriveV2 = blocsV2[blocsV2.length - 1]!.transmissions / blocsV2[0]!.transmissions;
    expect(Math.round(deriveV1 * 1000) / 1000).toBeCloseTo(c4.ratioTransmissionsVague1, 1);
    expect(Math.round(deriveV2 * 1000) / 1000).toBeCloseTo(c4.ratioTransmissionsVague2, 1);
    // AUCUN delta de bloc n'explose (≤ 3 × le premier de sa vague).
    for (const b of blocsV1) expect(b.transmissions).toBeLessThan(blocsV1[0]!.transmissions * 3);
    for (const b of blocsV2) expect(b.transmissions).toBeLessThan(blocsV2[0]!.transmissions * 3);
    // L'homéostasie a réellement tiré sur les DEUX vagues.
    expect(artefact!.entrainement.metabolisme.normalisations).toBeGreaterThan(0);
    expect(c4.normalisationsTotales).toBe(artefact!.entrainement.metabolisme.normalisations);
  });

  it("traces PAR POINT : 38 points par vague, détail cohérent avec les moyennes", () => {
    const pts1 = artefact!.pointsDeSonde.vague1;
    const pts2 = artefact!.pointsDeSonde.vague2;
    expect(pts1).toHaveLength(38);
    expect(pts2).toHaveLength(38);
    // Chaque domaine a ses deux points (début et fin de sa matière).
    for (const id of IDS_VOCATION) {
      const dp1 = pts1.filter((p) => p.domaine === id);
      const dp2 = pts2.filter((p) => p.domaine === id);
      expect(dp1.map((p) => p.indice).sort()).toEqual(["debut", "fin"]);
      expect(dp2.map((p) => p.indice).sort()).toEqual(["debut", "fin"]);
    }
    // Le détail par point ne peut pas contredire la moyenne stockée :
    // la moyenne des ratios par point bornée par min/max de ses points
    // (moyenne de 2 valeurs ∈ [min, max]).
    for (const d of artefact!.parDomaine) {
      const dp1 = pts1.filter((p) => p.domaine === d.id);
      const ratios = dp1.map((p) => p.ratioApresVague1);
      expect(Math.max(...ratios)).toBeGreaterThanOrEqual(d.traceApresVague1 * 0.999999);
      expect(Math.min(...ratios)).toBeLessThanOrEqual(d.traceApresVague1 * 1.000001);
    }
  });

  it("diagnostic : 19 domaines cartographiés, les 5 échecs it.69 présents, charge par bande = 19", () => {
    const diag = artefact!.diagnostic;
    expect(diag.parDomaine).toHaveLength(19);
    expect(diag.parDomaine.map((d) => d.id)).toEqual([...IDS_VOCATION]);
    for (const d of diag.parDomaine) {
      expect(d.autoPorteur).toBeGreaterThanOrEqual(0);
      expect(d.autoPorteur).toBeLessThanOrEqual(1);
      expect(d.topInterferents).toHaveLength(3);
      for (const t of d.topInterferents) {
        expect(t.part).toBeGreaterThanOrEqual(0);
        expect(t.part).toBeLessThanOrEqual(1);
      }
    }
    // Les 5 échecs résiduels it.69 sont portés par la carte (candidats §9.2).
    const ids = new Set(diag.parDomaine.map((d) => d.id));
    for (const echec of ECHECS_IT69) expect(ids.has(echec)).toBe(true);
    // Charge par bande vocabulaire : 8 bandes, effectif total 19.
    expect(diag.chargeParBande).toHaveLength(8);
    const total = diag.chargeParBande.reduce((n, b) => n + b.effectif, 0);
    expect(total).toBe(19);
    const domainesBande = diag.chargeParBande.flatMap((b) => b.domaines);
    expect(domainesBande.sort()).toEqual([...IDS_VOCATION].sort());
  });

  it("l'ordre des 19 domaines = charte du propriétaire (bandes vocabulaires valides)", () => {
    expect(artefact!.parDomaine.map((d) => d.id)).toEqual([...IDS_VOCATION]);
    for (const d of artefact!.parDomaine) {
      expect(d.bandeVocab).toBeGreaterThanOrEqual(0);
      expect(d.bandeVocab).toBeLessThan(8);
    }
  });

  it("honnêteté : les 5 limites sont présentes, les échecs C3a/C3b restent visibles", () => {
    const limites = artefact!.bilan.limitesHonnetes;
    expect(limites.length).toBeGreaterThanOrEqual(4);
    const texte = limites.join(" ");
    expect(texte).toMatch(/DÉJÀ ENTRAÎNÉ/); // sémantique C3b documentée
    expect(texte).toMatch(/inter-processus/); // reproductibilité mesurée, pas supposée
    expect(texte).toMatch(/CORRÉLATION/); // portée du diagnostic
    expect(texte).toMatch(/interne du substrat/); // portée de la trace
    expect(texte).toMatch(/production reste 2\^20/); // runtime inchangé
    // Les échecs restent listés tels quels (zéro gonflage).
    const echecsA = artefact!.parDomaine.filter((d) => !d.c3aAtteint);
    const echecsB = artefact!.parDomaine.filter((d) => !d.c3bAtteint);
    expect(echecsA.length).toBe(19 - artefact!.bilan.criteres.c3a_reproduction_it69.valeur);
    expect(echecsB.length).toBe(19 - artefact!.bilan.criteres.c3b_boucle_continue.valeur);
  });
});
