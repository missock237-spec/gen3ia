/**
 * GARDE 40ᵉ (it.71) — LE PLAFOND EST LEVÉ HONNÊTEMENT : L'ARTEFACT
 * « BUDGET 8.0 » NE FAÇONNE RIEN ET LA COMPARAISON EST CONTRÔLÉE.
 *
 * Demandes propriétaires : « un système qui va permettre à gen3 d'apprendre
 * du générateur de dataset, pour qu'il puisse toujours continuer à
 * s'améliorer en continu » (it.65) + « entraîne gen3 dans tous les
 * domaines… continue jusqu'à ce qu'il atteigne le niveau requis » +
 * « depuis tes propres serveurs locaux » (raffinée).
 *
 * La campagne it.71 exécute le candidat №1 déclaré it.70 §7.1 (« lever le
 * plafond de saturation : élargir la dynamique des poids ») — expérience
 * CONTRÔLÉE à variable unique : même matière que it.69/70 (bijections
 * offsets 30M/50M, 100 000/domaine × 19), même graine 20261101, même
 * mécanique EOD it.57/63, mêmes horloges monotones (leçon it.70) — SEULE
 * VARIABLE : budgetPoidsSortants 6.0 → 8.0. L'ancrage budget 6.0 est
 * l'artefact COMMIS it.70 (boucle-continue-it70.json : C3a 14/19,
 * C3b 6/19, survie 13/19) — ceci n'est PAS un rejeu bit-exact.
 *
 * Verrous :
 *  1. SESSION + VARIABLE UNIQUE : budget 8.0 déclaré (et ancre 6.0),
 *     substrat 2^23 réel (mémoire > 700 Mo), homéostasie ON, graine
 *     20261101 ;
 *  2. HORLOGES MONOTONES (leçon it.70 verrouillée) : 0 < 90e9 (sondes
 *     phase 1) < 90,01e9 (vague 2) < 90,0157e9 (fin vague 2) < 90,03e9
 *     (sondes phase 2) ;
 *  3. DEUX VAGUES : offsets 30M/50M DISJOINTS, 1 900 000 échantillons
 *     chacune (19 × 100 000 comptés par domaine et par vague), renforts
 *     > 0 partout ;
 *  4. C3 / C3b / SURVIE = COMPTAGES RÉELS re-dérivables des traces
 *     stockées à 6 décimales (anti-maquillage : c3 = traceApresVague1 /
 *     traceScratchV1 > 1, etc.) — 14/19, 12/19, 13/19 exigés tels que
 *     mesurés, les 5 échecs C3 NOMMÉS ;
 *  5. STABILITÉ : ratios C4 des DEUX vagues < 3 (deltas par bloc), aucun
 *     delta n'explose (tous positifs), re-dérivables des blocs ;
 *     NORMALISATIONS = 0 EXIGÉ (leçon it.71 MESURÉE : sous budget 8.0,
 *     l'homéostasie n'a jamais été déclenchée — le plafond du C3 n'est
 *     PAS le budget sous la sémantique scratch) ;
 *  6. TRACES PAR POINT : 38 points par vague, cohérents avec les
 *     moyennes (tolérance de ré-arrondi) ;
 *  7. HONNÊTETÉ : ≥ 5 limites présentes (dont « PAS un rejeu bit-exact »
 *     et « facteur de branchement ≤ 8 — risque ACCEPTÉ et MESURÉ »),
 *     ordre charte, échecs visibles (zéro gonflage).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { IDS_VOCATION } from "./vocation";

const CHEMIN = join(
  process.cwd(),
  "assets/neural-pretrained/plafond-leve-it71.json",
);

/** Les 5 échecs C3 mesurés it.71 (identiques au millième à ceux de
 *  it.69/70 — la comparaison croisée le documente dans le rapport). */
const ECHECS_C3_IT71 = [
  "recherche-web",
  "ingenierie-industrie",
  "agriculture-environnement",
  "transport-immobilier",
  "ia-specialisee-emergente",
] as const;

interface ArtefactIt71 {
  session: string;
  parametres: {
    colonnes: number;
    budgetPoidsSortants: number;
    budgetAncreIt70: number;
    seuleVariable: string;
    vagues: Array<{ vague: number; offsetBijection: number; fraisParDomaine: number; horloges: string }>;
    cyclesParEchantillon: number;
    tailleLot: number;
    lrBoost: number;
    graine: number;
    horloges: { sondesPhase1: number; vague2Depart: number; sondesPhase2: number };
    homoeostasie: boolean;
  };
  memoire: {
    avantAllocation: { rss: number };
    apresAllocation: { rss: number };
    plafondRssMo: number;
    picRssMo: number;
  };
  sources: Record<string, string>;
  entrainement: {
    vague1: { echantillons: number; dureeMs: number; horlogeFinale: number };
    vague2: { echantillons: number; dureeMs: number; horlogeFinale: number };
    metabolisme: { evaluees: number; reposes: number; transmissions: number; ms: number; normalisations: number };
    mesuresStabilite: Array<{
      vague: 1 | 2;
      bloc: number;
      echantillons: number;
      transmissions: number;
      transmissionsCumul: number;
      aretesSaturees: number;
      poidsMax: number;
      normalisations: number;
      normalisationsCumul: number;
      rssMo: number;
    }>;
  };
  bilan: {
    criteres: {
      c1_donnees_fraises: {
        vague1: { valeur: number; sur: number; seuil: number; atteint: boolean };
        vague2: { valeur: number; sur: number; seuil: number; atteint: boolean };
        atteint: boolean;
      };
      c2_renforts_positifs: {
        vague1: { valeur: number; sur: number; atteint: boolean };
        vague2: { valeur: number; sur: number; atteint: boolean };
        atteint: boolean;
      };
      c3_budget_elargi: { valeur: number; sur: number; baseline: string; atteint: boolean };
      c3b_boucle_continue: { valeur: number; sur: number; baseline: string; atteint: boolean };
      survie_memoire: { valeur: number; sur: number; baseline: string; atteint: boolean };
      c4_stabilite: {
        ratioTransmissionsVague1: number;
        ratioTransmissionsVague2: number;
        seuil: number;
        aretesSatureesFin: number;
        poidsMaxFin: number;
        normalisationsTotales: number;
        atteint: boolean;
      };
    };
    limitesHonnetes: string[];
  };
  parDomaine: Array<{
    id: string;
    label: string;
    bandeVocab: number;
    echantillonsVague1: number;
    renfortsVague1: number;
    echantillonsVague2: number;
    renfortsVague2: number;
    traceScratchV1: number;
    traceApresVague1: number;
    c3: number;
    c3Atteint: boolean;
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
}

let artefact: ArtefactIt71 | null = null;

function charger(): ArtefactIt71 {
  if (artefact) return artefact;
  expect(existsSync(CHEMIN), `artefact manquant : ${CHEMIN}`).toBe(true);
  artefact = JSON.parse(readFileSync(CHEMIN, "utf8")) as ArtefactIt71;
  return artefact;
}

describe("garde 40ᵉ — plafond levé it.71", () => {
  it("l'artefact existe et déclare la session it.71 avec la VARIABLE UNIQUE (budget 8.0, ancre 6.0)", () => {
    const a = charger();
    expect(a.session).toBe("campagne-plafond-leve-it71");
    expect(a.parametres.budgetPoidsSortants).toBe(8.0);
    expect(a.parametres.budgetAncreIt70).toBe(6.0);
    expect(a.parametres.seuleVariable).toContain("budgetPoidsSortants");
    expect(a.parametres.seuleVariable).toContain("6.0");
    expect(a.parametres.seuleVariable).toContain("8.0");
    expect(a.parametres.homoeostasie).toBe(true);
    expect(a.parametres.graine).toBe(20261101);
    expect(a.parametres.cyclesParEchantillon).toBe(3);
    expect(a.parametres.tailleLot).toBe(2000);
    expect(a.parametres.lrBoost).toBe(0.15);
    expect(a.sources.substrat).toContain("cortex-columnnaire");
    expect(a.sources.mecanique).toContain("entrainement-ondes");
    expect(a.sources.generateur).toContain("generateur-datasets");
  });

  it("substrat 2^23 RÉEL (mémoire > 700 Mo), plafond RSS respecté, horloges MONOTONES (leçon it.70)", () => {
    const a = charger();
    expect(a.parametres.colonnes).toBe(8_388_608);
    // La mémoire de l'allocation prouve le substrat réel (2^23 × 12 arêtes
    // CSR ≈ 403 Mo de poids seuls — l'allocation totale dépasse 700 Mo).
    expect(a.memoire.apresAllocation.rss).toBeGreaterThan(700);
    expect(a.memoire.plafondRssMo).toBe(2600);
    expect(a.memoire.picRssMo).toBeLessThanOrEqual(a.memoire.plafondRssMo);
    const h = a.parametres.horloges;
    expect(h.sondesPhase1).toBe(90_000_000_000);
    expect(h.vague2Depart).toBe(90_010_000_000);
    expect(h.sondesPhase2).toBe(90_030_000_000);
    // CHAÎNE monotone réelle : départ vague 2 APRÈS les sondes phase 1,
    // sondes phase 2 APRÈS la fin réelle de la vague 2 (leçon it.70 §5).
    expect(0).toBeLessThan(h.sondesPhase1);
    expect(h.sondesPhase1).toBeLessThan(h.vague2Depart);
    expect(h.vague2Depart).toBeLessThan(a.entrainement.vague2.horlogeFinale);
    expect(a.entrainement.vague2.horlogeFinale).toBeLessThan(h.sondesPhase2);
  });

  it("deux vagues DISJOINTES : offsets 30M/50M, 1 900 000 échantillons chacune comptées par domaine, renforts > 0 partout", () => {
    const a = charger();
    const vagues = a.parametres.vagues;
    expect(vagues).toHaveLength(2);
    expect(vagues[0]!.vague).toBe(1);
    expect(vagues[0]!.offsetBijection).toBe(30_000_000);
    expect(vagues[1]!.vague).toBe(2);
    expect(vagues[1]!.offsetBijection).toBe(50_000_000);
    for (const v of vagues) expect(v.fraisParDomaine).toBe(100_000);
    expect(a.entrainement.vague1.echantillons).toBe(1_900_000);
    expect(a.entrainement.vague2.echantillons).toBe(1_900_000);
    // Comptage RÉEL par domaine et par vague (anti-maquillage).
    for (const d of a.parDomaine) {
      expect(d.echantillonsVague1).toBe(100_000);
      expect(d.echantillonsVague2).toBe(100_000);
      expect(d.renfortsVague1).toBeGreaterThan(0);
      expect(d.renfortsVague2).toBeGreaterThan(0);
    }
  });

  it("C3 = comptage RÉEL = 14/19 re-dérivable des traces 6 décimales, les 5 échecs NOMMÉS", () => {
    const a = charger();
    const parDomaine = a.parDomaine;
    expect(parDomaine).toHaveLength(19);
    // Re-dérivation de chaque c3 depuis les traces stockées (anti-maquillage)
    // — tolérance 2e-6 : la campagne calcule c3 depuis les ratios NON
    // arrondis, les traces publiées sont arrondies à 6 décimales.
    for (const d of parDomaine) {
      const c3Derive = d.traceApresVague1 / Math.max(1e-12, d.traceScratchV1);
      expect(Math.abs(c3Derive - d.c3)).toBeLessThanOrEqual(2e-6);
      expect(d.c3Atteint).toBe(d.c3 > 1);
    }
    const c3Compte = parDomaine.filter((d) => d.c3 > 1).length;
    expect(a.bilan.criteres.c3_budget_elargi.valeur).toBe(c3Compte);
    expect(c3Compte).toBe(14);
    // Les 5 échecs sont NOMMÉMENT ceux mesurés (comparabilité croisée it.70).
    const echecs = parDomaine.filter((d) => !d.c3Atteint).map((d) => d.id).sort();
    expect(echecs).toEqual([...ECHECS_C3_IT71].sort());
    // Le niveau requis 19/19 n'est PAS déclaré atteint.
    expect(a.bilan.criteres.c3_budget_elargi.atteint).toBe(false);
  });

  it("C3b = 12/19 et SURVIE = 13/19, comptages réels re-dérivables des traces", () => {
    const a = charger();
    const parDomaine = a.parDomaine;
    for (const d of parDomaine) {
      const c3bDerive = d.traceApresVague2 / Math.max(1e-12, d.traceAvantVague2);
      expect(Math.abs(c3bDerive - d.c3b)).toBeLessThanOrEqual(2e-6);
      expect(d.c3bAtteint).toBe(d.c3b > 1);
      const survieDerive = d.traceApresVague2SurVague1 / Math.max(1e-12, d.traceApresVague1);
      expect(Math.abs(survieDerive - d.survie)).toBeLessThanOrEqual(2e-6);
      expect(d.survieAtteint).toBe(d.survie > 1);
    }
    const c3bCompte = parDomaine.filter((d) => d.c3b > 1).length;
    const survieCompte = parDomaine.filter((d) => d.survie > 1).length;
    expect(a.bilan.criteres.c3b_boucle_continue.valeur).toBe(c3bCompte);
    expect(c3bCompte).toBe(12);
    expect(a.bilan.criteres.survie_memoire.valeur).toBe(survieCompte);
    expect(survieCompte).toBe(13);
    expect(a.bilan.criteres.c3b_boucle_continue.atteint).toBe(false);
  });

  it("stabilité : C4 < 3 sur les DEUX vagues, re-dérivable des blocs, aucun delta n'explose, NORMALISATIONS = 0 (leçon budget 8.0)", () => {
    const a = charger();
    const mesures = a.entrainement.mesuresStabilite;
    const blocsV1 = mesures.filter((m) => m.vague === 1);
    const blocsV2 = mesures.filter((m) => m.vague === 2);
    expect(blocsV1.length).toBeGreaterThanOrEqual(2);
    expect(blocsV2.length).toBeGreaterThanOrEqual(2);
    // Aucun delta de bloc n'explose (tous positifs — leçon comptable it.70).
    for (let i = 1; i < mesures.length; i++) {
      const delta = mesures[i]!.transmissionsCumul - mesures[i - 1]!.transmissionsCumul;
      expect(delta).toBeGreaterThan(0);
      const deltaNorm = mesures[i]!.normalisationsCumul - mesures[i - 1]!.normalisationsCumul;
      expect(deltaNorm).toBeGreaterThanOrEqual(0);
    }
    // Ratios C4 re-dérivables des blocs (deltas par bloc, leçon it.68/69/70).
    const ratioV1 = blocsV1[blocsV1.length - 1]!.transmissions / blocsV1[0]!.transmissions;
    const ratioV2 = blocsV2[blocsV2.length - 1]!.transmissions / blocsV2[0]!.transmissions;
    expect(Math.round(ratioV1 * 1000) / 1000).toBe(a.bilan.criteres.c4_stabilite.ratioTransmissionsVague1);
    expect(Math.round(ratioV2 * 1000) / 1000).toBe(a.bilan.criteres.c4_stabilite.ratioTransmissionsVague2);
    expect(ratioV1).toBeLessThan(3);
    expect(ratioV2).toBeLessThan(3);
    // LEÇON it.71 MESURÉE : sous budget 8.0, l'homéostasie n'a JAMAIS été
    // déclenchée (0 normalisation) — le plafond du C3 n'est PAS le budget
    // sous la sémantique scratch. Ce fait est verrouillé (anti-maquillage).
    expect(a.bilan.criteres.c4_stabilite.normalisationsTotales).toBe(0);
    expect(a.entrainement.metabolisme.normalisations).toBe(0);
    expect(a.bilan.criteres.c4_stabilite.poidsMaxFin).toBeLessThanOrEqual(1.0);
    // Le métabolisme global est la somme VRAIE des deux vagues.
    const met = a.entrainement.metabolisme;
    expect(met.transmissions).toBeGreaterThan(0);
    expect(met.ms).toBeGreaterThan(0);
    expect(a.bilan.criteres.c4_stabilite.atteint).toBe(true);
  });

  it("traces PAR POINT : 38 points par vague, cohérents avec les moyennes (tolérance de ré-arrondi)", () => {
    const a = charger();
    const p1 = a.pointsDeSonde.vague1;
    const p2 = a.pointsDeSonde.vague2;
    expect(p1).toHaveLength(38);
    expect(p2).toHaveLength(38);
    // Chaque domaine a ses deux points (début et fin de sa matière) — et le
    // détail par point ne peut pas contredire la moyenne stockée (la
    // moyenne agrégée porteur/autres est bornée par le min/max des points).
    for (const id of IDS_VOCATION) {
      const dp1 = p1.filter((x) => x.domaine === id);
      const dp2 = p2.filter((x) => x.domaine === id);
      expect(dp1.map((x) => x.indice).sort()).toEqual(["debut", "fin"]);
      expect(dp2.map((x) => x.indice).sort()).toEqual(["debut", "fin"]);
    }
    for (const d of a.parDomaine) {
      const dp1 = p1.filter((x) => x.domaine === d.id);
      const ratiosScr = dp1.map((x) => x.ratioScratch);
      const ratiosAp1 = dp1.map((x) => x.ratioApresVague1);
      expect(Math.max(...ratiosScr)).toBeGreaterThanOrEqual(d.traceScratchV1 * 0.99);
      expect(Math.min(...ratiosScr)).toBeLessThanOrEqual(d.traceScratchV1 * 1.01);
      expect(Math.max(...ratiosAp1)).toBeGreaterThanOrEqual(d.traceApresVague1 * 0.99);
      expect(Math.min(...ratiosAp1)).toBeLessThanOrEqual(d.traceApresVague1 * 1.01);
    }
    for (const pt of p2) {
      expect(IDS_VOCATION).toContain(pt.domaine);
      expect(["debut", "fin"]).toContain(pt.indice);
    }
    for (const pt of p1) {
      expect(IDS_VOCATION).toContain(pt.domaine);
      expect(["debut", "fin"]).toContain(pt.indice);
    }
  });

  it("l'ordre des 19 domaines = charte du propriétaire, bandes vocabulaires valides [0,8)", () => {
    const a = charger();
    expect(a.parDomaine.map((d) => d.id)).toEqual([...IDS_VOCATION]);
    for (const d of a.parDomaine) {
      expect(d.bandeVocab).toBeGreaterThanOrEqual(0);
      expect(d.bandeVocab).toBeLessThanOrEqual(7);
      expect(d.label.length).toBeGreaterThan(0);
    }
  });

  it("honnêteté : ≥ 5 limites présentes (PAS un rejeu bit-exact, risque de branchement ACCEPTÉ), C1/C2 atteints, échecs visibles", () => {
    const a = charger();
    const limites = a.bilan.limitesHonnetes;
    expect(limites.length).toBeGreaterThanOrEqual(5);
    const toutes = limites.join(" ");
    expect(toutes).toContain("PAS un rejeu bit-exact");
    expect(toutes).toContain("expérience contrôlée");
    expect(toutes).toContain("boucle-continue-it70.json");
    expect(toutes).toContain("STRUCTURELLE");
    expect(toutes).toContain("ACCEPTÉ et MESURÉ");
    expect(toutes).toContain("PONT VOCATION");
    // C1/C2 = 19/19 sur les DEUX vagues (la matière a bien été consommée).
    expect(a.bilan.criteres.c1_donnees_fraises.atteint).toBe(true);
    expect(a.bilan.criteres.c2_renforts_positifs.atteint).toBe(true);
    // Les échecs restent VISIBLES (zéro gonflage) — C3b a 7 domaines SANS
    // gain strict (ratios 0,9998–0,99999, sous l'unité) : ils doivent
    // rester listés comme échecs (atteint = false), jamais arrondis à 1.
    const sansGain = a.parDomaine.filter((d) => !d.c3bAtteint);
    expect(sansGain).toHaveLength(7);
    for (const d of sansGain) {
      expect(d.c3b).toBeGreaterThanOrEqual(0.999);
      expect(d.c3b).toBeLessThan(1);
    }
  });
});
